import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  createRazorpayRefund,
  fetchRazorpayOrderPayments,
  fetchRazorpayPaymentRefunds,
  razorpayConfig,
  verifyRazorpayCheckoutSignature,
  verifyRazorpayWebhookSignature,
} from '../src/payments/razorpay.js';

const secret = 'test_key_secret_do_not_use_in_production';

test('Razorpay config requires both server credentials and never invents defaults', () => {
  assert.equal(razorpayConfig({ RAZORPAY_KEY_ID: 'rzp_test_123' } as NodeJS.ProcessEnv), null);
  const config = razorpayConfig({ RAZORPAY_KEY_ID: ' rzp_test_123 ', RAZORPAY_KEY_SECRET: ` ${secret} ` } as NodeJS.ProcessEnv);
  assert.equal(config?.keyId, 'rzp_test_123');
  assert.equal(config?.keySecret, secret);
  assert.equal(config?.baseUrl, 'https://api.razorpay.com/v1');
  assert.equal(config?.webhookSecret, null);
  assert.equal(config?.mode, 'test');
  assert.equal(razorpayConfig({ RAZORPAY_MODE: 'test', RAZORPAY_KEY_ID: 'rzp_live_123', RAZORPAY_KEY_SECRET: secret } as NodeJS.ProcessEnv), null);
  assert.equal(razorpayConfig({ RAZORPAY_MODE: 'live', RAZORPAY_KEY_ID: 'rzp_test_123', RAZORPAY_KEY_SECRET: secret } as NodeJS.ProcessEnv), null);
  assert.equal(razorpayConfig({ RAZORPAY_MODE: 'unknown', RAZORPAY_KEY_ID: 'rzp_test_123', RAZORPAY_KEY_SECRET: secret } as NodeJS.ProcessEnv), null);
});

test('checkout signature is bound to the server-held order and payment IDs', () => {
  const orderId = 'order_123abc';
  const paymentId = 'pay_456def';
  const signature = createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
  assert.equal(verifyRazorpayCheckoutSignature({ orderId, paymentId, signature, keySecret: secret }), true);
  assert.equal(verifyRazorpayCheckoutSignature({ orderId: 'order_other', paymentId, signature, keySecret: secret }), false);
  assert.equal(verifyRazorpayCheckoutSignature({ orderId, paymentId: 'pay_other', signature, keySecret: secret }), false);
  assert.equal(verifyRazorpayCheckoutSignature({ orderId, paymentId, signature: 'invalid', keySecret: secret }), false);
});

test('webhook signature is computed over the exact raw request bytes', () => {
  const rawBody = Buffer.from('{"event":"payment.captured","payload":{}}');
  const signature = createHmac('sha256', secret).update(rawBody).digest('hex');
  assert.equal(verifyRazorpayWebhookSignature(rawBody, signature, secret), true);
  assert.equal(verifyRazorpayWebhookSignature(Buffer.from(rawBody.toString() + ' '), signature, secret), false);
  assert.equal(verifyRazorpayWebhookSignature(rawBody, 'not-a-signature', secret), false);
});


test('Razorpay refund requests carry a stable provider idempotency key', async () => {
  const originalFetch = globalThis.fetch;
  let requestHeaders: Headers | undefined;
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    requestHeaders = new Headers(init?.headers);
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ id: 'rfnd_123abc', entity: 'refund', amount: 2500, payment_id: 'pay_456def', status: 'pending' }), { status: 200 });
  };
  try {
    const config = razorpayConfig({ RAZORPAY_KEY_ID: 'rzp_test_123', RAZORPAY_KEY_SECRET: secret } as NodeJS.ProcessEnv)!;
    const refund = await createRazorpayRefund(config, { paymentId: 'pay_456def', amountPaise: 2500, receipt: 'refund123', idempotencyKey: '0123456789abcdef0123456789abcdef' });
    assert.equal(refund.id, 'rfnd_123abc');
    assert.equal(requestHeaders?.get('x-refund-idempotency'), '0123456789abcdef0123456789abcdef');
    assert.equal(requestBody?.amount, 2500);
  } finally { globalThis.fetch = originalFetch; }
});

