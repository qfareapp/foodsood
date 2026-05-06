import { NextFunction, Request, Response, Router } from 'express';
import * as jwt from 'jsonwebtoken';
import { REPORT_STATUSES } from '../lib/moderation';
import { z } from 'zod';
import prisma from '../lib/prisma';

const router = Router();
const ADMIN_USERNAME = process.env.ADMIN_PANEL_USERNAME ?? 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PANEL_PASSWORD ?? 'password';
const ADMIN_SECRET = process.env.ADMIN_PANEL_SECRET ?? process.env.JWT_ACCESS_SECRET ?? 'admin-secret-change-me';
const ADMIN_EXPIRES_IN = '12h';

type AdminPayload = {
  scope: 'admin';
  username: string;
};

function signAdminToken(username: string): string {
  return jwt.sign({ scope: 'admin', username } satisfies AdminPayload, ADMIN_SECRET, {
    expiresIn: ADMIN_EXPIRES_IN,
  });
}

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null;
  if (!bearer) {
    res.status(401).json({ error: 'Unauthorized admin access' });
    return;
  }
  try {
    const payload = jwt.verify(bearer, ADMIN_SECRET) as AdminPayload;
    if (payload.scope !== 'admin') throw new Error('Invalid scope');
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired admin session' });
  }
}

const userUpdateSchema = z.object({
  isActive: z.boolean().optional(),
  role: z.enum(['BUYER', 'CHEF', 'BOTH']).optional(),
});

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  q: z.string().trim().max(120).optional(),
  role: z.string().trim().max(20).optional(),
  status: z.string().trim().max(40).optional(),
});

function parseJsonArray<T>(value?: string | null): T[] {
  if (!value) return [];
  try {
    return JSON.parse(value) as T[];
  } catch {
    return [];
  }
}

router.post('/login', (req, res) => {
  const parsed = z.object({
    username: z.string().min(1),
    password: z.string().min(1),
  }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  if (parsed.data.username !== ADMIN_USERNAME || parsed.data.password !== ADMIN_PASSWORD) {
    res.status(401).json({ error: 'Invalid admin username or password' });
    return;
  }
  res.json({
    success: true,
    token: signAdminToken(parsed.data.username),
    admin: { username: parsed.data.username },
  });
});

router.get('/me', requireAdmin, (_req, res) => {
  res.json({ authenticated: true, username: ADMIN_USERNAME });
});

router.get('/dashboard', requireAdmin, async (_req, res) => {
  const [
    users,
    requests,
    openRequests,
    quotes,
    orders,
    paidOrders,
    activeOrders,
    liveDishes,
    offers,
    activeOffers,
    openReports,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.request.count(),
    prisma.request.count({ where: { status: { in: ['OPEN', 'NEGOTIATING', 'PAYMENT_PENDING', 'COOKING', 'READY'] } } }),
    prisma.quote.count(),
    prisma.order.count(),
    prisma.order.count({ where: { paymentStatus: 'PAID' } }),
    prisma.order.count({ where: { status: { in: ['CONFIRMED', 'COOKING', 'READY', 'OUT_FOR_DELIVERY'] } } }),
    prisma.chefDish.count(),
    prisma.dishOffer.count(),
    prisma.dishOffer.count({ where: { status: { in: ['PENDING', 'COUNTERED', 'HOLD', 'PAID'] } } }),
    prisma.contentReport.count({ where: { status: { in: ['OPEN', 'REVIEWING'] } } }),
  ]);

  const recentUsers = await prisma.user.findMany({
    orderBy: { createdAt: 'desc' },
    take: 6,
    select: { id: true, name: true, role: true, city: true, isActive: true, createdAt: true },
  });
  const recentOrders = await prisma.order.findMany({
    orderBy: { updatedAt: 'desc' },
    take: 6,
    include: {
      buyer: { select: { name: true } },
      chef: { select: { name: true } },
      request: { select: { dishName: true, delivery: true } },
    },
  });
  const recentRequests = await prisma.request.findMany({
    orderBy: { updatedAt: 'desc' },
    take: 6,
    include: { user: { select: { name: true, city: true } }, _count: { select: { quotes: true } } },
  });

  res.json({
    metrics: {
      users,
      requests,
      openRequests,
      quotes,
      orders,
      paidOrders,
      activeOrders,
      liveDishes,
      offers,
      activeOffers,
      openReports,
    },
    recentUsers,
    recentOrders: recentOrders.map((order) => ({
      id: order.id,
      dishName: order.request.dishName,
      delivery: order.request.delivery,
      buyerName: order.buyer.name,
      chefName: order.chef.name,
      finalPrice: order.finalPrice,
      status: order.status,
      paymentStatus: order.paymentStatus,
      updatedAt: order.updatedAt,
    })),
    recentRequests: recentRequests.map((request) => ({
      id: request.id,
      dishName: request.dishName,
      category: request.category,
      buyerName: request.user.name,
      city: request.user.city ?? request.city,
      budget: request.budget,
      status: request.status,
      quotesCount: request._count.quotes,
      updatedAt: request.updatedAt,
    })),
  });
});

