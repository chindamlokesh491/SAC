// Client-acceptance demo data for LOCAL or STAGING databases only.
//
//   ACCEPTANCE_SEED_CONFIRM=yes DATABASE_URL=... pnpm --filter @sac/api seed:acceptance
//
// Optional: ACCEPTANCE_CUSTOMER_PHONE, ACCEPTANCE_ADMIN_PHONE, ACCEPTANCE_PARTNER_PHONE (10-digit numbers;
// defaults 9000000201/202/203). Requires the demo catalogue and Tirupati delivery zone (pnpm --filter @sac/api seed:demo)
// and a built API (pnpm --filter @sac/api build).
//
// Everything is created through the application's own routes, in-process, so every order goes through real
// checkout, stock reservation, the partner workflow, returns and refunds. Nothing is sent by SMS: sign-in and
// delivery codes are captured in memory. No payment gateway is called (COD and manual refunds only).
//
// Creates:
//   - a demo customer, a demo delivery partner (SMS-code sign-in, no password), and a demo admin whose
//     one-time temporary password is printed once and must be changed at first sign-in;
//   - orders in each state: placed, packed and assigned (ready for the live partner demo), delivered (COD),
//     cancelled, delivered with a return request awaiting review, and a received return with a refund recorded.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { databaseSslOptions } from './lib/db-ssl.mjs';
import { hashPassword, temporaryPassword } from './lib/password-hash.mjs';

pg.types.setTypeParser(20, value => Number(value));

const fail = message => { console.error(`seed:acceptance refused: ${message}`); process.exit(1); };
if (process.env.ACCEPTANCE_SEED_CONFIRM !== 'yes') fail('set ACCEPTANCE_SEED_CONFIRM=yes to confirm this is a local or staging database.');
if ((process.env.DEPLOYMENT_ENV ?? '').trim() === 'production') fail('DEPLOYMENT_ENV=production. Demo data never goes into production.');
if (!process.env.DATABASE_URL) fail('DATABASE_URL is required.');

const phone = (name, fallback) => {
  const value = (process.env[name] ?? fallback).replace(/\D/g, '');
  if (!/^[6-9]\d{9}$/.test(value)) fail(`${name} must be a 10-digit Indian mobile number.`);
  return value;
};
const customerPhone = phone('ACCEPTANCE_CUSTOMER_PHONE', '9000000201');
const adminPhone = phone('ACCEPTANCE_ADMIN_PHONE', '9000000202');
const partnerPhone = phone('ACCEPTANCE_PARTNER_PHONE', '9000000203');
if (new Set([customerPhone, adminPhone, partnerPhone]).size !== 3) fail('the three demo phone numbers must be different.');

