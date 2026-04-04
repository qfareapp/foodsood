import bcrypt from 'bcryptjs';
import { createHash } from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import { notifyChefs } from '../lib/fcm';
import { haversineKm } from '../lib/geo';
import prisma from '../lib/prisma';
import { AuthRequest, optionalAuth, requireAuth } from '../middleware/auth';

const router = Router();

const OPEN_STATUSES = ['OPEN', 'NEGOTIATING'];

const REQUEST_STATUSES = [
  'OPEN', 'NEGOTIATING', 'PAYMENT_PENDING', 'COOKING', 'READY', 'COMPLETED', 'CANCELLED', 'EXPIRED',
] as const;

const createSchema = z.object({
  buyerToken: z.string().min(8).max(120).optional(),
  buyerName: z.string().min(2).max(80).optional(),
  category: z.string().min(1).max(50),
  dishName: z.string().min(1).max(120),
  qty: z.number().min(0.1).max(50),
  people: z.number().int().min(1).max(200),
  spiceLevel: z.enum(['mild', 'medium', 'extra']),
  preferences: z.array(z.string()).default([]),
  delivery: z.enum(['pickup', 'delivery']),
  budget: z.number().int().min(1).max(100000),
  targetChefId: z.string().min(1).optional(),
  notes: z.string().max(500).optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  city: z.string().optional(),
  notifyRadiusKm: z.number().min(1).max(50).default(2),
  expiresAt: z.string().datetime().optional(),
});

const BUYER_SHADOW_PASSWORD = 'buyer-shadow-account';

function buyerPhoneFromToken(token: string): string {
  return `b${createHash('sha256').update(token).digest('hex').slice(0, 14)}`;
}

function buyerEmailFromToken(token: string): string {
  return `buyer-${createHash('sha256').update(`email:${token}`).digest('hex').slice(0, 20)}@buyer.local`;
}

async function resolveBuyerUserId(input: {
  userId?: string;
  buyerToken?: string;
  buyerName?: string;
  city?: string;
  lat?: number;
  lng?: number;
}): Promise<string | null> {
  if (input.userId) return input.userId;
  if (!input.buyerToken || !input.buyerName) return null;

  const phone = buyerPhoneFromToken(input.buyerToken);
  const email = buyerEmailFromToken(input.buyerToken);
  const existing = await prisma.user.findUnique({
    where: { phone },
    select: { id: true },
  });
  if (existing) {
    await prisma.user.update({
      where: { id: existing.id },
      data: {
        name: input.buyerName,
        city: input.city,
        lat: input.lat,
        lng: input.lng,
      },
    });
    return existing.id;
  }

  const password = await bcrypt.hash(BUYER_SHADOW_PASSWORD, 10);
  const created = await prisma.user.create({
    data: {
      name: input.buyerName,
      phone,
      email,
      password,
      role: 'BUYER',
      city: input.city,
      lat: input.lat,
      lng: input.lng,
    },
    select: { id: true },
  });
  return created.id;
}

const updateSchema = z.object({
  status: z.enum(REQUEST_STATUSES).optional(),
  notes: z.string().max(500).optional(),
  budget: z.number().int().min(1).optional(),
});

// Shared include for quote counts on list views
const WITH_QUOTE_COUNT = {
  _count: { select: { quotes: true } },
  user: {
    select: { id: true, name: true, avatar: true, city: true, rating: true },
  },
} as const;

// ── GET /api/requests  (nearby feed) ────────────────────────────────────────
// Query params: lat, lng, radiusKm (default 5), category, status, limit (default 20), offset
router.get('/', optionalAuth, async (req: AuthRequest, res) => {
  const {
    lat, lng,
    radiusKm = '5',
    category,
    status = 'OPEN',
    limit = '20',
    offset = '0',
  } = req.query as Record<string, string>;

  const take = Math.min(parseInt(limit, 10) || 20, 100);
  const skip = parseInt(offset, 10) || 0;
  const userLat = lat ? parseFloat(lat) : null;
  const userLng = lng ? parseFloat(lng) : null;
  const radius = parseFloat(radiusKm) || 5;

  const statuses = status.split(',').map((item) => item.trim()).filter(Boolean);
  const chefId = (req.user?.role === 'CHEF' || req.user?.role === 'BOTH') ? req.user.userId : null;

  const where: Record<string, unknown> = statuses.length <= 1
    ? { status: statuses[0] ?? 'OPEN' }
    : { status: { in: statuses } };
  if (category) where.category = category;

  const candidateTake = userLat != null && userLng != null
    ? Math.min(Math.max((take + skip) * 6, 120), 400)
    : take + skip;

  const requests = await prisma.request.findMany({
    where,
    include: WITH_QUOTE_COUNT,
    orderBy: { createdAt: 'desc' },
    take: chefId ? 400 : candidateTake, // fetch more when chef-filtering in app code
  });

  let results = requests
    .filter((r) => {
      if (!chefId) return true; // unauthenticated — show all
      // show universal requests (no targetChefId) and requests directed at this chef
      return !r.targetChefId || r.targetChefId === chefId;
    })
    .map((r) => ({
      ...r,
      preferences: (() => { try { return JSON.parse(r.preferences) as string[]; } catch { return [] as string[]; } })(),
      quotesCount: r._count.quotes,
      _count: undefined,
    }));

  if (userLat !== null && userLng !== null) {
    results = results
      .filter((r) => {
        if (r.lat === null || r.lng === null) return true; // no coords → include
        return haversineKm(userLat, userLng, r.lat, r.lng) <= radius;
      })
      .map((r) => ({
        ...r,
        distanceKm:
          r.lat !== null && r.lng !== null
            ? Math.round(haversineKm(userLat, userLng, r.lat, r.lng) * 10) / 10
            : null,
      }));
  }

  res.json(results.slice(skip, skip + take));
});