router.get('/reports', requireAdmin, async (req, res) => {
  const parsed = z.object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    status: z.enum(REPORT_STATUSES).optional(),
    q: z.string().trim().max(120).optional(),
  }).safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const where: Record<string, unknown> = {};
  if (parsed.data.status) where.status = parsed.data.status;
  if (parsed.data.q) {
    where.OR = [
      { reason: { contains: parsed.data.q, mode: 'insensitive' } },
      { details: { contains: parsed.data.q, mode: 'insensitive' } },
      { targetType: { contains: parsed.data.q, mode: 'insensitive' } },
    ];
  }

  const reports = await prisma.contentReport.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: parsed.data.limit ?? 100,
    include: {
      reporter: { select: { id: true, name: true, role: true } },
    },
  });

  res.json(reports);
});

router.patch('/reports/:id', requireAdmin, async (req, res) => {
  const parsed = z.object({
    status: z.enum(REPORT_STATUSES).optional(),
    resolutionNotes: z.string().trim().max(500).optional(),
    hideReview: z.boolean().optional(),
    deactivateTargetUser: z.boolean().optional(),
  }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const reportId = String(req.params.id);
  const report = await prisma.contentReport.findUnique({ where: { id: reportId } });
  if (!report) {
    res.status(404).json({ error: 'Report not found' });
    return;
  }

  if (parsed.data.hideReview && report.targetType === 'REVIEW') {
    await prisma.review.update({
      where: { id: report.targetId },
      data: { isHidden: true },
    }).catch(() => undefined);
  }

  if (parsed.data.deactivateTargetUser && report.targetUserId) {
    await prisma.user.update({
      where: { id: report.targetUserId },
      data: { isActive: false },
    }).catch(() => undefined);
  }

  const updated = await prisma.contentReport.update({
    where: { id: reportId },
    data: {
      ...(parsed.data.status ? { status: parsed.data.status } : {}),
      ...(parsed.data.resolutionNotes !== undefined ? { resolutionNotes: parsed.data.resolutionNotes || null } : {}),
      ...(parsed.data.status === 'RESOLVED' || parsed.data.status === 'REJECTED'
        ? { resolvedAt: new Date(), resolvedBy: ADMIN_USERNAME }
        : {}),
    },
  });

  res.json(updated);
});

router.get('/users', requireAdmin, async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const where: Record<string, unknown> = {};
  if (parsed.data.role) where.role = parsed.data.role;
  if (parsed.data.q) {
    where.OR = [
      { name: { contains: parsed.data.q, mode: 'insensitive' } },
      { phone: { contains: parsed.data.q } },
      { city: { contains: parsed.data.q, mode: 'insensitive' } },
    ];
  }

  const users = await prisma.user.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: parsed.data.limit ?? 100,
    include: {
      _count: {
        select: {
          requests: true,
          quotes: true,
          ordersAsBuyer: true,
          ordersAsChef: true,
          savedByUsers: true,
        },
      },
    },
  });

  res.json(users.map((user) => ({
    id: user.id,
    name: user.name,
    phone: user.phone,
    email: user.email,
    role: user.role,
    city: user.city,
    location: user.location,
    rating: user.rating,
    ratingCount: user.ratingCount,
    totalOrders: user.totalOrders,
    isActive: user.isActive,
    createdAt: user.createdAt,
    requestsCount: user._count.requests,
    quotesCount: user._count.quotes,
    buyerOrdersCount: user._count.ordersAsBuyer,
    chefOrdersCount: user._count.ordersAsChef,
    savedByCount: user._count.savedByUsers,
  })));
});

router.patch('/users/:id', requireAdmin, async (req, res) => {
  const parsed = userUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  if (Object.keys(parsed.data).length === 0) {
    res.status(400).json({ error: 'No update fields provided' });
    return;
  }

  const userId = String(req.params.id);
  try {
    const updated = await prisma.user.update({
      where: { id: userId },
      data: parsed.data,
      select: { id: true, name: true, role: true, isActive: true, updatedAt: true },
    });
    res.json(updated);
  } catch {
    res.status(404).json({ error: 'User not found' });
  }
});

router.get('/requests', requireAdmin, async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const where: Record<string, unknown> = {};
  if (parsed.data.status) where.status = parsed.data.status;
  if (parsed.data.q) {
    where.OR = [
      { dishName: { contains: parsed.data.q, mode: 'insensitive' } },
      { category: { contains: parsed.data.q, mode: 'insensitive' } },
      { city: { contains: parsed.data.q, mode: 'insensitive' } },
      { user: { name: { contains: parsed.data.q, mode: 'insensitive' } } },
    ];
  }

  const requests = await prisma.request.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: parsed.data.limit ?? 100,
    include: {
      user: { select: { id: true, name: true, phone: true, city: true } },
      _count: { select: { quotes: true } },
      order: {
        select: {
          id: true,
          status: true,
          paymentStatus: true,
          finalPrice: true,
          chef: { select: { id: true, name: true } },
        },
      },
    },
  });

  res.json(requests.map((request) => ({
    id: request.id,
    dishName: request.dishName,
    category: request.category,
    buyerName: request.user.name,
    buyerPhone: request.user.phone,
    city: request.city ?? request.user.city,
    qty: request.qty,
    people: request.people,
    delivery: request.delivery,
    budget: request.budget,
    status: request.status,
    quotesCount: request._count.quotes,
    preferences: parseJsonArray<string>(request.preferences),
    createdAt: request.createdAt,
    order: request.order,
  })));
});

