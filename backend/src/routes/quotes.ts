import { createHash } from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { AuthRequest, requireAuth } from '../middleware/auth';

const router = Router();
const HOLD_MINUTES = 10;
const MAX_CHEF_QUOTES = 2;
const MAX_BUYER_QUOTES = 2;
const MAX_BUYER_COUNTERS = MAX_BUYER_QUOTES - 1;

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function holdExpiry() {
  return new Date(Date.now() + HOLD_MINUTES * 60 * 1000);
}

function buyerPhoneFromToken(token: string): string {
  return `b${createHash('sha256').update(token).digest('hex').slice(0, 14)}`;
}

async function verifyBuyerTokenForQuote(quoteId: string, buyerToken: string) {
  const quote = await prisma.quote.findUnique({
    where: { id: quoteId },
    include: {
      request: {
        select: {
          id: true,
          userId: true,
          status: true,
          delivery: true,
          user: { select: { phone: true } },
        },
      },
    },
  });
  if (!quote) return { error: 'Quote not found' as const };
  if (quote.request.user.phone !== buyerPhoneFromToken(buyerToken)) {
    return { error: 'Only the request owner can perform this action' as const };
  }
  return { quote };
}

// ── GET /api/quotes/:id ─────────────────────────────────────────────────────
router.get('/:id', requireAuth, async (req: AuthRequest, res) => {
  const quoteId = firstParam(req.params.id);
  if (!quoteId) return res.status(400).json({ error: 'Quote id required' });
  const quote = await prisma.quote.findUnique({
    where: { id: quoteId },
    include: {
      chef: { select: { id: true, name: true, avatar: true, rating: true, ratingCount: true, totalOrders: true, cookingStyle: true } },
      request: { select: { id: true, dishName: true, userId: true, status: true } },
    },
  });
  if (!quote) {
    res.status(404).json({ error: 'Quote not found' });
    return;
  }
  // Visible to: chef who submitted, buyer who owns the request
  if (quote.chefId !== req.user!.userId && quote.request.userId !== req.user!.userId) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  res.json(quote);
});

// ── PUT /api/quotes/:id  (chef updates their own quote) ──────────────────────
router.put('/:id', requireAuth, async (req: AuthRequest, res) => {
  const quoteId = firstParam(req.params.id);
  if (!quoteId) return res.status(400).json({ error: 'Quote id required' });
  const quote = await prisma.quote.findUnique({
    where: { id: quoteId },
    select: { chefId: true, status: true, chefQuoteCount: true },
  });
  if (!quote) {
    res.status(404).json({ error: 'Quote not found' });
    return;
  }
  if (quote.chefId !== req.user!.userId) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  if (!['PENDING', 'COUNTERED'].includes(quote.status)) {
    res.status(409).json({ error: 'Cannot edit a quote that is accepted, rejected, or withdrawn' });
    return;
  }
  if (quote.chefQuoteCount >= MAX_CHEF_QUOTES) {
    res.status(409).json({ error: 'Chef quote limit reached for this request' });
    return;
  }

  const updateSchema = z.object({
    price: z.number().int().min(1).optional(),
    cookTime: z.string().max(50).optional(),
    delivery: z.enum(['pickup', 'delivery', 'both']).optional(),
    message: z.string().max(500).optional(),
    style: z.string().max(80).optional(),
  });

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const updated = await prisma.quote.update({
    where: { id: quoteId },
    data: {
      ...parsed.data,
      status: 'PENDING',
      counterOffer: null,
      chefQuoteCount: { increment: 1 },
    },
  });
  res.json(updated);
});

