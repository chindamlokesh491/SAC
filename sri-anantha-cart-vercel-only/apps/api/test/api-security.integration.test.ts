import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { missingSchemaObjects } from '../src/readiness.js';
import { createHarness, skipReason, type Harness } from './support/harness.js';

/**
 * Authentication, authorisation and data-isolation guarantees, exercised against the
 * real application and a real PostgreSQL schema (no mocked SQL).
 */
describe('API security (integration)', { skip: skipReason }, () => {
  let h: Harness;
  before(async () => { h = await createHarness(); });
  after(async () => { await h?.close(); });

  describe('OTP sign-in', () => {
    it('rejects a wrong code, accepts the right one, and never returns the code', async () => {
      const requested = await h.request('POST', '/api/v1/auth/otp/request', { body: { phone: '9100000001' } });
      assert.equal(requested.status, 202);
      assert.doesNotMatch(requested.body, /\b\d{6}\b/, 'the OTP must never be sent back to the client');
      const code = h.otpCodes.get('+919100000001')!;
      const wrong = code === '000000' ? '111111' : '000000';
      const bad = await h.request('POST', '/api/v1/auth/otp/verify', { body: { phone: '9100000001', code: wrong } });
      assert.equal(bad.status, 401);
      assert.equal(bad.json.error, 'OTP_INVALID');
      const good = await h.request('POST', '/api/v1/auth/otp/verify', { body: { phone: '9100000001', code } });
      assert.equal(good.status, 200);
      assert.equal(good.json.data.user.role, 'customer');
      const reused = await h.request('POST', '/api/v1/auth/otp/verify', { body: { phone: '9100000001', code } });
      assert.equal(reused.status, 401, 'a consumed code cannot be replayed');
    });


    it('exposes only fresh staging OTPs to authenticated admins', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'sac-staging-otp-'));
      const outbox = join(dir, 'otp.jsonl');
      const phone = '+919100000009';
      const code = '381624';
      await writeFile(outbox, JSON.stringify({ phone, code, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
      const config = loadConfig({
        NODE_ENV: 'production',
        DEPLOYMENT_ENV: 'staging',
        ALLOW_DEV_OTP: 'true',
        OTP_PROVIDER: 'dev-outbox',
        OTP_DEV_OUTBOX: outbox,
        SESSION_SECRET: 'integration-test-secret-0123456789abcdef',
        MEDIA_DIR: h.mediaDir,
      });
      const app = await buildApp({ config, pool: h.pool, logger: false, rateLimit: false, sendOtp: async () => undefined });
      try {
        await app.ready();
        const admin = await h.login('9100000009', 'admin');
        const customer = await h.login('9100000013');
        const get = (token?: string) => app.inject({
          method: 'GET', url: '/api/v1/auth/otp/dev-outbox?phone=9100000009',
          ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
        });
        assert.equal((await get()).statusCode, 401);
        assert.equal((await get(customer.token)).statusCode, 403);
        const response = await get(admin.token);
        assert.equal(response.statusCode, 200);
        assert.equal(response.json().data.code, code);
        assert.match(String(response.headers['cache-control']), /no-store/);
      } finally {
        await app.close();
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('locks a challenge after repeated wrong guesses', async () => {
      await h.request('POST', '/api/v1/auth/otp/request', { body: { phone: '9100000002' } });
      const code = h.otpCodes.get('+919100000002')!;
      const wrong = code === '000000' ? '111111' : '000000';
      for (let attempt = 0; attempt < 5; attempt++) await h.request('POST', '/api/v1/auth/otp/verify', { body: { phone: '9100000002', code: wrong } });
      const late = await h.request('POST', '/api/v1/auth/otp/verify', { body: { phone: '9100000002', code } });
      assert.equal(late.status, 401, 'the right code no longer works once attempts are exhausted');
    });

    it('enforces a per-number resend cooldown and rejects non-Indian numbers', async () => {
      assert.equal((await h.request('POST', '/api/v1/auth/otp/request', { body: { phone: '9100000003' } })).status, 202);
      const again = await h.request('POST', '/api/v1/auth/otp/request', { body: { phone: '9100000003' } });
      assert.equal(again.status, 429);
      assert.equal(again.json.error, 'OTP_COOLDOWN');
      assert.equal((await h.request('POST', '/api/v1/auth/otp/request', { body: { phone: '12345' } })).status, 400);
      assert.equal((await h.request('POST', '/api/v1/auth/otp/request', { body: { phone: '9100000004', role: 'admin' } })).status, 400, 'unknown fields are rejected');
    });

    it('issues an HttpOnly cookie (not a token) to the web client', async () => {
      await h.request('POST', '/api/v1/auth/otp/request', { body: { phone: '9100000005' } });
      const verified = await h.request('POST', '/api/v1/auth/otp/verify', { headers: { 'x-sac-client': 'web' }, body: { phone: '9100000005', code: h.otpCodes.get('+919100000005') } });
      assert.equal(verified.status, 200);
      assert.equal(verified.json.data.accessToken, undefined, 'web sign-in must not expose the session token to JavaScript');
      const cookie = String(verified.headers['set-cookie']);
      assert.match(cookie, /HttpOnly/i);
      assert.match(cookie, /SameSite=Lax/i);
    });
  });

  describe('sessions', () => {
    it('requires the CSRF header for cookie-authenticated writes', async () => {
      await h.request('POST', '/api/v1/auth/otp/request', { body: { phone: '9100000006' } });
      const verified = await h.request('POST', '/api/v1/auth/otp/verify', { headers: { 'x-sac-client': 'web' }, body: { phone: '9100000006', code: h.otpCodes.get('+919100000006') } });
      const cookie = String(verified.headers['set-cookie']).split(';')[0]!;
      assert.equal((await h.request('GET', '/api/v1/me', { cookie })).status, 200);
      const forged = await h.request('PATCH', '/api/v1/me', { cookie, body: { display_name: 'Forged' } });
      assert.equal(forged.status, 403);
      assert.equal(forged.json.error, 'CSRF_CHECK_FAILED');
      const legit = await h.request('PATCH', '/api/v1/me', { cookie, headers: { 'x-sac-csrf': '1' }, body: { display_name: 'Lakshmi' } });
      assert.equal(legit.status, 200);
    });

    it('revokes the session on logout', async () => {
      const { token } = await h.login('9100000007');
      assert.equal((await h.request('GET', '/api/v1/me', { token })).status, 200);
      assert.equal((await h.request('POST', '/api/v1/auth/logout', { token })).status, 204);
      assert.equal((await h.request('GET', '/api/v1/me', { token })).status, 401);
    });

    it('reports a signed-out session without an error and rejects forged tokens', async () => {
      const anonymous = await h.request('GET', '/api/v1/session');
      assert.equal(anonymous.status, 200);
      assert.equal(anonymous.json.data, null);
      assert.equal((await h.request('GET', '/api/v1/me', { token: 'not-a-real-token' })).status, 401);
    });

    it('blocking a customer ends their sessions and prevents sign-in', async () => {
      const admin = await h.login('9100000010', 'admin');
      const customer = await h.login('9100000011');
      const blocked = await h.request('PATCH', `/api/v1/admin/customers/${customer.userId}/status`, { token: admin.token, body: { blocked: true, reason: 'Fraud' } });
      assert.equal(blocked.status, 200);
      assert.equal((await h.request('GET', '/api/v1/me', { token: customer.token })).status, 401);
      await h.pool.query('DELETE FROM otp_challenges WHERE phone_e164 = $1', ['+919100000011']);
      await h.request('POST', '/api/v1/auth/otp/request', { body: { phone: '9100000011' } });
      const retry = await h.request('POST', '/api/v1/auth/otp/verify', { body: { phone: '9100000011', code: h.otpCodes.get('+919100000011') } });
      assert.equal(retry.status, 403);
      assert.equal(retry.json.error, 'ACCOUNT_DISABLED');
    });

    it('a customer cannot raise their own role or change their phone through the profile', async () => {
      const { token } = await h.login('9100000012');
      const attempt = await h.request('PATCH', '/api/v1/me', { token, body: { role: 'admin' } });
      assert.equal(attempt.status, 400);
      const phone = await h.request('PATCH', '/api/v1/me', { token, body: { phone_e164: '+919999999999' } });
      assert.equal(phone.status, 400);
      assert.equal((await h.request('GET', '/api/v1/me', { token })).json.data.role, 'customer');
    });
  });

  describe('admin authorisation', () => {
    const sample = (url: string) => url.replace(/:[A-Za-z]+/g, '00000000-0000-4000-8000-000000000000');

    it('every admin route rejects anonymous callers (401) and customers (403)', async () => {
      const { token } = await h.login('9100000020');
      const adminRoutes = h.routes.filter(route => route.url.startsWith('/api/v1/admin') && route.method !== 'HEAD' && route.method !== 'OPTIONS');
      assert.ok(adminRoutes.length >= 40, `expected the full admin surface, found ${adminRoutes.length} routes`);
      for (const route of adminRoutes) {
        const url = sample(route.url);
        const anonymous = await h.request(route.method, url, { body: route.method === 'GET' || route.method === 'DELETE' ? undefined : {} });
        assert.equal(anonymous.status, 401, `${route.method} ${route.url} without a session`);
        const customer = await h.request(route.method, url, { token, body: route.method === 'GET' || route.method === 'DELETE' ? undefined : {} });
        assert.equal(customer.status, 403, `${route.method} ${route.url} as a customer`);
      }
    });

    it('operators can fulfil orders but cannot change catalogue, settings, refunds, customers or reports', async () => {
      const operator = await h.login('9100000021', 'operator');
      assert.equal((await h.request('GET', '/api/v1/admin/orders', { token: operator.token })).status, 200);
      assert.equal((await h.request('GET', '/api/v1/admin/dashboard', { token: operator.token })).status, 200);
      const forbidden: [string, string][] = [
        ['POST', '/api/v1/admin/products'],
        ['PUT', '/api/v1/admin/settings/payments'],
        ['POST', '/api/v1/admin/categories'],
        ['POST', '/api/v1/admin/inventory/adjustments'],
        ['PATCH', `/api/v1/admin/customers/${operator.userId}/status`],
        ['GET', '/api/v1/admin/reports/summary'],
        ['POST', '/api/v1/admin/media'],
        ['POST', '/api/v1/admin/delivery-zones'],
        ['PATCH', '/api/v1/admin/orders/00000000-0000-4000-8000-000000000000/return-decision'],
        ['POST', '/api/v1/admin/orders/00000000-0000-4000-8000-000000000000/refunds'],
      ];
      for (const [method, url] of forbidden) {
        const response = await h.request(method, url, { token: operator.token, body: method === 'GET' ? undefined : {} });
        assert.equal(response.status, 403, `${method} ${url} as operator`);
      }
    });

    it('roles cannot be granted over HTTP', async () => {
      const grantingRoutes = h.routes.filter(route => /role|grant|invite|staff\/(create|register|add)/i.test(route.url));
      assert.deepEqual(grantingRoutes, []);
      const staffAuth = h.routes.filter(route => route.url.startsWith('/api/v1/auth/staff')).map(route => route.url).sort();
      // Google routes sign in or link an already-provisioned staff account only; they never create
      // accounts or change roles (covered by 'staff Google routes cannot create or elevate accounts').
      assert.deepEqual([...new Set(staffAuth)], ['/api/v1/auth/staff/google', '/api/v1/auth/staff/google/link', '/api/v1/auth/staff/login', '/api/v1/auth/staff/password', '/api/v1/auth/staff/phone']);
      const { token } = await h.login('9100000022');
      const attempt = await h.request('POST', '/api/v1/auth/staff/login', { body: { phone: '9100000022', password: 'Anything-123', role: 'admin' } });
      assert.equal(attempt.status, 400, 'unknown fields such as role are rejected');
      assert.equal((await h.request('GET', '/api/v1/me', { token })).json.data.role, 'customer');
    });
  });

  describe('customer data isolation', () => {
    it('one customer cannot read or change another customer\'s orders, invoices, addresses or cart', async () => {
      const category = await h.seed.category();
      const product = await h.seed.product({ categoryId: category, price: 10000, stock: 50 });
      await h.seed.zone({ postal: ['517501'] });
      const alice = await h.login('9100000030');
      const bob = await h.login('9100000031');
      const aliceAddress = await h.seed.address(alice.token);
      const placed = await h.placeOrder(alice.token, aliceAddress, [{ product_id: product.id, quantity: 1 }]);
      assert.equal(placed.status, 201, placed.body);
      const orderId = placed.json.data.order_id as string;
      const reference = placed.json.data.order_number as string;

      for (const url of [`/api/v1/orders/${orderId}`, `/api/v1/orders/${orderId}/invoice`, `/api/v1/orders/track?reference=${reference}`]) {
        const response = await h.request('GET', url, { token: bob.token });
        assert.equal(response.status, 404, `${url} must look identical to a missing order`);
      }
      assert.equal((await h.request('POST', `/api/v1/orders/${orderId}/return-request`, { token: bob.token, body: { reason: 'Not mine' } })).status, 404);
      assert.equal((await h.request('GET', '/api/v1/orders', { token: bob.token })).json.data.length, 0);

      assert.equal((await h.request('PATCH', `/api/v1/addresses/${aliceAddress}`, { token: bob.token, body: { line1: 'Hijacked' } })).status, 404);
      assert.equal((await h.request('DELETE', `/api/v1/addresses/${aliceAddress}`, { token: bob.token })).status, 404);
      assert.equal((await h.request('GET', '/api/v1/addresses', { token: bob.token })).json.data.length, 0);
      const bobCheckout = await h.request('POST', '/api/v1/orders/checkout', {
        token: bob.token, headers: { 'idempotency-key': 'bob-uses-alice-address' },
        body: { address_id: aliceAddress, delivery: { mode: 'express' }, payment_method: 'cod', expected_total_paise: 13000 },
      });
      assert.notEqual(bobCheckout.status, 201, 'an order cannot be shipped to someone else\'s saved address');
      const bobQuote = await h.request('GET', `/api/v1/cart?address_id=${aliceAddress}`, { token: bob.token });
      assert.notEqual(bobQuote.status, 200, 'another customer\'s address cannot be used for a quote');

      await h.request('POST', '/api/v1/cart/items', { token: alice.token, body: { product_id: product.id, quantity: 2 } });
      const aliceCart = await h.request('GET', '/api/v1/cart', { token: alice.token });
      const lineId = aliceCart.json.data.lines[0].cart_item_id as string;
      const bobDelete = await h.request('DELETE', `/api/v1/cart/items/${lineId}`, { token: bob.token });
      assert.equal(bobDelete.json.data.lines.length, 0, 'deleting is scoped to the caller\'s own cart');
      assert.equal((await h.request('GET', '/api/v1/cart', { token: alice.token })).json.data.lines.length, 1);
    });

    it('requires sign-in for cart, checkout, orders, addresses and wishlist (no guest cart)', async () => {
      for (const [method, url] of [['GET', '/api/v1/cart'], ['POST', '/api/v1/cart/items'], ['POST', '/api/v1/orders/checkout'], ['GET', '/api/v1/orders'], ['GET', '/api/v1/addresses'], ['GET', '/api/v1/wishlist']] as const) {
        assert.equal((await h.request(method, url, { body: method === 'POST' ? {} : undefined })).status, 401, `${method} ${url}`);
      }
    });

    it('public catalogue responses never include cost, stock counts beyond availability, or customer data', async () => {
      const category = await h.seed.category();
      const product = await h.seed.product({ categoryId: category, price: 5000, stock: 7 });
      const detail = await h.request('GET', `/api/v1/products/${product.slug}`);
      assert.equal(detail.status, 200);
      const text = detail.body;
      for (const secret of ['minimum_stock_level', 'phone_e164', 'created_by', 'idempotency', 'token']) assert.ok(!text.includes(secret), `public product leaks ${secret}`);
      const config = await h.request('GET', '/api/v1/store/config');
      assert.ok(!/salt|merchant_key|secret|gstin_secret/i.test(config.body));
    });

  });

  describe('input hardening', () => {
    it('malformed identifiers return 400/404, never 500', async () => {
      const { token } = await h.login('9100000040');
      const admin = await h.login('9100000041', 'admin');
      const probes: [string, string, string | undefined][] = [
        ['GET', '/api/v1/orders/not-a-uuid', token],
        ['GET', '/api/v1/orders/not-a-uuid/invoice', token],
        ['GET', '/api/v1/orders/track?reference=%27%3B--', token],
        ['GET', '/api/v1/products/%27%20OR%201%3D1', undefined],
        ['PATCH', '/api/v1/addresses/xyz', token],
        ['DELETE', '/api/v1/cart/items/xyz', token],
        ['GET', '/api/v1/admin/orders/xyz', admin.token],
        ['GET', '/api/v1/admin/products/xyz', admin.token],
        ['GET', '/api/v1/admin/customers/xyz', admin.token],
        ['GET', '/api/v1/admin/inventory/xyz/movements', admin.token],
        ['GET', '/api/v1/admin/orders?from=yesterday', admin.token],
      ];
      for (const [method, url, auth] of probes) {
        const response = await h.request(method, url, { token: auth, body: method === 'PATCH' ? { line1: 'x' } : undefined });
        assert.ok(response.status >= 400 && response.status < 500, `${method} ${url} returned ${response.status}`);
      }
    });

    it('media serving is restricted to generated file names (no path traversal)', async () => {
      for (const file of ['..%2F..%2Fetc%2Fpasswd', '..%2Fpackage.json', 'x.svg', '%2Fetc%2Fpasswd']) {
        assert.equal((await h.request('GET', `/media/${file}`)).status, 404, file);
      }
    });

    it('internal errors are not leaked to the caller', async () => {
      const response = await h.request('POST', '/api/v1/auth/otp/verify', { headers: { 'content-type': 'application/json' }, body: '{"phone":' });
      assert.equal(response.status, 400);
      assert.ok(!/stack|at .+\.ts|node_modules/i.test(response.body));
    });
  });

  describe('rate limiting', () => {
    it('limits per client IP behind one trusted proxy, ignores spoofed X-Forwarded-For, and exempts only the web server token', async () => {
      const token = 'web-server-internal-token-0123456789abcdef';
      const config = loadConfig({ NODE_ENV: 'test', SESSION_SECRET: 'integration-test-secret-0123456789abcdef', TRUST_PROXY: '1', INTERNAL_API_TOKEN: token, MEDIA_DIR: h.mediaDir });
      const app = await buildApp({ config, pool: h.pool, logger: false, rateLimit: true });
      try {
        const hit = (headers: Record<string, string>) => app.inject({ method: 'GET', url: '/api/v1/store/config', headers, remoteAddress: '10.0.0.5' }).then(response => response.statusCode);
        // The proxy appends the real client address last; anything before it is client-controlled.
        for (let i = 0; i < 300; i++) assert.equal(await hit({ 'x-forwarded-for': `1.1.1.${i % 250}, 203.0.113.7` }), 200);
        assert.equal(await hit({ 'x-forwarded-for': '9.9.9.9, 203.0.113.7' }), 429, 'rotating a spoofed prefix does not reset the limit');
        assert.equal(await hit({ 'x-forwarded-for': '203.0.113.8' }), 200, 'other shoppers are unaffected');
        assert.equal(await hit({ 'x-forwarded-for': '203.0.113.7', 'x-sac-internal': token }), 200, 'the web server token is exempt');
        assert.equal(await hit({ 'x-forwarded-for': '203.0.113.7', 'x-sac-internal': 'guess-guess-guess-guess-guess-guess-guess' }), 429);
      } finally {
        await app.close();
      }
    });
  });

  describe('database schema', () => {
    it('a freshly migrated database satisfies the readiness contract', async () => {
      assert.deepEqual(await missingSchemaObjects(h.pool), { tables: [], columns: [] });
    });
    it('the audit log is append-only and order amounts cannot be rewritten, even with direct database access', async () => {
      const admin = await h.login('9100000050', 'admin');
      const category = await h.seed.category();
      await h.request('PATCH', `/api/v1/admin/categories/${category}`, { token: admin.token, body: { sort_order: 3 } });
      const entry = (await h.pool.query(`SELECT id FROM admin_audit_logs ORDER BY created_at DESC LIMIT 1`)).rows[0];
      await assert.rejects(h.pool.query(`UPDATE admin_audit_logs SET action = 'nothing' WHERE id = $1`, [entry.id]), /append-only/);
      await assert.rejects(h.pool.query('DELETE FROM admin_audit_logs WHERE id = $1', [entry.id]), /append-only/);

      const product = await h.seed.product({ categoryId: category, price: 10000, stock: 5 });
      await h.seed.zone({ postal: ['517501'] });
      const customer = await h.login('9100000051');
      const placed = await h.placeOrder(customer.token, await h.seed.address(customer.token), [{ product_id: product.id, quantity: 1 }]);
      const orderId = placed.json.data.order_id as string;
      await assert.rejects(h.pool.query('UPDATE orders SET total_paise = 1, subtotal_paise = 1, delivery_fee_paise = 0 WHERE id = $1', [orderId]), /cannot be changed/);
      await assert.rejects(h.pool.query('UPDATE order_items SET unit_price_paise = 1, line_total_paise = 1 WHERE order_id = $1', [orderId]), /cannot be changed/);
      await assert.rejects(h.pool.query('DELETE FROM order_items WHERE order_id = $1', [orderId]), /cannot be removed/);
      await h.pool.query(`UPDATE orders SET status = 'accepted' WHERE id = $1`, [orderId]);
    });

    it('database constraints reject impossible orders and negative stock even if application code is bypassed', async () => {
      const category = await h.seed.category();
      const product = await h.seed.product({ categoryId: category, price: 1000, stock: 1 });
      await assert.rejects(h.pool.query('UPDATE inventory SET quantity = -1 WHERE product_id = $1', [product.id]));
      await assert.rejects(h.pool.query('UPDATE products SET price_paise = -5 WHERE id = $1', [product.id]));
    });
  });

  describe('production configuration', () => {
    const base = { NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(48), OTP_PROVIDER: 'http' };
    it('refuses unsafe production settings', () => {
      assert.throws(() => loadConfig({ ...base, SESSION_SECRET: 'short' }), /SESSION_SECRET/);
      assert.throws(() => loadConfig({ ...base, OTP_PROVIDER: 'dev-outbox', OTP_DEV_OUTBOX: '/tmp/x' }), /OTP_PROVIDER/);
      assert.throws(() => loadConfig({ ...base, COOKIE_SECURE: 'false' }), /COOKIE_SECURE/);
      assert.throws(() => loadConfig({ ...base, DEV_DISABLE_RATE_LIMIT: 'true' }), /DEV_DISABLE_RATE_LIMIT/);
      assert.throws(() => loadConfig({ ...base, PUBLIC_WEB_URL: 'http://example.com' }), /https/);
    });
    it('accepts a safe production configuration with secure cookies by default', () => {
      const config = loadConfig({ ...base, PUBLIC_WEB_URL: 'https://srianantha.example' });
      assert.equal(config.cookieSecure, true);
      assert.equal(config.onlinePaymentsEnabled, false, 'online payments stay off until explicitly enabled');
    });
  });
});
