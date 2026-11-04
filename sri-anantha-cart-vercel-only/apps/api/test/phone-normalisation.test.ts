import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeIndianPhone } from '../src/auth/security.js';

test('normalises Indian mobile numbers to E.164', () => {
  for (const input of ['9876543210', '+91 98765 43210', '919876543210', '09876543210', '(98765) 43210']) {
    assert.equal(normalizeIndianPhone(input), '+919876543210', input);
  }
});

test('treats a 10-digit number starting with 91 as the subscriber number, not a country code', () => {
  assert.equal(normalizeIndianPhone('9100000001'), '+919100000001');
  assert.equal(normalizeIndianPhone('919100000001'), '+919100000001');
});

test('rejects landlines, short numbers and foreign numbers', () => {
  for (const input of ['12345', '0402345678', '5876543210', '+14155550123', '+4420794600000', 'abcdefghij', '']) {
    assert.equal(normalizeIndianPhone(input), null, input);
  }
});