// ── POST /api/quotes/:id/counter  (buyer sends counter offer) ────────────────
router.post('/:id/counter', requireAuth, async (req: AuthRequest, res) => {
  const quoteId = firstParam(req.params.id);
  if (!quoteId) return res.status(400).json({ error: 'Quote id required' });
  const quote = await prisma.quote.findUnique({
    where: { id: quoteId },
    include: { request: { select: { userId: true, status: true } } },
  });
  if (!quote) {
    res.status(404).json({ error: 'Quote not found' });
    return;
  }
  if (quote.request.userId !== req.user!.userId) {
    res.status(403).json({ error: 'Only the request owner can counter' });
    return;
  }
  if (!['PENDING', 'COUNTERED'].includes(quote.status)) {
    res.status(409).json({ error: 'Quote is not in a negotiable state' });
    return;
  }
  if (quote.buyerCounterCount >= MAX_BUYER_COUNTERS) {
    res.status(409).json({ error: 'Buyer quote limit reached for this request' });
    return;
  }

  const schema = z.object({ offer: z.number().int().min(1).max(100000) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const updated = await prisma.quote.update({
    where: { id: quoteId },
    data: { status: 'COUNTERED', counterOffer: parsed.data.offer, buyerCounterCount: { increment: 1 } },
  });
  res.json(updated);
});

router.post('/:id/public-counter', async (req, res) => {
  const quoteId = firstParam(req.params.id);
  if (!quoteId) return res.status(400).json({ error: 'Quote id required' });
  const schema = z.object({
    buyerToken: z.string().min(8),
    offer: z.number().int().min(1).max(100000),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const checked = await verifyBuyerTokenForQuote(quoteId, parsed.data.buyerToken);
  if ('error' in checked) {
    res.status(checked.error === 'Quote not found' ? 404 : 403).json({ error: checked.error });
    return;
  }
  const { quote } = checked;
  if (!['PENDING', 'COUNTERED'].includes(quote.status)) {
    res.status(409).json({ error: 'Quote is not in a negotiable state' });
    return;
  }
  if (quote.buyerCounterCount >= MAX_BUYER_COUNTERS) {
    res.status(409).json({ error: 'Buyer quote limit reached for this request' });
    return;
  }

  const updated = await prisma.quote.update({
    where: { id: quoteId },
    data: { status: 'COUNTERED', counterOffer: parsed.data.offer, buyerCounterCount: { increment: 1 } },
  });
  res.json(updated);
});

// ── POST /api/quotes/:id/accept  (buyer accepts → creates Order) ─────────────
router.post('/:id/accept', requireAuth, async (req: AuthRequest, res) => {
  const quoteId = firstParam(req.params.id);
  if (!quoteId) return res.status(400).json({ error: 'Quote id required' });
  const quote = await prisma.quote.findUnique({
    where: { id: quoteId },
    include: {
      request: { select: { id: true, userId: true, status: true, delivery: true } },
    },
  });
  if (!quote) {
    res.status(404).json({ error: 'Quote not found' });
    return;
  }
  if (quote.request.userId !== req.user!.userId) {
    res.status(403).json({ error: 'Only the request owner can accept a quote' });
    return;
  }
  if (quote.status === 'ACCEPTED') {
    res.status(409).json({ error: 'Quote already accepted' });
    return;
  }
  if (!['PENDING', 'COUNTERED'].includes(quote.status)) {
    res.status(409).json({ error: 'Quote is not in an acceptable state' });
    return;
  }

  const finalPrice = quote.counterOffer ?? quote.price;
  const { address } = req.body as { address?: string };

  // Reject all other quotes on the same request
  await prisma.quote.updateMany({
    where: { requestId: quote.requestId, id: { not: quote.id } },
    data: { status: 'REJECTED' },
  });

  // Accept this quote
  await prisma.quote.update({ where: { id: quote.id }, data: { status: 'ACCEPTED' } });

  // Freeze the request while buyer completes payment
  await prisma.request.update({ where: { id: quote.requestId }, data: { status: 'PAYMENT_PENDING' } });

  // Create order
  const order = await prisma.order.create({
    data: {
      requestId: quote.requestId,
      quoteId: quote.id,
      buyerId: req.user!.userId,
      chefId: quote.chefId,
      finalPrice,
      paymentStatus: 'HOLD',
      holdUntil: holdExpiry(),
      address: address ?? null,
    },
    include: {
      request: { select: { id: true, dishName: true, category: true } },
      chef: { select: { id: true, name: true, avatar: true, rating: true, phone: true } },
    },
  });

  res.status(201).json(order);
});

router.post('/:id/public-accept', async (req, res) => {
  const quoteId = firstParam(req.params.id);
  if (!quoteId) return res.status(400).json({ error: 'Quote id required' });
  const schema = z.object({
    buyerToken: z.string().min(8),
    address: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const checked = await verifyBuyerTokenForQuote(quoteId, parsed.data.buyerToken);
  if ('error' in checked) {
    res.status(checked.error === 'Quote not found' ? 404 : 403).json({ error: checked.error });
    return;
  }
  const { quote } = checked;
  if (quote.status === 'ACCEPTED') {
    res.status(409).json({ error: 'Quote already accepted' });
    return;
  }
  if (!['PENDING', 'COUNTERED'].includes(quote.status)) {
    res.status(409).json({ error: 'Quote is not in an acceptable state' });
    return;
  }

  const finalPrice = quote.counterOffer ?? quote.price;

  await prisma.quote.updateMany({
    where: { requestId: quote.requestId, id: { not: quote.id } },
    data: { status: 'REJECTED' },
  });
  await prisma.quote.update({ where: { id: quote.id }, data: { status: 'ACCEPTED' } });
  await prisma.request.update({ where: { id: quote.requestId }, data: { status: 'PAYMENT_PENDING' } });

  const order = await prisma.order.create({
    data: {
      requestId: quote.requestId,
      quoteId: quote.id,
      buyerId: quote.request.userId,
      chefId: quote.chefId,
      finalPrice,
      paymentStatus: 'HOLD',
      holdUntil: holdExpiry(),
      address: parsed.data.address ?? null,
    },
    include: {
      request: { select: { id: true, dishName: true, category: true } },
      chef: { select: { id: true, name: true, avatar: true, rating: true, phone: true } },
    },
  });

  res.status(201).json(order);
});

// ── POST /api/quotes/:id/reject  (buyer rejects a single quote) ──────────────
router.post('/:id/reject', requireAuth, async (req: AuthRequest, res) => {
  const quoteId = firstParam(req.params.id);
  if (!quoteId) return res.status(400).json({ error: 'Quote id required' });
  const quote = await prisma.quote.findUnique({
    where: { id: quoteId },
    include: { request: { select: { userId: true } } },
  });
  if (!quote) {
    res.status(404).json({ error: 'Quote not found' });
    return;
  }
  if (quote.request.userId !== req.user!.userId) {
    res.status(403).json({ error: 'Only the request owner can reject quotes' });
    return;
  }
  if (!['PENDING', 'COUNTERED'].includes(quote.status)) {
    res.status(409).json({ error: 'Quote cannot be rejected in its current state' });
    return;
  }

  const updated = await prisma.quote.update({
    where: { id: quoteId },
    data: { status: 'REJECTED' },
  });
  res.json(updated);
});

router.post('/:id/public-reject', async (req, res) => {
  const quoteId = firstParam(req.params.id);
  if (!quoteId) return res.status(400).json({ error: 'Quote id required' });
  const schema = z.object({ buyerToken: z.string().min(8) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const checked = await verifyBuyerTokenForQuote(quoteId, parsed.data.buyerToken);
  if ('error' in checked) {
    res.status(checked.error === 'Quote not found' ? 404 : 403).json({ error: checked.error });
    return;
  }
  const { quote } = checked;
  if (!['PENDING', 'COUNTERED'].includes(quote.status)) {
    res.status(409).json({ error: 'Quote cannot be rejected in its current state' });
    return;
  }

  const updated = await prisma.quote.update({
    where: { id: quoteId },
    data: { status: 'REJECTED' },
  });
  res.json(updated);
});

router.post('/:id/chef-accept-counter', requireAuth, async (req: AuthRequest, res) => {
  const quoteId = firstParam(req.params.id);
  if (!quoteId) return res.status(400).json({ error: 'Quote id required' });
  const quote = await prisma.quote.findUnique({
    where: { id: quoteId },
    include: {
      request: { select: { id: true, userId: true, status: true, delivery: true } },
    },
  });
  if (!quote) {
    res.status(404).json({ error: 'Quote not found' });
    return;
  }
  if (quote.chefId !== req.user!.userId) {
    res.status(403).json({ error: 'Only the quoting chef can accept this counter' });
    return;
  }
  if (quote.status !== 'COUNTERED' || !quote.counterOffer) {
    res.status(409).json({ error: 'Buyer has not sent a counter-offer on this quote' });
    return;
  }

  await prisma.quote.updateMany({
    where: { requestId: quote.requestId, id: { not: quote.id } },
    data: { status: 'REJECTED' },
  });

  await prisma.quote.update({ where: { id: quote.id }, data: { status: 'ACCEPTED' } });
  await prisma.request.update({ where: { id: quote.requestId }, data: { status: 'PAYMENT_PENDING' } });

  const order = await prisma.order.create({
    data: {
      requestId: quote.requestId,
      quoteId: quote.id,
      buyerId: quote.request.userId,
      chefId: quote.chefId,
      finalPrice: quote.counterOffer,
      paymentStatus: 'HOLD',
      holdUntil: holdExpiry(),
      address: null,
    },
    include: {
      request: { select: { id: true, dishName: true, category: true } },
      chef: { select: { id: true, name: true, avatar: true, rating: true, phone: true } },
    },
  });

  res.status(201).json(order);
});

router.post('/:id/chef-reject-counter', requireAuth, async (req: AuthRequest, res) => {
  const quoteId = firstParam(req.params.id);
  if (!quoteId) return res.status(400).json({ error: 'Quote id required' });
  const quote = await prisma.quote.findUnique({
    where: { id: quoteId },
    select: { chefId: true, status: true, counterOffer: true },
  });
  if (!quote) {
    res.status(404).json({ error: 'Quote not found' });
    return;
  }
  if (quote.chefId !== req.user!.userId) {
    res.status(403).json({ error: 'Only the quoting chef can reject this counter' });
    return;
  }
  if (quote.status !== 'COUNTERED') {
    res.status(409).json({ error: 'Buyer has not sent a counter-offer on this quote' });
    return;
  }

  const updated = await prisma.quote.update({
    where: { id: quoteId },
    data: { status: 'REJECTED' },
  });
  res.json(updated);
});

// ── DELETE /api/quotes/:id  (chef withdraws their quote) ─────────────────────
router.delete('/:id', requireAuth, async (req: AuthRequest, res) => {
  const quoteId = firstParam(req.params.id);
  if (!quoteId) return res.status(400).json({ error: 'Quote id required' });
  const quote = await prisma.quote.findUnique({
    where: { id: quoteId },
    select: { chefId: true, status: true },
  });
  if (!quote) {
    res.status(404).json({ error: 'Quote not found' });
    return;
  }
  if (quote.chefId !== req.user!.userId) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  if (quote.status === 'ACCEPTED') {
    res.status(409).json({ error: 'Cannot withdraw an already accepted quote' });
    return;
  }

  await prisma.quote.update({ where: { id: quoteId }, data: { status: 'WITHDRAWN' } });
  res.json({ success: true });
});

export default router;