// ── GET /api/requests/me  (my own requests) ─────────────────────────────────
router.get('/me', requireAuth, async (req: AuthRequest, res) => {
  const { status, limit = '20', offset = '0' } = req.query as Record<string, string>;
  const take = Math.min(parseInt(limit, 10) || 20, 100);
  const skip = parseInt(offset, 10) || 0;

  const requests = await prisma.request.findMany({
    where: {
      userId: req.user!.userId,
      ...(status ? { status } : {}),
    },
    include: {
      ...WITH_QUOTE_COUNT,
      order: { select: { id: true, status: true, finalPrice: true, paymentStatus: true, holdUntil: true, paymentRef: true, paidAt: true, cookingStartedAt: true, readyAt: true } },
    },
    orderBy: { createdAt: 'desc' },
    take,
    skip,
  });

  res.json(
    requests.map((r) => ({
      ...r,
      preferences: (() => { try { return JSON.parse(r.preferences) as string[]; } catch { return [] as string[]; } })(),
      quotesCount: r._count.quotes,
      _count: undefined,
    })),
  );
});

// ── GET /api/requests/:id ───────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  const request = await prisma.request.findUnique({
    where: { id: req.params.id },
    include: {
      user: { select: { id: true, name: true, avatar: true, city: true, rating: true } },
      quotes: {
        where: { status: { not: 'WITHDRAWN' } },
        orderBy: { createdAt: 'desc' },
        include: {
          chef: { select: { id: true, name: true, avatar: true, rating: true, ratingCount: true, totalOrders: true, cookingStyle: true, city: true } },
        },
      },
      order: { select: { id: true, status: true, finalPrice: true, paymentStatus: true, holdUntil: true, paymentRef: true, paidAt: true, cookingStartedAt: true, readyAt: true } },
    },
  });

  if (!request) {
    res.status(404).json({ error: 'Request not found' });
    return;
  }

  res.json({
    ...request,
    preferences: JSON.parse(request.preferences) as string[],
  });
});

// ── POST /api/requests ──────────────────────────────────────────────────────
router.post('/', optionalAuth, async (req: AuthRequest, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { preferences, expiresAt, notifyRadiusKm, buyerToken, buyerName, ...rest } = parsed.data;
  const userId = await resolveBuyerUserId({
    userId: req.user?.userId,
    buyerToken,
    buyerName,
    city: rest.city,
    lat: rest.lat,
    lng: rest.lng,
  });
  if (!userId) {
    res.status(400).json({ error: 'buyerToken and buyerName are required' });
    return;
  }

  if (rest.targetChefId) {
    const targetChef = await prisma.user.findFirst({
      where: {
        id: rest.targetChefId,
        role: { in: ['CHEF', 'BOTH'] },
        isActive: true,
      },
      select: { id: true },
    });
    if (!targetChef) {
      res.status(404).json({ error: 'Selected chef is unavailable' });
      return;
    }
  }

  const request = await prisma.request.create({
    data: {
      ...rest,
      preferences: JSON.stringify(preferences),
      userId,
      ...(expiresAt ? { expiresAt: new Date(expiresAt) } : {}),
    },
  });

  res.status(201).json({
    ...request,
    preferences: JSON.parse(request.preferences) as string[],
  });

  // ── Notify nearby chefs (fire-and-forget) ────────────────────────────────
  const chefRadius = notifyRadiusKm; // km — buyer-defined geofence radius
  const nearbyChefs = await prisma.user.findMany({
    where: {
      role: { in: ['CHEF', 'BOTH'] },
      isActive: true,
      fcmTokens: { some: {} },
      ...(rest.targetChefId ? { id: rest.targetChefId } : {}),
    },
    select: { lat: true, lng: true, fcmTokens: { select: { token: true } } },
  });

  const tokens: string[] = [];
  for (const chef of nearbyChefs) {
    if (rest.lat && rest.lng && chef.lat && chef.lng) {
      if (haversineKm(rest.lat, rest.lng, chef.lat, chef.lng) <= chefRadius) {
        tokens.push(...chef.fcmTokens.map((t) => t.token));
      }
    } else {
      tokens.push(...chef.fcmTokens.map((t) => t.token));
    }
  }

  notifyChefs(
    tokens,
    '🍽 New Food Request Near You!',
    `Someone wants ${rest.dishName} — budget ₹${rest.budget}. Be the first to quote!`,
    { requestId: request.id, type: 'NEW_REQUEST' },
  ).catch(() => {});
});

