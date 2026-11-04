import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveRefundOrderState } from '../src/payments/refund-state.js';

test('does not double-count the just-completed refund when deciding full refund', () => {
  const state = deriveRefundOrderState({
    currentStatus: 'refund_initiated', cancellationReason: 'customer request', returnReason: null,
    orderTotalPaise: 10000, completedRefundPaise: 10000, pendingRefundPaise: 0,
  });
  assert.equal(state.fullyRefunded, true);
  assert.equal(state.paymentStatus, 'refunded');
  assert.equal(state.orderStatus, 'refunded');
});

test('keeps payment pending while another refund is still processing', () => {
  const state = deriveRefundOrderState({
    currentStatus: 'refund_initiated', cancellationReason: null, returnReason: 'damaged item',
    orderTotalPaise: 10000, completedRefundPaise: 4000, pendingRefundPaise: 2000,
  });
  assert.equal(state.fullyRefunded, false);
  assert.equal(state.paymentStatus, 'refund_pending');
  assert.equal(state.orderStatus, 'refund_initiated');
  assert.equal(state.totalRefundExposurePaise, 6000);
});

test('restores cancelled order after a partial refund finishes with no pending refund', () => {
  const state = deriveRefundOrderState({
    currentStatus: 'refund_initiated', cancellationReason: 'duplicate order', returnReason: null,
    orderTotalPaise: 10000, completedRefundPaise: 2500, pendingRefundPaise: 0,
  });
  assert.equal(state.paymentStatus, 'paid');
  assert.equal(state.orderStatus, 'cancelled');
  assert.equal(state.fullyRefunded, false);
});

test('restores delivered order after a partial return refund finishes', () => {
  const state = deriveRefundOrderState({
    currentStatus: 'refund_initiated', cancellationReason: null, returnReason: 'damaged item',
    orderTotalPaise: 10000, completedRefundPaise: 2500, pendingRefundPaise: 0,
  });
  assert.equal(state.paymentStatus, 'paid');
  assert.equal(state.orderStatus, 'delivered');
});