const { buildApp } = await import('../dist/app.js').catch(() => fail('build the API first: pnpm --filter @sac/api build'));
const { loadConfig } = await import('../dist/config.js');

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5, ...databaseSslOptions(process.env) });
const mediaDir = await mkdtemp(join(tmpdir(), 'sac-acceptance-'));
const codes = new Map();
const demoPhones = [`+91${customerPhone}`, `+91${adminPhone}`, `+91${partnerPhone}`];
let app;
let adminId = null;
try {
  const catalogue = (await pool.query(`SELECT (SELECT count(*) FROM products WHERE is_active) AS products,
      (SELECT count(*) FROM delivery_zones WHERE is_active AND '517501' = ANY(postal_codes)) AS zones`)).rows[0];
  if (!catalogue.products || !catalogue.zones) fail('run pnpm --filter @sac/api seed:demo first (demo catalogue and Tirupati zone 517501).');

  const roles = (await pool.query(`SELECT phone_e164, role FROM users WHERE phone_e164 = ANY($1)`, [[`+91${customerPhone}`, `+91${adminPhone}`, `+91${partnerPhone}`]])).rows;
  const expected = { [`+91${customerPhone}`]: 'customer', [`+91${adminPhone}`]: 'admin', [`+91${partnerPhone}`]: 'delivery_partner' };
  for (const row of roles) if (row.role !== expected[row.phone_e164]) fail(`${row.phone_e164} already exists as ${row.role}; choose another number.`);
  const existingOrders = (await pool.query(`SELECT count(*) AS n FROM orders o JOIN users u ON u.id = o.user_id WHERE u.phone_e164 = $1`, [`+91${customerPhone}`])).rows[0].n;
  if (existingOrders > 0 && process.env.ACCEPTANCE_SEED_FORCE !== 'yes') fail(`the demo customer already has ${existingOrders} orders. Set ACCEPTANCE_SEED_FORCE=yes to add another set.`);

  // Demo admin: used by this script, then left with a temporary password that must be changed at first sign-in.
  const adminTemp = temporaryPassword();
  const admin = (await pool.query(
    `INSERT INTO users (phone_e164, role, display_name, password_hash, must_change_password, password_changed_at)
     VALUES ($1, 'admin', 'Demo Admin', $2, FALSE, now())
     ON CONFLICT (phone_e164) DO UPDATE SET role = 'admin', password_hash = EXCLUDED.password_hash, must_change_password = FALSE,
       is_active = TRUE, failed_login_attempts = 0, locked_until = NULL, updated_at = now()
     RETURNING id`, [`+91${adminPhone}`, await hashPassword(adminTemp)])).rows[0];
  adminId = admin.id;
  const partner = (await pool.query(
    `INSERT INTO users (phone_e164, role, display_name) VALUES ($1, 'delivery_partner', 'Demo Delivery Partner')
     ON CONFLICT (phone_e164) DO UPDATE SET role = 'delivery_partner', password_hash = NULL, must_change_password = FALSE, is_active = TRUE, updated_at = now()
     RETURNING id`, [`+91${partnerPhone}`])).rows[0];

  const config = loadConfig({ NODE_ENV: 'development', SESSION_SECRET: randomBytes(32).toString('hex'), CHECKOUT_ENABLED: 'true', ONLINE_PAYMENTS_ENABLED: 'false', MEDIA_DIR: mediaDir, OTP_PROVIDER: 'none' });
  app = await buildApp({ config, pool, logger: false, rateLimit: false, sendOtp: async (to, code) => { codes.set(to, code); return {}; } });
  await app.ready();

  const call = async (method, url, { token, body, headers = {} } = {}) => {
    const response = await app.inject({ method, url, headers: { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { payload: body } : {}) });
    const json = response.body ? JSON.parse(response.body) : {};
    if (response.statusCode >= 400) throw new Error(`${method} ${url} -> ${response.statusCode} ${response.body}`);
    return json;
  };

  // Sessions used by this script only; all are revoked at the end.
  await call('POST', '/api/v1/auth/otp/request', { body: { phone: customerPhone } });
  const customer = (await call('POST', '/api/v1/auth/otp/verify', { body: { phone: customerPhone, code: codes.get(`+91${customerPhone}`) } })).data;
  await call('PATCH', '/api/v1/me', { token: customer.accessToken, body: { display_name: 'Demo Customer' } });
  const adminToken = (await call('POST', '/api/v1/auth/staff/login', { body: { phone: adminPhone, password: adminTemp } })).data.accessToken;
  await call('POST', '/api/v1/delivery/auth/request-otp', { body: { phone: partnerPhone } });
  const partnerToken = (await call('POST', '/api/v1/delivery/auth/verify-otp', { body: { phone: partnerPhone, code: codes.get(`+91${partnerPhone}`) } })).data.accessToken;

  const address = (await call('POST', '/api/v1/addresses', { token: customer.accessToken, body: {
    recipient_name: 'Demo Customer', phone_e164: customerPhone, line1: '12 Gandhi Road', locality: 'Balaji Colony', postal_code: '517501',
  } })).data;
  const products = (await call('GET', '/api/v1/products?in_stock=true&limit=24')).data.filter(product => !product.has_variants);
  if (products.length < 3) fail('the demo catalogue needs at least three in-stock products without variants.');

  const placeOrder = async (index, quantity = 1) => {
    await call('POST', '/api/v1/cart/items', { token: customer.accessToken, body: { product_id: products[index % products.length].id, variant_id: null, quantity } });
    let quote = (await call('GET', `/api/v1/cart?address_id=${address.id}`, { token: customer.accessToken })).data;
    // Respect the zone's configured minimum order by adding further demo items, never by bypassing the rule.
    for (let extra = 1; quote.problems.includes('MINIMUM_ORDER_NOT_MET') && extra < products.length; extra++) {
      await call('POST', '/api/v1/cart/items', { token: customer.accessToken, body: { product_id: products[(index + extra) % products.length].id, variant_id: null, quantity: 1 } });
      quote = (await call('GET', `/api/v1/cart?address_id=${address.id}`, { token: customer.accessToken })).data;
    }
    const delivery = quote.delivery.express.available ? { mode: 'express' } : { mode: 'scheduled', slot_id: quote.delivery.scheduled[0].slot_id, date: quote.delivery.scheduled[0].date };
    const placed = (await call('POST', '/api/v1/orders/checkout', { token: customer.accessToken, headers: { 'idempotency-key': `acceptance-${randomUUID()}` },
      body: { address_id: address.id, delivery, payment_method: 'cod', expected_total_paise: quote.total_paise } })).data;
    return placed.order_id;
  };
  const staff = (orderId, status) => call('PATCH', `/api/v1/admin/orders/${orderId}/status`, { token: adminToken, body: { status } });
  const prepare = async orderId => {
    await staff(orderId, 'accepted'); await staff(orderId, 'packed');
    await call('POST', `/api/v1/admin/orders/${orderId}/delivery-assignment`, { token: adminToken, body: { delivery_person_id: partner.id } });
  };
  const deliver = async orderId => {
    await prepare(orderId);
    await call('POST', `/api/v1/delivery/me/orders/${orderId}/accept`, { token: partnerToken, body: {} });
    await call('POST', `/api/v1/delivery/me/orders/${orderId}/pickup`, { token: partnerToken, body: {} });
    await call('POST', `/api/v1/delivery/me/orders/${orderId}/verify-otp`, { token: partnerToken, body: { otp: codes.get(`+91${customerPhone}`) } });
    const detail = (await call('GET', `/api/v1/delivery/me/orders/${orderId}`, { token: partnerToken })).data;
    if (detail.payment.codAmount) await call('POST', `/api/v1/delivery/me/orders/${orderId}/cod-collection`, { token: partnerToken, body: { amount: detail.payment.codAmount } });
  };

  const created = [];
  const record = async (orderId, scenario) => {
    const row = (await pool.query(`SELECT order_number, status, payment_status FROM orders WHERE id = $1`, [orderId])).rows[0];
    created.push({ order: `SA${row.order_number + 10_000}`, scenario, status: row.status, payment: row.payment_status });
  };

  const placedOnly = await placeOrder(0); await record(placedOnly, 'Placed: accept, pack and assign it in the admin panel');
  const assigned = await placeOrder(1, 2); await prepare(assigned); await record(assigned, 'Packed and assigned: the partner accepts, picks up and delivers live');
  const delivered = await placeOrder(2); await deliver(delivered); await record(delivered, 'Delivered (COD collected by the partner)');
  const cancelled = await placeOrder(0); await call('POST', `/api/v1/admin/orders/${cancelled}/cancel`, { token: adminToken, body: { reason: 'Customer asked to cancel (demo)' } });
  await record(cancelled, 'Cancelled before dispatch (stock restored)');
  const returnRequested = await placeOrder(1); await deliver(returnRequested);
  await call('POST', `/api/v1/orders/${returnRequested}/return-request`, { token: customer.accessToken, body: { reason: 'The lamp arrived dented (demo)' } });
  await record(returnRequested, 'Return requested: approve or reject it in Returns');
  const refunded = await placeOrder(2); await deliver(refunded);
  await call('POST', `/api/v1/orders/${refunded}/return-request`, { token: customer.accessToken, body: { reason: 'Wrong item received (demo)' } });
  await call('PATCH', `/api/v1/admin/orders/${refunded}/return-decision`, { token: adminToken, body: { decision: 'approve', reason: 'Photos reviewed (demo)' } });
  await call('PATCH', `/api/v1/admin/orders/${refunded}/return-status`, { token: adminToken, body: { status: 'pickup_scheduled', pickup_method: 'self_dropoff', note: 'Customer drop-off at the store' } });
  await call('PATCH', `/api/v1/admin/orders/${refunded}/return-status`, { token: adminToken, body: { status: 'picked_up', pickup_reference: 'DEMO-DROP-001' } });
  await call('PATCH', `/api/v1/admin/orders/${refunded}/return-status`, { token: adminToken, body: { status: 'received', note: 'Item inspected and received' } });
  const refundable = (await call('GET', `/api/v1/admin/orders/${refunded}`, { token: adminToken })).data.actions.refundable_paise;
  await call('POST', `/api/v1/admin/orders/${refunded}/refunds`, { token: adminToken, headers: { 'idempotency-key': `acceptance-refund-${randomUUID()}` }, body: { amount_paise: refundable, reason: 'Return refund (demo, manual)' } });
  await record(refunded, 'Return received, manual refund recorded (mark it completed in Refunds)');

  await pool.query(`INSERT INTO admin_audit_logs (action, resource_type, resource_id, metadata) VALUES ('acceptance.seeded', 'user', $1, $2::jsonb)`,
    [admin.id, JSON.stringify({ orders: created.map(row => row.order) })]);

  console.log('\nClient-acceptance demo data created.\n');
  console.log(`  Customer          +91 ${customerPhone}  (sign in on the store with an SMS code)`);
  console.log(`  Delivery partner  +91 ${partnerPhone}  (sign in at /partner on the admin site with an SMS code)`);
  console.log(`  Admin             +91 ${adminPhone}  temporary password: ${adminTemp}`);
  console.log('                    (shown once; must be changed at first sign-in at /admin/login)\n');
  console.table(created);
} finally {
  // Always, even after a failure: leave no usable script sessions behind, and the admin must choose a
  // password at first sign-in.
  try {
    await pool.query(`UPDATE auth_sessions SET revoked_at = now() WHERE user_id IN (SELECT id FROM users WHERE phone_e164 = ANY($1)) AND revoked_at IS NULL`, [demoPhones]);
    if (adminId) await pool.query(`UPDATE users SET must_change_password = TRUE, password_changed_at = now() WHERE id = $1`, [adminId]);
  } catch (error) { console.error('Cleanup failed; revoke demo sessions manually:', error instanceof Error ? error.message : error); }
  await app?.close();
  await pool.end();
  await rm(mediaDir, { recursive: true, force: true });
}
