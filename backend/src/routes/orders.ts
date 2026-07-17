import { Router } from 'express';
import { z } from 'zod';
import { createCashfreeOrder, generateCashfreeOrderId, getCashfreeErrorMessage, isCashfreeReady } from '../lib/cashfree';
import prisma from '../lib/prisma';
import { assertNotBlocked } from '../lib/moderation';
import { AuthRequest, requireAuth } from '../middleware/auth';

const router = Router();
const HOLD_MINUTES = 20;

const ORDER_STATUSES = [
  'CONFIRMED', 'COOKING', 'READY', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED',
] as const;
const PAYMENT_STATUSES = ['HOLD', 'ADVANCE_PAID', 'PAID', 'EXPIRED'] as const;

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// Chef-allowed status transitions
const CHEF_TRANSITIONS: Record<string, string[]> = {
  CONFIRMED: ['COOKING'],
  COOKING: ['READY'],
  READY: ['OUT_FOR_DELIVERY', 'DELIVERED'],
  OUT_FOR_DELIVERY: ['DELIVERED'],
};

const ORDER_INCLUDE = {
  request: {
    select: { id: true, dishName: true, category: true, qty: true, people: true, spiceLevel: true, preferences: true, delivery: true },
  },
  quote: {
    select: { id: true, price: true, cookTime: true, style: true, delivery: true },
  },
  buyer: { select: { id: true, name: true, avatar: true, phone: true } },
  chef: { select: { id: true, name: true, avatar: true, phone: true, rating: true } },
  review: true,
} as const;

function holdExpiry() {
  return new Date(Date.now() + HOLD_MINUTES * 60 * 1000);
}

function parseCookTimeToMinutes(cookTime?: string | null): number {
  if (!cookTime) return 120;
  const normalized = cookTime.toLowerCase().trim();
  const num = parseFloat(normalized.replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(num) || num <= 0) return 120;
  if (normalized.includes('hr')) return Math.round(num * 60);
  if (normalized.includes('min')) return Math.round(num);
  return Math.round(num * 60);
}

function getBuyerCashfreeCustomer(input: {
  id: string;
  name: string;
  email?: string | null;
  phone: string;
}) {
  const normalizedPhone = input.phone.replace(/\D/g, '').slice(-10);
  const normalizedEmail = input.email?.trim().toLowerCase();
  const safeEmail = normalizedEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) && !normalizedEmail.endsWith('.local')
    ? normalizedEmail
    : undefined;

  return {
    customerId: input.id,
    customerName: input.name.trim().slice(0, 100) || 'Foodsood Buyer',
    customerEmail: safeEmail,
    customerPhone: normalizedPhone || '9999999999',
  };
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

async function appendDishReviewToChefSpeciality(input: {
  chefId: string;
  dishName: string;
  buyerName: string;
}, review: { rating: number; comment?: string }) {
  const chef = await prisma.user.findUnique({
    where: { id: input.chefId },
    select: { specialityDishes: true },
  });
  if (!chef?.specialityDishes) return;

  const currentSpecialities = JSON.parse(chef.specialityDishes) as SpecialityDishRecord[];
  const nextSpecialities = currentSpecialities.map((item) => {
    if (normaliseDishKey(item.dishName) !== normaliseDishKey(input.dishName)) return item;
    const nextCount = (item.ratingCount ?? 0) + 1;
    const nextAverage = (((item.ratingAverage ?? 0) * (item.ratingCount ?? 0)) + review.rating) / nextCount;
    const recentReviews = [
      {
        buyerName: input.buyerName,
        rating: review.rating,
        comment: review.comment,
        createdAt: new Date().toISOString(),
      },
      ...(item.recentReviews ?? []),
    ].slice(0, 5);
    return {
      ...item,
      ratingCount: nextCount,
      ratingAverage: Math.round(nextAverage * 10) / 10,
      recentReviews,
    };
  });

  await prisma.user.update({
    where: { id: input.chefId },
    data: { specialityDishes: JSON.stringify(nextSpecialities) },
  });
}

async function expireHeldOrders() {
  const expired = await prisma.order.findMany({
    where: {
      paymentStatus: 'HOLD',
      holdUntil: { lt: new Date() },
    },
    select: { id: true, requestId: true },
  });
  if (!expired.length) return;

  await prisma.order.updateMany({
    where: { id: { in: expired.map((item) => item.id) } },
    data: { paymentStatus: 'EXPIRED' },
  });
  await prisma.request.updateMany({
    where: { id: { in: expired.map((item) => item.requestId) } },
    data: { status: 'EXPIRED' },
  });
}

