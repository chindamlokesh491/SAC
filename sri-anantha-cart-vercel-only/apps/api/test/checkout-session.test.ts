import test from 'node:test';
import assert from 'node:assert/strict';
import { isCheckoutSessionExpired, isReusablePaymentStatus } from '../src/payments/checkout-session.js';

const now = Date.parse('2026-10-27T10:00:00.000Z');

test('accepts an unexpired checkout session', () => {
  assert.equal(isCheckoutSessionExpired('2026-10-27T10:15:00.000Z', now), false);
  assert.equal(isCheckoutSessionExpired(new Date('2026-10-27T10:15:00.000Z'), now), false);
});

test('treats an expiry equal to now as expired', () => {
  assert.equal(isCheckoutSessionExpired('2026-10-27T10:00:00.000Z', now), true);
});

test('rejects expired, missing, and malformed checkout expiries', () => {
  assert.equal(isCheckoutSessionExpired('2026-10-27T09:59:59.000Z', now), true);
  assert.equal(isCheckoutSessionExpired(null, now), true);
  assert.equal(isCheckoutSessionExpired(undefined, now), true);
  assert.equal(isCheckoutSessionExpired('not-a-date', now), true);
});

test('only created or pending payment records can reuse a checkout session', () => {
  assert.equal(isReusablePaymentStatus('created'), true);
  assert.equal(isReusablePaymentStatus('pending'), true);
  for (const status of ['succeeded', 'failed', 'cancelled', 'refund_pending', 'refunded', null, undefined, 1]) {
    assert.equal(isReusablePaymentStatus(status), false, `status ${String(status)} must not reuse checkout`);
  }
});
