import test from 'node:test';
import assert from 'node:assert/strict';
import { securityHeaders } from '../../packages/config/next-security.mjs';

test('storefront CSP allows the Razorpay Standard Checkout origins needed by web checkout', () => {
  const headers = securityHeaders({ isDev: false, googleSignIn: true, geolocation: true, razorpayCheckout: true, formActions: ['https://api.razorpay.com'] });
  const csp = headers.find(header => header.key === 'Content-Security-Policy')?.value ?? '';
  assert.match(csp, /script-src[^;]*https:\/\/checkout\.razorpay\.com/);
  assert.match(csp, /connect-src[^;]*https:\/\/api\.razorpay\.com/);
  assert.match(csp, /frame-src[^;]*https:\/\/checkout\.razorpay\.com/);
  assert.match(csp, /form-action[^;]*https:\/\/api\.razorpay\.com/);
});

test('admin CSP does not allow Razorpay checkout unless explicitly requested', () => {
  const headers = securityHeaders({ isDev: false, noIndex: true });
  const csp = headers.find(header => header.key === 'Content-Security-Policy')?.value ?? '';
  assert.match(csp, /frame-src 'none'/);
  assert.doesNotMatch(csp, /razorpay\.com/);
});

test('admin CSP blocks Google Identity Services unless staff Google sign-in is configured', () => {
  const csp = headers => headers.find(header => header.key === 'Content-Security-Policy')?.value ?? '';
  const locked = csp(securityHeaders({ isDev: false, noIndex: true }));
  assert.doesNotMatch(locked, /accounts\.google\.com/);
  const google = csp(securityHeaders({ isDev: false, noIndex: true, googleSignIn: true }));
  assert.match(google, /script-src[^;]*https:\/\/accounts\.google\.com\/gsi\/client/);
  assert.match(google, /frame-src[^;]*https:\/\/accounts\.google\.com/);
  assert.match(google, /connect-src[^;]*https:\/\/accounts\.google\.com/);
  assert.doesNotMatch(google, /razorpay\.com/, 'enabling Google never enables payment origins');
});