// ── GET /api/orders  (my orders — as buyer or chef) ─────────────────────────
router.get('/', requireAuth, async (req: AuthRequest, res) => {
  await expireHeldOrders();
  const { role: queryRole, status, limit = '20', offset = '0' } = req.query as Record<string, string>;
  const { userId } = req.user!;
  const take = Math.min(parseInt(limit, 10) || 20, 100);
  const skip = parseInt(offset, 10) || 0;

  // Determine which side of orders to fetch
  let where: Record<string, unknown>;
  if (queryRole === 'chef') {
    where = { chefId: userId };
  } else if (queryRole === 'buyer') {
    where = { buyerId: userId };
  } else {
    // Default: return both sides (buyer + chef orders combined)
    where = { OR: [{ buyerId: userId }, { chefId: userId }] };
  }
  if (status) where.status = status;

  const orders = await prisma.order.findMany({
    where,
    include: ORDER_INCLUDE,
    orderBy: { createdAt: 'desc' },
    take,
    skip,
  });

  res.json(
    orders.map((o) => ({
      ...o,
      request: {
        ...o.request,
        preferences: JSON.parse(o.request.preferences) as string[],
      },
    })),
  );
});

// ── GET /api/orders/:id ─────────────────────────────────────────────────────
router.get('/:id', requireAuth, async (req: AuthRequest, res) => {
  await expireHeldOrders();
  const orderId = firstParam(req.params.id);
  if (!orderId) return res.status(400).json({ error: 'Order id required' });
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: ORDER_INCLUDE,
  });
  if (!order) {
    res.status(404).json({ error: 'Order not found' });
    return;
  }
  if (order.buyerId !== req.user!.userId && order.chefId !== req.user!.userId) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  res.json({
    ...order,
    request: {
      ...order.request,
      preferences: JSON.parse(order.request.preferences) as string[],
    },
  });
});

// ── PUT /api/orders/:id/status  (chef updates order status) ──────────────────
router.put('/:id/status', requireAuth, async (req: AuthRequest, res) => {
  await expireHeldOrders();
  const orderId = firstParam(req.params.id);
  if (!orderId) return res.status(400).json({ error: 'Order id required' });
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { chefId: true, buyerId: true, status: true, requestId: true, paymentStatus: true, quote: { select: { cookTime: true } } },
  });
  if (!order) {
    res.status(404).json({ error: 'Order not found' });
    return;
  }

  const isChef = order.chefId === req.user!.userId;
  const isBuyer = order.buyerId === req.user!.userId;
  if (!isChef && !isBuyer) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  const schema = z.object({ status: z.enum(ORDER_STATUSES) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { status: newStatus } = parsed.data;

  if (order.paymentStatus !== 'PAID' && order.paymentStatus !== 'ADVANCE_PAID') {
    res.status(409).json({ error: 'Order must be paid before status updates can begin' });
    return;
  }

  // Chefs can only move forward through the pipeline
  if (isChef) {
    const allowed = CHEF_TRANSITIONS[order.status] ?? [];
    if (!allowed.includes(newStatus)) {
      res.status(409).json({
        error: `Cannot transition from ${order.status} to ${newStatus}`,
        allowed,
      });
      return;
    }
  }

  // Buyers can only cancel (and only before READY)
  if (isBuyer && !isChef) {
    if (newStatus !== 'CANCELLED') {
      res.status(403).json({ error: 'Buyers can only cancel orders' });
      return;
    }
    if (['READY', 'OUT_FOR_DELIVERY', 'DELIVERED'].includes(order.status)) {
      res.status(409).json({ error: 'Cannot cancel an order that is already ready or delivered' });
      return;
    }
  }

  const updateData: { status: string; cookingStartedAt?: Date; readyAt?: Date } = { status: newStatus };
  if (newStatus === 'COOKING') {
    const startedAt = new Date();
    updateData.cookingStartedAt = startedAt;
    updateData.readyAt = new Date(startedAt.getTime() + parseCookTimeToMinutes(order.quote?.cookTime) * 60 * 1000);
  }

  await prisma.order.update({
    where: { id: orderId },
    data: updateData,
  });

  // Sync request status with order status
  const requestStatusMap: Record<string, string> = {
    COOKING: 'COOKING',
    READY: 'READY',
    DELIVERED: 'COMPLETED',
    CANCELLED: 'CANCELLED',
  };
  if (requestStatusMap[newStatus]) {
    await prisma.request.update({
      where: { id: order.requestId },
      data: { status: requestStatusMap[newStatus] },
    });
  }

  const updated = await prisma.order.findUnique({
    where: { id: orderId },
    include: ORDER_INCLUDE,
  });
  if (!updated) {
    res.status(404).json({ error: 'Order not found after update' });
    return;
  }

  res.json({
    ...updated,
    request: {
      ...updated.request,
      preferences: JSON.parse(updated.request.preferences) as string[],
    },
  });
});