// ── PUT /api/requests/:id ───────────────────────────────────────────────────
router.put('/:id', requireAuth, async (req: AuthRequest, res) => {
  const request = await prisma.request.findUnique({
    where: { id: req.params.id },
    select: { userId: true, status: true },
  });
  if (!request) {
    res.status(404).json({ error: 'Request not found' });
    return;
  }
  if (request.userId !== req.user!.userId) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const updated = await prisma.request.update({
    where: { id: req.params.id },
    data: parsed.data,
  });

  res.json({
    ...updated,
    preferences: JSON.parse(updated.preferences) as string[],
  });
});

// ── DELETE /api/requests/:id  (cancel) ──────────────────────────────────────
router.delete('/:id', requireAuth, async (req: AuthRequest, res) => {
  const request = await prisma.request.findUnique({
    where: { id: req.params.id },
    select: { userId: true, status: true },
  });
  if (!request) {
    res.status(404).json({ error: 'Request not found' });
    return;
  }
  if (request.userId !== req.user!.userId) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  if (!OPEN_STATUSES.includes(request.status)) {
    res.status(409).json({ error: 'Cannot cancel a request that is already cooking or completed' });
    return;
  }

  await prisma.request.update({
    where: { id: req.params.id },
    data: { status: 'CANCELLED' },
  });

  res.json({ success: true });
});

// ── POST /api/requests/:id/quotes  (chef submits a quote) ───────────────────
router.post('/:id/quotes', requireAuth, async (req: AuthRequest, res) => {
  // Any chef (role CHEF or BOTH) can submit
  const { role, userId } = req.user!;
  if (role !== 'CHEF' && role !== 'BOTH') {
    res.status(403).json({ error: 'Chef role required to submit quotes' });
    return;
  }

  const request = await prisma.request.findUnique({
    where: { id: req.params.id },
    select: { id: true, status: true, userId: true, targetChefId: true },
  });
  if (!request) {
    res.status(404).json({ error: 'Request not found' });
    return;
  }
  if (request.userId === userId) {
    res.status(400).json({ error: 'Cannot quote on your own request' });
    return;
  }
  if (request.targetChefId && request.targetChefId !== userId) {
    res.status(403).json({ error: 'This request was sent to another chef' });
    return;
  }
  if (!OPEN_STATUSES.includes(request.status)) {
    res.status(409).json({ error: 'Request is no longer accepting quotes' });
    return;
  }

  const existing = await prisma.quote.findFirst({
    where: { requestId: req.params.id, chefId: userId, status: { not: 'WITHDRAWN' } },
    select: { id: true },
  });
  if (existing) {
    res.status(409).json({ error: 'You already have an active quote on this request', quoteId: existing.id });
    return;
  }

  const quoteSchema = z.object({
    price: z.number().int().min(1).max(100000),
    cookTime: z.string().min(1).max(50),
    delivery: z.enum(['pickup', 'delivery', 'both']),
    message: z.string().max(500).optional(),
    style: z.string().max(80).optional(),
  });

  const parsed = quoteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const quote = await prisma.quote.create({
    data: { ...parsed.data, requestId: req.params.id, chefId: userId },
    include: {
      chef: { select: { id: true, name: true, avatar: true, rating: true, ratingCount: true, totalOrders: true } },
    },
  });

  // Mark request as NEGOTIATING if still OPEN
  if (request.status === 'OPEN') {
    await prisma.request.update({ where: { id: req.params.id }, data: { status: 'NEGOTIATING' } });
  }

  res.status(201).json(quote);
});

// ── GET /api/requests/:id/quotes  (request owner sees all quotes) ────────────
router.get('/:id/quotes', requireAuth, async (req: AuthRequest, res) => {
  const request = await prisma.request.findUnique({
    where: { id: req.params.id },
    select: { userId: true },
  });
  if (!request) {
    res.status(404).json({ error: 'Request not found' });
    return;
  }
  // Only the request owner (or the chef themselves) can view quotes
  const isOwner = request.userId === req.user!.userId;
  const isChef = req.user!.role === 'CHEF' || req.user!.role === 'BOTH';

  if (!isOwner && !isChef) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  const where = isOwner
    ? { requestId: req.params.id }
    : { requestId: req.params.id, chefId: req.user!.userId };

  const quotes = await prisma.quote.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: {
      chef: {
        select: { id: true, name: true, avatar: true, rating: true, ratingCount: true, totalOrders: true, cookingStyle: true },
      },
    },
  });

  res.json(quotes);
});

export default router;
