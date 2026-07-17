import { Router } from 'express';
import { z } from 'zod';
import { haversineKm } from '../lib/geo';
import { getBlockedUserIds } from '../lib/moderation';
import { uploadBase64Image } from '../lib/cloudinary';
import prisma from '../lib/prisma';
import { AuthRequest, optionalAuth, requireAuth } from '../middleware/auth';

const router = Router();

const dishSchema = z.object({
  emoji: z.string().min(1).max(8),
  dishName: z.string().min(1).max(120),
  cuisine: z.string().min(1).max(80),
  tags: z.array(z.string().min(1).max(40)).max(20).default([]),
  pricePerPlate: z.number().int().min(1).max(100000),
  plates: z.number().int().min(1).max(500),
  portionType: z.enum(['quantity', 'pieces']),
  portionValue: z.number().int().min(1).max(100000),
  portionUnit: z.string().min(1).max(20),
  readyInMinutes: z.number().int().min(0).max(120),
  imageUrl: z.string().url().optional().nullable(),
  notes: z.string().max(500).optional(),
});

function serializeDish(
  dish: {
    id: string;
    emoji: string;
    dishName: string;
    cuisine: string;
    tags: string;
    pricePerPlate: number;
    plates: number;
    portionType: string;
    portionValue: number;
    portionUnit: string;
    readyInMinutes: number;
    notes: string | null;
    imageUrl: string | null;
    restockedAt?: Date | null;
    createdAt: Date;
    updatedAt: Date;
    chef?: {
      id: string;
      name: string;
      avatar: string | null;
      city: string | null;
      location: string | null;
      rating: number;
      ratingCount: number;
      totalOrders: number;
      specialityDishes?: string | null;
      lat: number | null;
      lng: number | null;
    };
  },
  viewerCoords?: { lat: number; lng: number } | null,
  bookedPlates = 0,
) {
  const readyAt = new Date(dish.createdAt.getTime() + dish.readyInMinutes * 60000);
  const remainingMinutes = Math.max(0, Math.ceil((readyAt.getTime() - Date.now()) / 60000));
  const distanceKm = viewerCoords && dish.chef?.lat != null && dish.chef?.lng != null
    ? Math.round(haversineKm(viewerCoords.lat, viewerCoords.lng, dish.chef.lat, dish.chef.lng) * 10) / 10
    : null;
  const specialityDishes = dish.chef?.specialityDishes ? JSON.parse(dish.chef.specialityDishes) as Array<{
    dishName: string;
    ratingAverage?: number;
    ratingCount?: number;
  }> : [];
  const dishReview = specialityDishes.find((item) => item.dishName.trim().replace(/\s+/g, ' ').toLowerCase() === dish.dishName.trim().replace(/\s+/g, ' ').toLowerCase());

  return {
    ...dish,
    tags: JSON.parse(dish.tags) as string[],
    plates: Math.max(0, dish.plates - bookedPlates),
    bookedPlates,
    status: dish.imageUrl ? 'ready' : 'cooking',
    remainingMinutes,
    readyAt: readyAt.toISOString(),
    distanceKm,
    dishRatingAverage: dishReview?.ratingAverage ?? 0,
    dishRatingCount: dishReview?.ratingCount ?? 0,
  };
}

// A dish's plate count "resets" whenever the chef restocks it (goes live
// again with a fresh quantity) — offers placed before that restock no
// longer count against the new capacity.
function computeBookedByDish(
  dishes: Array<{ id: string; restockedAt: Date | null }>,
  offers: Array<{ dishId: string; plates: number; createdAt: Date }>,
): Record<string, number> {
  const cutoffByDish = new Map(dishes.map((dish) => [dish.id, dish.restockedAt]));
  return offers.reduce<Record<string, number>>((acc, offer) => {
    const cutoff = cutoffByDish.get(offer.dishId);
    if (cutoff && offer.createdAt < cutoff) return acc;
    acc[offer.dishId] = (acc[offer.dishId] ?? 0) + offer.plates;
    return acc;
  }, {});
}