router.post('/:id/pay', requireAuth, async (req: AuthRequest, res) => {
  await expireHeldOrders();
  const orderId = firstParam(req.params.id);
  if (!orderId) return res.status(400).json({ error: 'Order id required' });
  const schema = z.object({
    paymentMethod: z.string().max(40).optional(),
    paymentType: z.enum(['full', 'advance']).default('full'),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, buyerId: true, paymentStatus: true, holdUntil: true, requestId: true, chefId: true, finalPrice: true },
  });
  if (!order) {
    res.status(404).json({ error: 'Order not found' });
    return;
  }
  if (order.buyerId !== req.user!.userId) {
    res.status(403).json({ error: 'Only the buyer can pay for this order' });
    return;
  }
  try {
    await assertNotBlocked(order.buyerId, order.chefId);
  } catch (error) {
    res.status(403).json({ error: error instanceof Error ? error.message : 'Blocked interaction' });
    return;
  }
  if (order.paymentStatus !== 'HOLD') {
    res.status(409).json({ error: 'Order is not awaiting payment' });
    return;
  }
  if (!order.holdUntil || order.holdUntil.getTime() <= Date.now()) {
    await prisma.order.update({
      where: { id: order.id },
      data: { paymentStatus: 'EXPIRED' },
    });
    await prisma.request.update({
      where: { id: order.requestId },
      data: { status: 'EXPIRED' },
    });
    res.status(409).json({ error: 'Payment window expired' });
    return;
  }

  const isAdvance = parsed.data.paymentType === 'advance';
  const advancePaid = isAdvance ? Math.ceil(order.finalPrice * 0.2) : null;
  const paymentRef = `DEMO-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;

  await prisma.order.update({
    where: { id: order.id },
    data: {
      paymentStatus: isAdvance ? 'ADVANCE_PAID' : 'PAID',
      paymentType: isAdvance ? 'ADVANCE' : 'FULL',
      advancePaid,
      paidAt: new Date(),
      paymentRef,
      holdUntil: null,
      status: 'CONFIRMED',
    },
  });

  await prisma.user.update({
    where: { id: order.chefId },
    data: { totalOrders: { increment: 1 } },
  });

  const updated = await prisma.order.findUnique({
    where: { id: order.id },
    include: ORDER_INCLUDE,
  });
  if (!updated) {
    res.status(404).json({ error: 'Order not found after payment' });
    return;
  }

  res.json({
    ...updated,
    request: {
      ...updated.request,
      preferences: JSON.parse(updated.request.preferences) as string[],
    },
  });
});

router.post('/:id/cashfree/session', requireAuth, async (req: AuthRequest, res) => {
  await expireHeldOrders();
  if (!isCashfreeReady()) {
    res.status(503).json({ error: 'Cashfree is not configured on the server' });
    return;
  }

  const orderId = firstParam(req.params.id);
  if (!orderId) return res.status(400).json({ error: 'Order id required' });
  const schema = z.object({
    paymentType: z.enum(['full', 'advance']).default('full'),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      buyer: { select: { id: true, name: true, email: true, phone: true } },
      request: { select: { dishName: true } },
    },
  });
  if (!order) {
    res.status(404).json({ error: 'Order not found' });
    return;
  }
  if (order.buyerId !== req.user!.userId) {
    res.status(403).json({ error: 'Only the buyer can pay for this order' });
    return;
  }
  if (order.paymentStatus !== 'HOLD') {
    res.status(409).json({ error: 'Order is not awaiting payment' });
    return;
  }
  if (!order.holdUntil || order.holdUntil.getTime() <= Date.now()) {
    await prisma.order.update({ where: { id: order.id }, data: { paymentStatus: 'EXPIRED' } });
    await prisma.request.update({ where: { id: order.requestId }, data: { status: 'EXPIRED' } });
    res.status(409).json({ error: 'Payment window expired' });
    return;
  }

  const isAdvance = parsed.data.paymentType === 'advance';
  const payableAmount = isAdvance ? Math.ceil(order.finalPrice * 0.2) : order.finalPrice;
  const cashfreeOrderId = generateCashfreeOrderId('ORDER', order.id, 'initial');
  try {
    const cfOrder = await createCashfreeOrder({
      cashfreeOrderId,
      amount: payableAmount,
      customer: getBuyerCashfreeCustomer(order.buyer),
      note: `${order.request.dishName} order payment`,
      expiresAt: order.holdUntil,
      tags: {
        entityType: 'ORDER',
        entityId: order.id,
        paymentStage: 'initial',
        paymentType: parsed.data.paymentType,
      },
    });

    await prisma.order.update({
      where: { id: order.id },
      data: {
        paymentGateway: 'CASHFREE',
        paymentType: isAdvance ? 'ADVANCE' : 'FULL',
        advancePaid: isAdvance ? payableAmount : null,
        cashfreeOrderId,
        cashfreePaymentSessionId: cfOrder.payment_session_id,
        cashfreeOrderStatus: cfOrder.order_status,
        paymentInitiatedAt: new Date(),
      },
    });

    res.json({
      gateway: 'CASHFREE',
      cashfreeOrderId,
      paymentSessionId: cfOrder.payment_session_id,
      environment: process.env.CASHFREE_ENV?.trim().toUpperCase() === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX',
      amount: payableAmount,
      paymentType: parsed.data.paymentType,
    });
  } catch (error) {
    const message = getCashfreeErrorMessage(error);
    console.error('Cashfree order session failed:', message, { orderId, buyerId: order.buyerId, paymentType: parsed.data.paymentType });
    res.status(502).json({ error: message });
  }
});

router.post('/:id/pay-balance', requireAuth, async (req: AuthRequest, res) => {
  const orderId = firstParam(req.params.id);
  if (!orderId) return res.status(400).json({ error: 'Order id required' });

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, buyerId: true, paymentStatus: true, finalPrice: true, advancePaid: true, chefId: true, requestId: true },
  });
  if (!order) {
    res.status(404).json({ error: 'Order not found' });
    return;
  }
  if (order.buyerId !== req.user!.userId) {
    res.status(403).json({ error: 'Only the buyer can pay the balance' });
    return;
  }
  if (order.paymentStatus !== 'ADVANCE_PAID') {
    res.status(409).json({ error: 'Balance payment only applies to advance-paid orders' });
    return;
  }
  try {
    await assertNotBlocked(order.buyerId, order.chefId);
  } catch (error) {
    res.status(403).json({ error: error instanceof Error ? error.message : 'Blocked interaction' });
    return;
  }

  const balancePaymentRef = `DEMO-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  await prisma.order.update({
    where: { id: order.id },
    data: {
      paymentStatus: 'PAID',
      balancePaidAt: new Date(),
      balancePaymentRef,
    },
  });

  const updated = await prisma.order.findUnique({
    where: { id: order.id },
    include: ORDER_INCLUDE,
  });
  if (!updated) {
    res.status(404).json({ error: 'Order not found after balance payment' });
    return;
  }

  res.json({
    ...updated,
    request: {
      ...updated.request,
      preferences: JSON.parse(updated.request.preferences) as string[],
    },
  });
});

