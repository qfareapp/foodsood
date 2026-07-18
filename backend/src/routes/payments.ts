import { Router } from 'express';
import { z } from 'zod';
import {
  fetchCashfreeOrder,
  fetchCashfreePayments,
  findSuccessfulCashfreePayment,
  isCashfreeReady,
  parseCashfreeWebhook,
  verifyCashfreeWebhookSignature,
} from '../lib/cashfree';
import { notifyUsersByIds } from '../lib/fcm';
import prisma from '../lib/prisma';

const router = Router();

async function syncCashfreeOrderById(cashfreeOrderId: string) {
  const [orderRecord, offerRecord] = await Promise.all([
    prisma.order.findFirst({
      where: {
        OR: [
          { cashfreeOrderId },
          { cashfreeBalanceOrderId: cashfreeOrderId },
        ],
      },
      select: {
        id: true,
        requestId: true,
        buyerId: true,
        chefId: true,
        finalPrice: true,
        paymentStatus: true,
        paymentType: true,
        advancePaid: true,
        cashfreeOrderId: true,
        cashfreeBalanceOrderId: true,
        request: { select: { dishName: true, delivery: true } },
      },
    }),
    prisma.dishOffer.findFirst({
      where: {
        OR: [
          { cashfreeOrderId },
          { cashfreeBalanceOrderId: cashfreeOrderId },
        ],
      },
      select: {
        id: true,
        chefId: true,
        plates: true,
        offerPrice: true,
        agreedPrice: true,
        status: true,
        paymentType: true,
        advancePaid: true,
        cashfreeOrderId: true,
        cashfreeBalanceOrderId: true,
        dishName: true,
      },
    }),
  ]);

  const cfOrder = await fetchCashfreeOrder(cashfreeOrderId);
  const cfPayments = await fetchCashfreePayments(cashfreeOrderId);
  const successPayment = findSuccessfulCashfreePayment(cfPayments);
  const isPaid = cfOrder.order_status === 'PAID' || Boolean(successPayment);

  if (!orderRecord && !offerRecord) {
    throw new Error('No Foodsood payment record matches this Cashfree order');
  }

  if (!isPaid) {
    return {
      verified: false,
      cashfreeOrderId,
      gatewayOrderStatus: cfOrder.order_status ?? 'UNKNOWN',
    };
  }

  if (orderRecord) {
    const isBalance = orderRecord.cashfreeBalanceOrderId === cashfreeOrderId;
    if (isBalance) {
      const updatedOrder = await prisma.order.update({
        where: { id: orderRecord.id },
        data: {
          paymentGateway: 'CASHFREE',
          paymentStatus: 'PAID',
          balancePaidAt: new Date(),
          balancePaymentRef: successPayment?.cf_payment_id ?? cashfreeOrderId,
          cashfreeBalancePaymentId: successPayment?.cf_payment_id ?? null,
          cashfreeBalanceOrderStatus: cfOrder.order_status,
          balancePaymentConfirmedAt: new Date(),
        },
      });
      notifyUsersByIds(
        [updatedOrder.buyerId],
        `${orderRecord.request.dishName} order confirmed`,
        'Your balance payment was received and the order is confirmed.',
        { type: 'BUYER_ACTIVITY', entityType: 'REQUEST', entityId: orderRecord.requestId },
      ).catch(() => {});
    } else if (orderRecord.paymentStatus === 'HOLD') {
      const updatedOrder = await prisma.order.update({
        where: { id: orderRecord.id },
        data: {
          paymentGateway: 'CASHFREE',
          paymentStatus: orderRecord.paymentType === 'ADVANCE' ? 'ADVANCE_PAID' : 'PAID',
          status: 'CONFIRMED',
          holdUntil: null,
          paidAt: new Date(),
          paymentRef: successPayment?.cf_payment_id ?? cashfreeOrderId,
          cashfreePaymentId: successPayment?.cf_payment_id ?? null,
          cashfreeOrderStatus: cfOrder.order_status,
          paymentConfirmedAt: new Date(),
        },
      });
      notifyUsersByIds(
        [updatedOrder.buyerId],
        `${orderRecord.request.dishName} order confirmed`,
        'Payment was received and your request order is confirmed.',
        { type: 'BUYER_ACTIVITY', entityType: 'REQUEST', entityId: orderRecord.requestId },
      ).catch(() => {});
      await prisma.user.update({
        where: { id: orderRecord.chefId },
        data: { totalOrders: { increment: 1 } },
      });
    }

    return {
      verified: true,
      entityType: 'ORDER',
      internalId: orderRecord.id,
      paymentStage: isBalance ? 'balance' : 'initial',
      cashfreeOrderId,
      paymentId: successPayment?.cf_payment_id ?? null,
      gatewayOrderStatus: cfOrder.order_status ?? 'PAID',
    };
  }

  if (!offerRecord) {
    throw new Error('Offer payment resolution failed');
  }

  const isBalance = offerRecord.cashfreeBalanceOrderId === cashfreeOrderId;
  if (isBalance) {
    await prisma.dishOffer.update({
      where: { id: offerRecord.id },
      data: {
        paymentGateway: 'CASHFREE',
        status: 'PAID',
        balancePaidAt: new Date(),
        balancePaymentRef: successPayment?.cf_payment_id ?? cashfreeOrderId,
        cashfreeBalancePaymentId: successPayment?.cf_payment_id ?? null,
        cashfreeBalanceOrderStatus: cfOrder.order_status,
        balancePaymentConfirmedAt: new Date(),
      },
    });
  } else if (offerRecord.status === 'HOLD') {
    await prisma.dishOffer.update({
      where: { id: offerRecord.id },
      data: {
        paymentGateway: 'CASHFREE',
        status: offerRecord.paymentType === 'ADVANCE' ? 'ADVANCE_PAID' : 'PAID',
        holdUntil: null,
        orderStatus: 'CONFIRMED',
        paidAt: new Date(),
        paymentRef: successPayment?.cf_payment_id ?? cashfreeOrderId,
        cashfreePaymentId: successPayment?.cf_payment_id ?? null,
        cashfreeOrderStatus: cfOrder.order_status,
        paymentConfirmedAt: new Date(),
      },
    });
    await prisma.user.update({
      where: { id: offerRecord.chefId },
      data: { totalOrders: { increment: 1 } },
    });
  }

  return {
    verified: true,
    entityType: 'OFFER',
    internalId: offerRecord.id,
    paymentStage: isBalance ? 'balance' : 'initial',
    cashfreeOrderId,
    paymentId: successPayment?.cf_payment_id ?? null,
    gatewayOrderStatus: cfOrder.order_status ?? 'PAID',
  };
}

