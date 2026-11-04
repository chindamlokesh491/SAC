import { createHmac, timingSafeEqual } from 'node:crypto';

export type RazorpayConfig = {
  keyId: string;
  keySecret: string;
  webhookSecret: string | null;
  baseUrl: string;
  mode: 'test' | 'live';
};

export type RazorpayOrder = {
  id: string;
  entity: 'order';
  amount: number;
  amount_paid: number;
  amount_due: number;
  currency: string;
  receipt: string | null;
  status: 'created' | 'attempted' | 'paid';
};

export type RazorpayPayment = {
  id: string;
  entity: 'payment';
  amount: number;
  currency: string;
  status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';
  order_id: string;
  captured: boolean;
};

/**
 * Live Razorpay (real money) is permitted only for a production deployment that has
 * been explicitly approved for live payments. DEPLOYMENT_ENV must be set explicitly:
 * the NODE_ENV-derived default is not enough, so a staging service that forgets
 * DEPLOYMENT_ENV can never take live payments.
 */
export function razorpayLiveAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'production'
    && env.DEPLOYMENT_ENV?.trim() === 'production'
    && env.RAZORPAY_LIVE_APPROVED?.trim() === 'true';
}

/** Returns a reason when the environment requests live Razorpay without approval; null when safe. */
export function razorpayLiveViolation(env: NodeJS.ProcessEnv = process.env): string | null {
  const wantsLive = (env.RAZORPAY_MODE ?? '').trim() === 'live' || (env.RAZORPAY_KEY_ID ?? '').trim().startsWith('rzp_live_');
  if (!wantsLive || razorpayLiveAllowed(env)) return null;
  return 'Live Razorpay mode or a live key (rzp_live_) is configured, but live payments require NODE_ENV=production, DEPLOYMENT_ENV=production and RAZORPAY_LIVE_APPROVED=true. Staging and development must use RAZORPAY_MODE=test with rzp_test_ keys.';
}

export function razorpayConfig(env: NodeJS.ProcessEnv = process.env): RazorpayConfig | null {
  const keyId = env.RAZORPAY_KEY_ID?.trim();
  const keySecret = env.RAZORPAY_KEY_SECRET?.trim();
  if (!keyId || !keySecret) return null;
  const mode = (env.RAZORPAY_MODE || 'test').trim();
  if (mode !== 'test' && mode !== 'live') return null;
  // The mode must match the key prefix. This makes an accidental live-key paste fail closed.
  if (mode === 'test' && !keyId.startsWith('rzp_test_')) return null;
  if (mode === 'live' && !keyId.startsWith('rzp_live_')) return null;
  // Defence in depth: even if startup validation were bypassed, live mode stays off outside approved production.
  if (mode === 'live' && !razorpayLiveAllowed(env)) return null;
  return {
    keyId,
    keySecret,
    webhookSecret: env.RAZORPAY_WEBHOOK_SECRET?.trim() || null,
    baseUrl: (env.RAZORPAY_API_BASE_URL || 'https://api.razorpay.com/v1').replace(/\/$/, ''),
    mode,
  };
}

async function request<T>(config: RazorpayConfig, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${config.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.keyId}:${config.keySecret}`).toString('base64')}`,
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
    signal: AbortSignal.timeout(12_000),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = payload && typeof payload === 'object' && 'error' in payload
      ? String((payload as { error?: { code?: string } }).error?.code ?? 'PROVIDER_ERROR') : 'PROVIDER_ERROR';
    throw new Error(`RAZORPAY_${code}`);
  }
  return payload as T;
}

export function createRazorpayOrder(config: RazorpayConfig, input: { amountPaise: number; receipt: string; notes: Record<string, string> }): Promise<RazorpayOrder> {
  if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise <= 0) throw new Error('INVALID_RAZORPAY_AMOUNT');
  return request<RazorpayOrder>(config, '/orders', {
    method: 'POST',
    body: JSON.stringify({ amount: input.amountPaise, currency: 'INR', receipt: input.receipt, notes: input.notes }),
  });
}

export function fetchRazorpayPayment(config: RazorpayConfig, paymentId: string): Promise<RazorpayPayment> {
  if (!/^pay_[A-Za-z0-9]+$/.test(paymentId)) throw new Error('INVALID_RAZORPAY_PAYMENT_ID');
  return request<RazorpayPayment>(config, `/payments/${encodeURIComponent(paymentId)}`);
}

export function fetchRazorpayOrderPayments(config: RazorpayConfig, orderId: string): Promise<{ entity: 'collection'; count: number; items: RazorpayPayment[] }> {
  if (!/^order_[A-Za-z0-9]+$/.test(orderId)) throw new Error('INVALID_RAZORPAY_ORDER_ID');
  return request<{ entity: 'collection'; count: number; items: RazorpayPayment[] }>(config, `/orders/${encodeURIComponent(orderId)}/payments`);
}

export function verifyRazorpayCheckoutSignature(input: { orderId: string; paymentId: string; signature: string; keySecret: string }): boolean {
  if (!/^order_[A-Za-z0-9]+$/.test(input.orderId) || !/^pay_[A-Za-z0-9]+$/.test(input.paymentId) || !/^[a-f0-9]{64}$/i.test(input.signature)) return false;
  const expected = createHmac('sha256', input.keySecret).update(`${input.orderId}|${input.paymentId}`).digest();
  const supplied = Buffer.from(input.signature, 'hex');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function verifyRazorpayWebhookSignature(rawBody: Buffer, signature: string, webhookSecret: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = createHmac('sha256', webhookSecret).update(rawBody).digest();
  const supplied = Buffer.from(signature, 'hex');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export type RazorpayRefund = { id: string; entity: 'refund'; amount: number; payment_id: string; status: 'pending' | 'processed' | 'failed'; receipt?: string | null };

export function createRazorpayRefund(config: RazorpayConfig, input: { paymentId: string; amountPaise: number; receipt: string; idempotencyKey: string; notes?: Record<string, string> }): Promise<RazorpayRefund> {
  if (!/^pay_[A-Za-z0-9]+$/.test(input.paymentId) || !Number.isSafeInteger(input.amountPaise) || input.amountPaise <= 0 || !/^[A-Za-z0-9_-]{10,36}$/.test(input.idempotencyKey)) throw new Error('INVALID_RAZORPAY_REFUND');
  return request<RazorpayRefund>(config, `/payments/${encodeURIComponent(input.paymentId)}/refund`, {
    method: 'POST', headers: { 'X-Refund-Idempotency': input.idempotencyKey },
    body: JSON.stringify({ amount: input.amountPaise, receipt: input.receipt, notes: input.notes ?? {} }),
  });
}

export function fetchRazorpayRefund(config: RazorpayConfig, refundId: string): Promise<RazorpayRefund> {
  if (!/^rfnd_[A-Za-z0-9]+$/.test(refundId)) throw new Error('INVALID_RAZORPAY_REFUND_ID');
  return request<RazorpayRefund>(config, `/refunds/${encodeURIComponent(refundId)}`);
}

export function fetchRazorpayPaymentRefunds(config: RazorpayConfig, paymentId: string): Promise<{ entity: 'collection'; count: number; items: RazorpayRefund[] }> {
  if (!/^pay_[A-Za-z0-9]+$/.test(paymentId)) throw new Error('INVALID_RAZORPAY_PAYMENT_ID');
  return request<{ entity: 'collection'; count: number; items: RazorpayRefund[] }>(config, `/payments/${encodeURIComponent(paymentId)}/refunds`);
}