router.get('/', optionalAuth, async (req: AuthRequest, res) => {
  const { lat, lng, radiusKm = '5', limit = '30' } = req.query as Record<string, string>;
  const viewerLat = lat ? parseFloat(lat) : null;
  const viewerLng = lng ? parseFloat(lng) : null;
  const radius = parseFloat(radiusKm) || 5;
  const take = Math.min(parseInt(limit, 10) || 30, 100);

  const dishes = await prisma.chefDish.findMany({
    include: {
      chef: {
        select: {
          id: true,
          name: true,
          avatar: true,
          city: true,
          location: true,
          rating: true,
          ratingCount: true,
          totalOrders: true,
          specialityDishes: true,
          lat: true,
          lng: true,
          isActive: true,
          role: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    take,
  });
  const dishIds = dishes.map((dish) => dish.id);
  const activeOffers = dishIds.length > 0 ? await prisma.dishOffer.findMany({
    where: {
      dishId: { in: dishIds },
      OR: [
        { status: 'PAID' },
        { status: 'HOLD', holdUntil: { gt: new Date() } },
      ],
    },
    select: { dishId: true, plates: true, createdAt: true },
  }) : [];
  const bookedByDish = computeBookedByDish(dishes, activeOffers);

  const viewerCoords = viewerLat != null && viewerLng != null ? { lat: viewerLat, lng: viewerLng } : null;

  const blockedIds = req.user?.userId ? await getBlockedUserIds(req.user.userId) : [];
  const results = dishes
    .filter((dish) => dish.chef.isActive && (dish.chef.role === 'CHEF' || dish.chef.role === 'BOTH'))
    .filter((dish) => !blockedIds.includes(dish.chef.id))
    .map((dish) => serializeDish(dish, viewerCoords, bookedByDish[dish.id] ?? 0))
    .filter((dish) => dish.plates > 0)
    .filter((dish) => {
      if (!viewerCoords || dish.distanceKm == null) return true;
      return dish.distanceKm <= radius;
    });

  res.json(results);
});

router.get('/mine', requireAuth, async (req: AuthRequest, res) => {
  const { role, userId } = req.user!;
  if (role !== 'CHEF' && role !== 'BOTH') {
    res.status(403).json({ error: 'Chef role required' });
    return;
  }

  const dishes = await prisma.chefDish.findMany({
    where: { chefId: userId },
    orderBy: { updatedAt: 'desc' },
  });
  const dishIds = dishes.map((dish) => dish.id);
  const activeOffers = dishIds.length > 0 ? await prisma.dishOffer.findMany({
    where: {
      dishId: { in: dishIds },
      OR: [
        { status: 'PAID' },
        { status: 'HOLD', holdUntil: { gt: new Date() } },
      ],
    },
    select: { dishId: true, plates: true, createdAt: true },
  }) : [];
  const bookedByDish = computeBookedByDish(dishes, activeOffers);

  // Auto-offline: a live dish that's sold out of plates drops off the board
  // and its listed quantity resets to 0, until the chef manually goes live
  // again with a fresh plate count (+ timer + photo).
  const soldOutIds = dishes
    .filter((dish) => dish.imageUrl && Math.max(0, dish.plates - (bookedByDish[dish.id] ?? 0)) <= 0)
    .map((dish) => dish.id);
  if (soldOutIds.length > 0) {
    await prisma.chefDish.updateMany({
      where: { id: { in: soldOutIds } },
      data: { imageUrl: null, plates: 0 },
    });
  }
  const soldOutSet = new Set(soldOutIds);

  res.json(dishes.map((dish) => serializeDish(
    soldOutSet.has(dish.id) ? { ...dish, imageUrl: null, plates: 0 } : dish,
    undefined,
    bookedByDish[dish.id] ?? 0,
  )));
});

router.post('/', requireAuth, async (req: AuthRequest, res) => {
  const { role, userId } = req.user!;
  if (role !== 'CHEF' && role !== 'BOTH') {
    res.status(403).json({ error: 'Chef role required' });
    return;
  }

  const parsed = dishSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { tags, ...rest } = parsed.data;
  const dish = await prisma.chefDish.create({
    data: {
      ...rest,
      tags: JSON.stringify(tags),
      chefId: userId,
    },
  });

  res.status(201).json(serializeDish(dish));
});

const updateDishSchema = z.object({
  extensionMinutes: z.number().int().min(1).max(120).optional(),
  imageUrl: z.string().optional().nullable(),
  plates: z.number().int().min(1).max(500).optional(),
});

router.patch('/:id', requireAuth, async (req: AuthRequest, res) => {
  const dishId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const dish = await prisma.chefDish.findUnique({ where: { id: dishId } });

  if (!dish) { res.status(404).json({ error: 'Dish not found' }); return; }
  if (dish.chefId !== req.user!.userId) { res.status(403).json({ error: 'Forbidden' }); return; }

  const parsed = updateDishSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  const { extensionMinutes, imageUrl, plates } = parsed.data;
  const updateData: { readyInMinutes?: number; imageUrl?: string | null; plates?: number; restockedAt?: Date } = {};

  if (extensionMinutes != null) {
    // Push readyAt to (now + extensionMinutes): readyAt = createdAt + readyInMinutes*60s
    const elapsedMinutes = Math.ceil((Date.now() - dish.createdAt.getTime()) / 60000);
    updateData.readyInMinutes = elapsedMinutes + extensionMinutes;
  }
  if (imageUrl !== undefined) {
    if (imageUrl && imageUrl.startsWith('data:')) {
      // Upload base64 data URI to Cloudinary; store the CDN URL instead
      updateData.imageUrl = await uploadBase64Image(imageUrl);
    } else {
      updateData.imageUrl = imageUrl;
    }
  }
  if (plates != null) {
    // Setting a fresh plate count is a restock — plates sold before this
    // point no longer count against the new total.
    updateData.plates = plates;
    updateData.restockedAt = new Date();
  }

  const updated = await prisma.chefDish.update({ where: { id: dishId }, data: updateData });
  res.json(serializeDish(updated));
});

router.delete('/:id', requireAuth, async (req: AuthRequest, res) => {
  const dishId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const dish = await prisma.chefDish.findUnique({
    where: { id: dishId },
    select: { id: true, chefId: true },
  });

  if (!dish) {
    res.status(404).json({ error: 'Dish not found' });
    return;
  }
  if (dish.chefId !== req.user!.userId) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  await prisma.chefDish.delete({ where: { id: dish.id } });
  res.json({ success: true });
});

export default router;