router.post('/cashfree/verify', async (req, res) => {
  if (!isCashfreeReady()) {
    res.status(503).json({ error: 'Cashfree is not configured on the server' });
    return;
  }

  const schema = z.object({ cashfreeOrderId: z.string().min(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  try {
    const result = await syncCashfreeOrderById(parsed.data.cashfreeOrderId);
    res.json(result);
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'Could not verify Cashfree payment' });
  }
});

router.post('/cashfree/webhook', async (req, res) => {
  if (!isCashfreeReady()) {
    res.status(503).json({ error: 'Cashfree is not configured on the server' });
    return;
  }

  const signature = req.header('x-webhook-signature');
  const timestamp = req.header('x-webhook-timestamp');
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  if (!signature || !timestamp || !rawBody) {
    res.status(400).json({ error: 'Invalid webhook payload' });
    return;
  }

  try {
    verifyCashfreeWebhookSignature(signature, rawBody, timestamp);
    const event = parseCashfreeWebhook(rawBody);
    const cashfreeOrderId = event.data?.order?.order_id;
    if (!cashfreeOrderId) {
      res.json({ received: true, ignored: true });
      return;
    }
    const result = await syncCashfreeOrderById(cashfreeOrderId);
    res.json({ received: true, ...result });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Webhook verification failed' });
  }
});

export default router;