router.post('/:id/cashfree/balance-session', requireAuth, async (req: AuthRequest, res) => {
  if (!isCashfreeReady()) {
    res.status(503).json({ error: 'Cashfree is not configured on the server' });
    return;
  }

  const orderId = firstParam(req.params.id);
  if (!orderId) return res.status(400).json({ error: 'Order id required' });
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      buyer: { select: { id: true, name: true, email: true, phone: true } },
      request: { select: { dishName: true } },
    },
  });
  if (!order) {
    res.status(404).json({ error: 'Order not found' });
    return;
  }
  if (order.buyerId !== req.user!.userId) {
    res.status(403).json({ error: 'Only the buyer can pay the balance' });
    return;
  }
  if (order.paymentStatus !== 'ADVANCE_PAID') {
    res.status(409).json({ error: 'Balance payment only applies to advance-paid orders' });
    return;
  }

  const payableAmount = order.finalPrice - (order.advancePaid ?? 0);
  if (payableAmount <= 0) {
    res.status(409).json({ error: 'No balance due for this order' });
    return;
  }

  const cashfreeOrderId = generateCashfreeOrderId('ORDER', order.id, 'balance');
  try {
    const cfOrder = await createCashfreeOrder({
      cashfreeOrderId,
      amount: payableAmount,
      customer: getBuyerCashfreeCustomer(order.buyer),
      note: `${order.request.dishName} balance payment`,
      tags: {
        entityType: 'ORDER',
        entityId: order.id,
        paymentStage: 'balance',
        paymentType: 'balance',
      },
    });

    await prisma.order.update({
      where: { id: order.id },
      data: {
        paymentGateway: 'CASHFREE',
        cashfreeBalanceOrderId: cashfreeOrderId,
        cashfreeBalancePaymentSessionId: cfOrder.payment_session_id,
        cashfreeBalanceOrderStatus: cfOrder.order_status,
        balancePaymentInitiatedAt: new Date(),
      },
    });

    res.json({
      gateway: 'CASHFREE',
      cashfreeOrderId,
      paymentSessionId: cfOrder.payment_session_id,
      environment: process.env.CASHFREE_ENV?.trim().toUpperCase() === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX',
      amount: payableAmount,
      paymentType: 'balance',
    });
  } catch (error) {
    const message = getCashfreeErrorMessage(error);
    console.error('Cashfree balance session failed:', message, { orderId, buyerId: order.buyerId });
    res.status(502).json({ error: message });
  }
});

