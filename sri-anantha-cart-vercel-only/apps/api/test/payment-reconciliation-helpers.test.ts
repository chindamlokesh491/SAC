import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reconciliationAmountToPaise,
  terminalPaymentOutcomeConflicts,
} from '../src/payments/reconciliation.js';

test('parses valid provider amounts into exact paise', () => {
  assert.equal(reconciliationAmountToPaise('1'), 100);
  assert.equal(reconciliationAmountToPaise('1.2'), 120);
  assert.equal(reconciliationAmountToPaise('1.20'), 120);
  assert.equal(reconciliationAmountToPaise('99999999.99'), 9_999_999_999);
});

test('rejects malformed or non-string provider amounts', () => {
  for (const value of [undefined, null, 1, 1.2, {}, [], '', ' 1.00', '1.001', '-1.00', '1e2', '100000000.00']) {
    assert.equal(reconciliationAmountToPaise(value), null, `expected ${String(value)} to be rejected`);
  }
});

test('recognizes matching and conflicting terminal payment outcomes', () => {
  assert.equal(terminalPaymentOutcomeConflicts('succeeded', 'success'), false);
  assert.equal(terminalPaymentOutcomeConflicts('succeeded', 'failure'), true);
  assert.equal(terminalPaymentOutcomeConflicts('failed', 'failure'), false);
  assert.equal(terminalPaymentOutcomeConflicts('failed', 'success'), true);
  assert.equal(terminalPaymentOutcomeConflicts('cancelled', 'failure'), false);
  assert.equal(terminalPaymentOutcomeConflicts('cancelled', 'success'), true);
});

test('refund states always require review against original transaction status', () => {
  for (const status of ['refund_pending', 'refunded']) {
    assert.equal(terminalPaymentOutcomeConflicts(status, 'success'), true);
    assert.equal(terminalPaymentOutcomeConflicts(status, 'failure'), true);
  }
});