test('Razorpay order-payment lookup rejects malformed provider order IDs', async () => {
  const config = razorpayConfig({ RAZORPAY_KEY_ID: 'rzp_test_123', RAZORPAY_KEY_SECRET: secret } as NodeJS.ProcessEnv)!;
  assert.throws(() => fetchRazorpayOrderPayments(config, 'not-an-order'), /INVALID_RAZORPAY_ORDER_ID/);
});

test('Razorpay payment-refund lookup is scoped to a valid payment ID', async () => {
  const config = razorpayConfig({ RAZORPAY_KEY_ID: 'rzp_test_123', RAZORPAY_KEY_SECRET: secret } as NodeJS.ProcessEnv)!;
  assert.throws(() => fetchRazorpayPaymentRefunds(config, 'not-a-payment'), /INVALID_RAZORPAY_PAYMENT_ID/);
});

test('Razorpay refund reconciliation can list refunds for the stored payment', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  globalThis.fetch = async input => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({ entity: 'collection', count: 1, items: [{ id: 'rfnd_123abc', entity: 'refund', amount: 2500, payment_id: 'pay_456def', status: 'processed', receipt: 'refundreceipt123' }] }), { status: 200 });
  };
  try {
    const config = razorpayConfig({ RAZORPAY_KEY_ID: 'rzp_test_123', RAZORPAY_KEY_SECRET: secret } as NodeJS.ProcessEnv)!;
    const result = await fetchRazorpayPaymentRefunds(config, 'pay_456def');
    assert.equal(requestedUrl, 'https://api.razorpay.com/v1/payments/pay_456def/refunds');
    assert.equal(result.items[0]?.receipt, 'refundreceipt123');
  } finally { globalThis.fetch = originalFetch; }
});

test('live Razorpay requires explicit production identity and approval', async () => {
  const { razorpayLiveAllowed, razorpayLiveViolation } = await import('../src/payments/razorpay.js');
  const live = { RAZORPAY_MODE: 'live', RAZORPAY_KEY_ID: 'rzp_live_123', RAZORPAY_KEY_SECRET: secret };
  const approved = { ...live, NODE_ENV: 'production', DEPLOYMENT_ENV: 'production', RAZORPAY_LIVE_APPROVED: 'true' };
  // Approved production is the only environment that yields a live config.
  assert.equal(razorpayConfig(approved as NodeJS.ProcessEnv)?.mode, 'live');
  assert.equal(razorpayLiveAllowed(approved as NodeJS.ProcessEnv), true);
  assert.equal(razorpayLiveViolation(approved as NodeJS.ProcessEnv), null);
  for (const env of [
    { ...approved, DEPLOYMENT_ENV: 'staging' },
    { ...approved, DEPLOYMENT_ENV: undefined },          // NODE_ENV-derived default is not enough
    { ...approved, RAZORPAY_LIVE_APPROVED: undefined },
    { ...approved, RAZORPAY_LIVE_APPROVED: 'yes' },
    { ...approved, NODE_ENV: 'development' },
    { ...approved, NODE_ENV: 'test' },
  ]) {
    assert.equal(razorpayConfig(env as NodeJS.ProcessEnv), null, JSON.stringify(env));
    assert.match(razorpayLiveViolation(env as NodeJS.ProcessEnv) ?? '', /RAZORPAY_LIVE_APPROVED/);
  }
  // A live key pasted into a test-mode staging service is a violation even though razorpayConfig already rejects it.
  assert.ok(razorpayLiveViolation({ RAZORPAY_MODE: 'test', RAZORPAY_KEY_ID: 'rzp_live_x', DEPLOYMENT_ENV: 'staging' } as NodeJS.ProcessEnv));
  // Test mode is never a violation.
  assert.equal(razorpayLiveViolation({ RAZORPAY_MODE: 'test', RAZORPAY_KEY_ID: 'rzp_test_x', DEPLOYMENT_ENV: 'staging' } as NodeJS.ProcessEnv), null);
});