// ── POST /api/orders/:id/review  (buyer reviews the chef after delivery) ─────
router.post('/:id/review', requireAuth, async (req: AuthRequest, res) => {
  const orderId = firstParam(req.params.id);
  if (!orderId) return res.status(400).json({ error: 'Order id required' });
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { review: true, request: { select: { dishName: true } }, buyer: { select: { name: true } } },
  });
  if (!order) {
    res.status(404).json({ error: 'Order not found' });
    return;
  }
  if (order.buyerId !== req.user!.userId) {
    res.status(403).json({ error: 'Only the buyer can leave a review' });
    return;
  }
  if (order.status !== 'DELIVERED') {
    res.status(409).json({ error: 'Can only review after the order is delivered' });
    return;
  }
  if (order.review) {
    res.status(409).json({ error: 'Review already submitted for this order' });
    return;
  }
  try {
    await assertNotBlocked(order.buyerId, order.chefId);
  } catch (error) {
    res.status(403).json({ error: error instanceof Error ? error.message : 'Blocked interaction' });
    return;
  }

  const reviewer = await prisma.user.findUnique({
    where: { id: req.user!.userId },
    select: { ugcPolicyAcceptedAt: true },
  });
  if (!reviewer?.ugcPolicyAcceptedAt) {
    res.status(403).json({ error: 'Accept the community policy before posting a review' });
    return;
  }

  const schema = z.object({
    chefRating: z.number().int().min(1).max(5),
    chefComment: z.string().max(500).optional(),
    foodRating: z.number().int().min(1).max(5),
    foodComment: z.string().max(500).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const review = await prisma.review.create({
    data: {
      orderId: order.id,
      reviewerId: req.user!.userId,
      chefId: order.chefId,
      rating: parsed.data.chefRating,
      comment: parsed.data.chefComment?.trim() || null,
      isHidden: false,
    },
  });

  await appendDishReviewToChefSpeciality({
    chefId: order.chefId,
    dishName: order.request.dishName,
    buyerName: order.buyer.name || 'Buyer',
  }, {
    rating: parsed.data.foodRating,
    comment: parsed.data.foodComment?.trim() || undefined,
  });

  // Recompute chef's aggregate rating
  const agg = await prisma.review.aggregate({
    where: { chefId: order.chefId },
    _avg: { rating: true },
    _count: { rating: true },
  });
  await prisma.user.update({
    where: { id: order.chefId },
    data: {
      rating: Math.round((agg._avg.rating ?? 0) * 10) / 10,
      ratingCount: agg._count.rating,
    },
  });

  res.status(201).json(review);
});

export default router;