router.get('/orders', requireAdmin, async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const where: Record<string, unknown> = {};
  if (parsed.data.status) where.status = parsed.data.status;
  if (parsed.data.q) {
    where.OR = [
      { request: { dishName: { contains: parsed.data.q, mode: 'insensitive' } } },
      { buyer: { name: { contains: parsed.data.q, mode: 'insensitive' } } },
      { chef: { name: { contains: parsed.data.q, mode: 'insensitive' } } },
      { paymentRef: { contains: parsed.data.q, mode: 'insensitive' } },
    ];
  }

  const orders = await prisma.order.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: parsed.data.limit ?? 100,
    include: {
      request: { select: { dishName: true, category: true, delivery: true } },
      buyer: { select: { id: true, name: true, phone: true } },
      chef: { select: { id: true, name: true, phone: true } },
      quote: { select: { cookTime: true, price: true, delivery: true } },
      review: { select: { rating: true, comment: true, createdAt: true } },
    },
  });

  res.json(orders);
});

router.get('/live-orders', requireAdmin, async (_req, res) => {
  const orders = await prisma.order.findMany({
    where: {
      paymentStatus: 'PAID',
      status: { in: ['CONFIRMED', 'COOKING', 'READY', 'OUT_FOR_DELIVERY'] },
    },
    orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
    include: {
      request: {
        select: {
          id: true,
          dishName: true,
          category: true,
          qty: true,
          people: true,
          spiceLevel: true,
          preferences: true,
          delivery: true,
          budget: true,
          notes: true,
          city: true,
          createdAt: true,
        },
      },
      buyer: {
        select: {
          id: true,
          name: true,
          phone: true,
          email: true,
          city: true,
          location: true,
        },
      },
      chef: {
        select: {
          id: true,
          name: true,
          phone: true,
          email: true,
          city: true,
          location: true,
          rating: true,
        },
      },
      quote: {
        select: {
          id: true,
          price: true,
          cookTime: true,
          delivery: true,
          style: true,
          message: true,
          counterOffer: true,
          createdAt: true,
        },
      },
      review: {
        select: { rating: true, comment: true, createdAt: true },
      },
    },
  });

  res.json(orders.map((order) => ({
    id: order.id,
    requestId: order.requestId,
    quoteId: order.quoteId,
    buyer: order.buyer,
    chef: order.chef,
    food: {
      dishName: order.request.dishName,
      category: order.request.category,
      qty: order.request.qty,
      people: order.request.people,
      spiceLevel: order.request.spiceLevel,
      preferences: parseJsonArray<string>(order.request.preferences),
      notes: order.request.notes,
    },
    pricing: {
      startingPrice: order.request.budget,
      quotedPrice: order.quote.price,
      lastCounterOffer: order.quote.counterOffer,
      negotiatedPrice: order.finalPrice,
    },
    fulfillment: {
      deliveryMode: order.request.delivery,
      quoteDelivery: order.quote.delivery,
      buyerAddress: order.address ?? order.buyer.location ?? null,
      buyerCity: order.request.city ?? order.buyer.city ?? null,
      chefAddress: order.chef.location ?? null,
      chefCity: order.chef.city ?? null,
    },
    status: {
      orderStatus: order.status,
      paymentStatus: order.paymentStatus,
      paymentRef: order.paymentRef,
      paidAt: order.paidAt,
      cookingStartedAt: order.cookingStartedAt,
      readyAt: order.readyAt,
      cookTime: order.quote.cookTime,
    },
    chefNote: order.quote.message,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  })));
});

router.get('/offers', requireAdmin, async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const where: Record<string, unknown> = {};
  if (parsed.data.status) where.status = parsed.data.status;
  if (parsed.data.q) {
    where.OR = [
      { dishName: { contains: parsed.data.q, mode: 'insensitive' } },
      { buyerName: { contains: parsed.data.q, mode: 'insensitive' } },
    ];
  }

  const offers = await prisma.dishOffer.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: parsed.data.limit ?? 100,
  });

  res.json(offers);
});

router.get('/dishes', requireAdmin, async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const where: Record<string, unknown> = {};
  if (parsed.data.q) {
    where.OR = [
      { dishName: { contains: parsed.data.q, mode: 'insensitive' } },
      { cuisine: { contains: parsed.data.q, mode: 'insensitive' } },
      { chef: { name: { contains: parsed.data.q, mode: 'insensitive' } } },
    ];
  }

  const dishes = await prisma.chefDish.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: parsed.data.limit ?? 100,
    include: {
      chef: { select: { id: true, name: true, city: true, phone: true, isActive: true } },
    },
  });

  res.json(dishes.map((dish) => ({
    ...dish,
    tags: parseJsonArray<string>(dish.tags),
  })));
});

export default router;
