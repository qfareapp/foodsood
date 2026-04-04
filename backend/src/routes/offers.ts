import { Router } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { AuthRequest, requireAuth } from '../middleware/auth';

const router = Router();
const HOLD_MINUTES = 10;

const OFFER_STATUSES = ['PENDING', 'COUNTERED', 'HOLD', 'PAID', 'REJECTED', 'EXPIRED'] as const;
type OfferStatus = typeof OFFER_STATUSES[number];
const DIRECT_ORDER_STATUSES = ['CONFIRMED', 'OUT_FOR_DELIVERY', 'DELIVERED'] as const;

const createOfferSchema = z.object({
  dishId: z.string().min(1),
  chefId: z.string().min(1),
  buyerName: z.string().min(1).max(120),
  buyerToken: z.string().uuid(),
  plates: z.number().int().min(1).max(500),
  offerPrice: z.number().int().min(1).max(100000),
  message: z.string().max(500).optional(),
});

const buyerCounterSchema = z.object({
  buyerToken: z.string().uuid(),
  newPrice: z.number().int().min(1).max(100000),
});

const counterSchema = z.object({
  counterPrice: z.number().int().min(1).max(100000),
  counterNote: z.string().max(500).optional(),
});

const paySchema = z.object({
  buyerToken: z.string().uuid(),
  deliveryMode: z.enum(['pickup', 'delivery']),
  paymentMethod: z.string().max(40).optional(),
});

const reviewSchema = z.object({
  buyerToken: z.string().uuid(),
  rating: z.number().int().min(1).max(5).optional(),
  comment: z.string().max(500).optional(),
});

const parseStatuses = (rawStatuses: unknown): OfferStatus[] => {
  if (typeof rawStatuses !== 'string') return [];
  return rawStatuses
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is OfferStatus => OFFER_STATUSES.includes(s as OfferStatus));
};

async function expireHeldOffers() {
  await prisma.dishOffer.updateMany({
    where: {
      status: 'HOLD',
      holdUntil: { lt: new Date() },
    },
    data: {
      status: 'EXPIRED',
    },
  });
}

async function getReservedPlates(dishId: string) {
  const reserved = await prisma.dishOffer.findMany({
    where: {
      dishId,
      OR: [
        { status: 'PAID' },
        { status: 'HOLD', holdUntil: { gt: new Date() } },
      ],
    },
    select: { plates: true },
  });

  return reserved.reduce((sum, offer) => sum + offer.plates, 0);
}

function holdExpiry() {
  return new Date(Date.now() + HOLD_MINUTES * 60 * 1000);
}

type SpecialityDishReview = {
  buyerName: string;
  rating: number;
  comment?: string;
  createdAt: string;
};

type SpecialityDishRecord = {
  dishName: string;
  description: string;
  imageUrl: string;
  lastSoldPrice: number;
  unitsSold: number;
  cuisine: string;
  tags: string[];
  notes: string;
  emoji: string;
  portionType: 'quantity' | 'pieces';
  portionValue: number;
  portionUnit: string;
  readyInMinutes: number;
  ratingAverage?: number;
  ratingCount?: number;
  recentReviews?: SpecialityDishReview[];
};

