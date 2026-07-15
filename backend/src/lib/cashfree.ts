import {
  Cashfree,
  CFEnvironment,
  type CreateOrderRequest,
  PaymentEntityPaymentStatusEnum,
  type PaymentWebhook,
} from 'cashfree-pg';

type CashfreeEnvironment = 'SANDBOX' | 'PRODUCTION';
type PaymentStage = 'initial' | 'balance';
type CashfreeEntityType = 'ORDER' | 'OFFER';

type CashfreeCustomer = {
  customerId: string;
  customerName: string;
  customerEmail?: string | null;
  customerPhone: string;
};

type CreateCashfreeOrderInput = {
  cashfreeOrderId: string;
  amount: number;
  customer: CashfreeCustomer;
  note: string;
  returnUrl?: string;
  expiresAt?: Date | null;
  tags?: Record<string, string>;
};

const CASHFREE_API_VERSION = process.env.CASHFREE_API_VERSION?.trim() || '2026-01-01';
const CASHFREE_APP_ID = process.env.CASHFREE_APP_ID?.trim() || '';
const CASHFREE_SECRET_KEY = process.env.CASHFREE_SECRET_KEY?.trim() || '';
const CASHFREE_ENV = (process.env.CASHFREE_ENV?.trim().toUpperCase() || 'SANDBOX') as CashfreeEnvironment;

function createClient(): Cashfree {
  if (!CASHFREE_APP_ID || !CASHFREE_SECRET_KEY) {
    throw new Error('Cashfree is not configured. Set CASHFREE_APP_ID and CASHFREE_SECRET_KEY.');
  }
  const client = new Cashfree(
    CASHFREE_ENV === 'PRODUCTION' ? CFEnvironment.PRODUCTION : CFEnvironment.SANDBOX,
    CASHFREE_APP_ID,
    CASHFREE_SECRET_KEY,
  );
  (client as Cashfree & { XApiVersion: string }).XApiVersion = CASHFREE_API_VERSION;
  return client;
}

let cachedClient: Cashfree | null = null;

function getClient(): Cashfree {
  if (!cachedClient) cachedClient = createClient();
  return cachedClient;
}

export function isCashfreeReady(): boolean {
  return Boolean(CASHFREE_APP_ID && CASHFREE_SECRET_KEY);
}

export function getCashfreeEnvironment(): CashfreeEnvironment {
  return CASHFREE_ENV;
}

export function generateCashfreeOrderId(entityType: CashfreeEntityType, entityId: string, stage: PaymentStage): string {
  const compactId = entityId.replace(/[^a-zA-Z0-9]/g, '').slice(-12) || 'entity';
  return `foodsood_${entityType.toLowerCase()}_${stage}_${compactId}_${Date.now()}`;
}

export async function createCashfreeOrder(input: CreateCashfreeOrderInput) {
  const request: CreateOrderRequest = {
    order_id: input.cashfreeOrderId,
    order_amount: input.amount,
    order_currency: 'INR',
    customer_details: {
      customer_id: input.customer.customerId,
      customer_name: input.customer.customerName,
      customer_email: input.customer.customerEmail || undefined,
      customer_phone: input.customer.customerPhone,
    },
    order_meta: input.returnUrl ? { return_url: input.returnUrl } : undefined,
    order_expiry_time: input.expiresAt?.toISOString(),
    order_note: input.note,
    order_tags: input.tags,
  };

  const response = await getClient().PGCreateOrder(request);
  return response.data;
}

export async function fetchCashfreeOrder(cashfreeOrderId: string) {
  const response = await getClient().PGFetchOrder(cashfreeOrderId);
  return response.data;
}

export async function fetchCashfreePayments(cashfreeOrderId: string) {
  const response = await getClient().PGOrderFetchPayments(cashfreeOrderId);
  return response.data;
}

export function findSuccessfulCashfreePayment(payments: Array<{ cf_payment_id?: string; payment_status?: string }> = []) {
  return payments.find((payment) => payment.payment_status === PaymentEntityPaymentStatusEnum.SUCCESS) ?? null;
}

export function verifyCashfreeWebhookSignature(signature: string, rawBody: string, timestamp: string) {
  return getClient().PGVerifyWebhookSignature(signature, rawBody, timestamp);
}

export function parseCashfreeWebhook(rawBody: string): PaymentWebhook {
  return JSON.parse(rawBody) as PaymentWebhook;
}