function normaliseDishKey(name: string) {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

async function appendDishReviewToChefSpeciality(offer: {
  chefId: string;
  dishName: string;
  buyerName: string;
}, review: { rating: number; comment?: string }) {
  const chef = await prisma.user.findUnique({
    where: { id: offer.chefId },
    select: { specialityDishes: true, rating: true, ratingCount: true },
  });
  if (!chef) return;

  const currentSpecialities = chef.specialityDishes ? JSON.parse(chef.specialityDishes) as SpecialityDishRecord[] : [];
  const nextSpecialities = currentSpecialities.map((item) => {
    if (normaliseDishKey(item.dishName) !== normaliseDishKey(offer.dishName)) return item;
    const nextCount = (item.ratingCount ?? 0) + 1;
    const nextAverage = (((item.ratingAverage ?? 0) * (item.ratingCount ?? 0)) + review.rating) / nextCount;
    const recentReviews = [
      { buyerName: offer.buyerName, rating: review.rating, comment: review.comment, createdAt: new Date().toISOString() },
      ...(item.recentReviews ?? []),
    ].slice(0, 5);
    return {
      ...item,
      ratingCount: nextCount,
      ratingAverage: Math.round(nextAverage * 10) / 10,
      recentReviews,
    };
  });

  const overallCount = chef.ratingCount + 1;
  const overallAverage = ((chef.rating * chef.ratingCount) + review.rating) / overallCount;

  await prisma.user.update({
    where: { id: offer.chefId },
    data: {
      specialityDishes: JSON.stringify(nextSpecialities),
      rating: Math.round(overallAverage * 10) / 10,
      ratingCount: overallCount,
    },
  });
}

router.post('/', async (req, res) => {
  await expireHeldOffers();

  const parsed = createOfferSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { dishId, chefId, buyerName, buyerToken, plates, offerPrice, message } = parsed.data;
  const dish = await prisma.chefDish.findUnique({ where: { id: dishId } });

  if (!dish) { res.status(404).json({ error: 'Dish not found' }); return; }
  if (dish.chefId !== chefId) { res.status(400).json({ error: 'Chef/dish mismatch' }); return; }

  const reservedPlates = await getReservedPlates(dishId);
  const availablePlates = Math.max(0, dish.plates - reservedPlates);
  if (plates > availablePlates) {
    res.status(409).json({ error: `Only ${availablePlates} plate${availablePlates === 1 ? '' : 's'} available right now` });
    return;
  }

  const offer = await prisma.dishOffer.create({
    data: {
      dishId,
      chefId,
      buyerName,
      buyerToken,
      plates,
      offerPrice,
      exactPriceRequested: offerPrice === dish.pricePerPlate,
      message,
      dishName: dish.dishName,
      dishEmoji: dish.emoji,
      status: 'PENDING',
      agreedPrice: null,
      holdUntil: null,
      lastOfferBy: 'BUYER',
    },
  });

  res.status(201).json(offer);
});

router.get('/buyer', async (req, res) => {
  await expireHeldOffers();

  const token = Array.isArray(req.query.token) ? req.query.token[0] : req.query.token as string;
  if (!token) { res.status(400).json({ error: 'token required' }); return; }

  const offers = await prisma.dishOffer.findMany({
    where: { buyerToken: token },
    orderBy: { updatedAt: 'desc' },
  });

  res.json(offers);
});

router.patch('/:id/buyer-counter', async (req, res) => {
  await expireHeldOffers();

  const offerId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const parsed = buyerCounterSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  const offer = await prisma.dishOffer.findUnique({ where: { id: offerId } });
  if (!offer) { res.status(404).json({ error: 'Offer not found' }); return; }
  if (offer.buyerToken !== parsed.data.buyerToken) { res.status(403).json({ error: 'Forbidden' }); return; }
  if (offer.status !== 'COUNTERED') { res.status(400).json({ error: 'No counter to respond to' }); return; }
  if (offer.counterPrice != null && parsed.data.newPrice >= offer.counterPrice) {
    res.status(400).json({ error: `Counter must be below ₹${offer.counterPrice}` }); return;
  }

  const updated = await prisma.dishOffer.update({
    where: { id: offerId },
    data: {
      offerPrice: parsed.data.newPrice,
      status: 'PENDING',
      lastOfferBy: 'BUYER',
    },
  });
  res.json(updated);
});

router.patch('/:id/buyer-accept', async (req, res) => {
  await expireHeldOffers();

  const offerId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const { buyerToken } = req.body as { buyerToken?: string };
  if (!buyerToken) { res.status(400).json({ error: 'buyerToken required' }); return; }

  const offer = await prisma.dishOffer.findUnique({ where: { id: offerId } });
  if (!offer) { res.status(404).json({ error: 'Offer not found' }); return; }
  if (offer.buyerToken !== buyerToken) { res.status(403).json({ error: 'Forbidden' }); return; }
  if (offer.status !== 'COUNTERED') { res.status(400).json({ error: 'No counter to accept' }); return; }

  const updated = await prisma.dishOffer.update({
    where: { id: offerId },
    data: {
      status: 'HOLD',
      agreedPrice: offer.counterPrice ?? offer.offerPrice,
      holdUntil: holdExpiry(),
      lastOfferBy: 'CHEF',
    },
  });
  res.json(updated);
});

router.patch('/:id/buyer-reject', async (req, res) => {
  await expireHeldOffers();

  const offerId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const { buyerToken } = req.body as { buyerToken?: string };
  if (!buyerToken) { res.status(400).json({ error: 'buyerToken required' }); return; }

  const offer = await prisma.dishOffer.findUnique({ where: { id: offerId } });
  if (!offer) { res.status(404).json({ error: 'Offer not found' }); return; }
  if (offer.buyerToken !== buyerToken) { res.status(403).json({ error: 'Forbidden' }); return; }
  if (offer.status !== 'COUNTERED') { res.status(400).json({ error: 'No counter to reject' }); return; }

  const updated = await prisma.dishOffer.update({
    where: { id: offerId },
    data: { status: 'REJECTED' },
  });
  res.json(updated);
});

router.post('/:id/pay', async (req, res) => {
  await expireHeldOffers();

  const offerId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const parsed = paySchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  const offer = await prisma.dishOffer.findUnique({ where: { id: offerId } });
  if (!offer) { res.status(404).json({ error: 'Offer not found' }); return; }
  if (offer.buyerToken !== parsed.data.buyerToken) { res.status(403).json({ error: 'Forbidden' }); return; }
  if (offer.status !== 'HOLD') { res.status(409).json({ error: 'Offer is not awaiting payment' }); return; }
  if (!offer.holdUntil || offer.holdUntil.getTime() <= Date.now()) {
    await prisma.dishOffer.update({
      where: { id: offer.id },
      data: { status: 'EXPIRED' },
    });
    res.status(409).json({ error: 'Payment window expired' });
    return;
  }

  const paymentRef = `DEMO-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  const updated = await prisma.dishOffer.update({
    where: { id: offer.id },
    data: {
      status: 'PAID',
      paidAt: new Date(),
      paymentRef,
      deliveryMode: parsed.data.deliveryMode,
      orderStatus: 'CONFIRMED',
    },
  });

  await prisma.user.update({
    where: { id: offer.chefId },
    data: { totalOrders: { increment: 1 } },
  });

  res.json(updated);
});

router.patch('/:id/order-status', requireAuth, async (req: AuthRequest, res) => {
  const offerId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const schema = z.object({ status: z.enum(DIRECT_ORDER_STATUSES) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const offer = await prisma.dishOffer.findUnique({ where: { id: offerId } });
  if (!offer) {
    res.status(404).json({ error: 'Offer not found' });
    return;
  }
  if (offer.chefId !== req.user!.userId) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  if (offer.status !== 'PAID') {
    res.status(409).json({ error: 'Only paid offers can be updated as orders' });
    return;
  }

  const currentStatus = offer.orderStatus ?? 'CONFIRMED';
  const allowed = offer.deliveryMode === 'delivery'
    ? (currentStatus === 'CONFIRMED' ? ['OUT_FOR_DELIVERY'] : currentStatus === 'OUT_FOR_DELIVERY' ? ['DELIVERED'] : [])
    : (currentStatus === 'CONFIRMED' ? ['DELIVERED'] : []);

  if (!allowed.includes(parsed.data.status)) {
    res.status(409).json({ error: `Cannot transition from ${currentStatus} to ${parsed.data.status}`, allowed });
    return;
  }

  const updated = await prisma.dishOffer.update({
    where: { id: offerId },
    data: { orderStatus: parsed.data.status },
  });

  res.json(updated);
});

router.post('/:id/review', async (req, res) => {
  const offerId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const parsed = reviewSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  if (!parsed.data.rating && !parsed.data.comment?.trim()) {
    res.status(400).json({ error: 'Provide a rating, review text, or both' });
    return;
  }

  const offer = await prisma.dishOffer.findUnique({ where: { id: offerId } });
  if (!offer) {
    res.status(404).json({ error: 'Offer not found' });
    return;
  }
  if (offer.buyerToken !== parsed.data.buyerToken) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  if (offer.status !== 'PAID' || offer.orderStatus !== 'DELIVERED') {
    res.status(409).json({ error: 'Can only review delivered paid orders' });
    return;
  }
  if (offer.reviewedAt) {
    res.status(409).json({ error: 'Review already submitted for this order' });
    return;
  }

  const updated = await prisma.dishOffer.update({
    where: { id: offerId },
    data: {
      reviewRating: parsed.data.rating ?? null,
      reviewComment: parsed.data.comment?.trim() || null,
      reviewedAt: new Date(),
    },
  });

  if (parsed.data.rating) {
    await appendDishReviewToChefSpeciality(offer, {
      rating: parsed.data.rating,
      comment: parsed.data.comment?.trim() || undefined,
    });
  }

  res.json(updated);
});

router.get('/', requireAuth, async (req: AuthRequest, res) => {
  await expireHeldOffers();

  const { role, userId } = req.user!;
  if (role !== 'CHEF' && role !== 'BOTH') {
    res.status(403).json({ error: 'Chef role required' });
    return;
  }

  const rawStatuses = Array.isArray(req.query.statuses) ? req.query.statuses[0] : req.query.statuses;
  const statuses = parseStatuses(rawStatuses);
  const finalStatuses = statuses.length > 0 ? statuses : ['PENDING', 'COUNTERED'];

  const offers = await prisma.dishOffer.findMany({
    where: { chefId: userId, status: { in: finalStatuses } },
    orderBy: { createdAt: 'desc' },
  });

  res.json(offers);
});

router.patch('/:id/accept', requireAuth, async (req: AuthRequest, res) => {
  await expireHeldOffers();

  const offerId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const offer = await prisma.dishOffer.findUnique({ where: { id: offerId } });
  if (!offer) { res.status(404).json({ error: 'Offer not found' }); return; }
  if (offer.chefId !== req.user!.userId) { res.status(403).json({ error: 'Forbidden' }); return; }
  if (offer.status !== 'PENDING') { res.status(409).json({ error: 'Offer is not in an acceptable state' }); return; }

  const updated = await prisma.dishOffer.update({
    where: { id: offer.id },
    data: {
      status: 'HOLD',
      agreedPrice: offer.offerPrice,
      holdUntil: holdExpiry(),
      lastOfferBy: 'BUYER',
    },
  });
  res.json(updated);
});

router.patch('/:id/reject', requireAuth, async (req: AuthRequest, res) => {
  await expireHeldOffers();

  const offerId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const offer = await prisma.dishOffer.findUnique({ where: { id: offerId } });
  if (!offer) { res.status(404).json({ error: 'Offer not found' }); return; }
  if (offer.chefId !== req.user!.userId) { res.status(403).json({ error: 'Forbidden' }); return; }

  const updated = await prisma.dishOffer.update({
    where: { id: offer.id },
    data: { status: 'REJECTED' },
  });
  res.json(updated);
});

router.patch('/:id/counter', requireAuth, async (req: AuthRequest, res) => {
  await expireHeldOffers();

  const offerId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const offer = await prisma.dishOffer.findUnique({ where: { id: offerId } });
  if (!offer) { res.status(404).json({ error: 'Offer not found' }); return; }
  if (offer.chefId !== req.user!.userId) { res.status(403).json({ error: 'Forbidden' }); return; }

  const parsed = counterSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  if (offer.counterPrice != null && parsed.data.counterPrice >= offer.counterPrice) {
    res.status(400).json({ error: `Counter must be below ₹${offer.counterPrice}` }); return;
  }

  const updated = await prisma.dishOffer.update({
    where: { id: offer.id },
    data: {
      status: 'COUNTERED',
      counterPrice: parsed.data.counterPrice,
      counterNote: parsed.data.counterNote ?? null,
      lastOfferBy: 'CHEF',
    },
  });
  res.json(updated);
});

export default router;
