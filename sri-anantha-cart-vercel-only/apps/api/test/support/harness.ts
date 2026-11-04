import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { buildApp } from '../../src/app.js';
import { hashPassword } from '../../src/auth/password.js';
import { loadConfig } from '../../src/config.js';
import type { MediaStore } from '../../src/media/store.js';

pg.types.setTypeParser(20, value => Number(value));

export const databaseUrl = process.env.TEST_DATABASE_URL;
const runtimeDatabaseUrl = process.env.TEST_RUNTIME_DATABASE_URL;
/** Password given to staff accounts created by `login(phone, 'admin' | 'operator')`. */
export const STAFF_TEST_PASSWORD = 'Temple-lamp-2026';
export const skipReason = databaseUrl ? false : 'Set TEST_DATABASE_URL to a disposable PostgreSQL database to run integration tests';

type Json = Record<string, any>;
export type Harness = Awaited<ReturnType<typeof createHarness>>;

/**
 * Real application + real PostgreSQL in an isolated schema with every migration applied.
 * OTP codes are captured in memory instead of being sent by SMS.
 */
export async function createHarness(options: { env?: Record<string, string>; geoFetch?: typeof fetch; mediaStore?: MediaStore } = {}) {
  const schema = `sac_it_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  // Migrations always run as the owner. With TEST_RUNTIME_DATABASE_URL set, the application and the tests
  // then connect as the least-privilege runtime role (database/roles/app_runtime_role.sql) instead.
  const owner = new pg.Pool({ connectionString: databaseUrl, max: 2, options: `-c search_path=${schema},public` });
  const migrationDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../database/migrations');
  for (const file of (await readdir(migrationDir)).filter(name => /^\d{3}_.+\.sql$/.test(name) && !name.startsWith('002_')).sort()) {
    await owner.query(await readFile(join(migrationDir, file), 'utf8'));
  }
  await owner.end();
  // Tests and seed helpers need owner access for fixture setup/assertions. The application itself
  // must use the configured least-privilege runtime role when TEST_RUNTIME_DATABASE_URL is set.
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema},public` });
  const appPool = new pg.Pool({ connectionString: runtimeDatabaseUrl ?? databaseUrl, max: 10, options: `-c search_path=${schema},public` });
  const mediaDir = await mkdtemp(join(tmpdir(), 'sac-media-'));
  const config = loadConfig({
    NODE_ENV: 'test', SESSION_SECRET: 'integration-test-secret-0123456789abcdef', MEDIA_DIR: mediaDir,
    CHECKOUT_ENABLED: 'true', OTP_PROVIDER: 'none', ...options.env,
  });
  const otpCodes = new Map<string, string>();
  const routes: { method: string; url: string }[] = [];
  const app: FastifyInstance = await buildApp({
    config, pool: appPool, logger: false, rateLimit: false, ...(options.geoFetch ? { geoFetch: options.geoFetch } : {}), ...(options.mediaStore ? { mediaStore: options.mediaStore } : {}),
    sendOtp: async (phone, code) => { otpCodes.set(phone, code); return {}; },
    onRoute: route => { for (const method of [route.method].flat()) routes.push({ method, url: route.url }); },
  });
  await app.ready();

  const request = async (method: string, url: string, init: { token?: string | undefined; body?: unknown; headers?: Record<string, string>; cookie?: string } = {}) => {
    const headers: Record<string, string> = { ...init.headers };
    if (init.token) headers.authorization = `Bearer ${init.token}`;
    if (init.cookie) headers.cookie = init.cookie;
    const response: LightMyRequestResponse = await app.inject({ method: method as 'GET', url, headers, ...(init.body !== undefined ? { payload: init.body as Json } : {}) });
    let json: Json = {};
    try { json = response.body ? JSON.parse(response.body) : {}; } catch { json = {}; }
    return { status: response.statusCode, json, headers: response.headers, body: response.body };
  };

  /** Customers sign in through the real OTP endpoints; staff through the real password endpoint. */
  const login = async (phone10: string, role: 'customer' | 'admin' | 'operator' = 'customer') => {
    const phone = `+91${phone10}`;
    if (role !== 'customer') {
      await pool.query(
        `INSERT INTO users(phone_e164, role, password_hash) VALUES ($1, $2, $3)
         ON CONFLICT (phone_e164) DO UPDATE SET role = EXCLUDED.role, password_hash = EXCLUDED.password_hash, must_change_password = FALSE`,
        [phone, role, await hashPassword(STAFF_TEST_PASSWORD)],
      );
      const signedIn = await request('POST', '/api/v1/auth/staff/login', { body: { phone: phone10, password: STAFF_TEST_PASSWORD } });
      if (signedIn.status !== 200) throw new Error(`Staff login failed: ${signedIn.status} ${signedIn.body}`);
      return { token: signedIn.json.data.accessToken as string, userId: signedIn.json.data.user.id as string };
    }
    await pool.query('DELETE FROM otp_challenges WHERE phone_e164 = $1', [phone]);
    const requested = await request('POST', '/api/v1/auth/otp/request', { body: { phone: phone10 } });
    if (requested.status !== 202) throw new Error(`OTP request failed: ${requested.status} ${requested.body}`);
    const verified = await request('POST', '/api/v1/auth/otp/verify', { body: { phone: phone10, code: otpCodes.get(phone) } });
    if (verified.status !== 200) throw new Error(`OTP verify failed: ${verified.status} ${verified.body}`);
    return { token: verified.json.data.accessToken as string, userId: verified.json.data.user.id as string };
  };

  const seed = {
    async category(name = `Cat ${randomUUID().slice(0, 6)}`, parentId: string | null = null) {
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const row = await pool.query<{ id: string }>(`INSERT INTO categories(name, slug, parent_category_id) VALUES ($1, $2, $3) RETURNING id`, [name, `${slug}-${randomUUID().slice(0, 4)}`, parentId]);
      return row.rows[0]!.id;
    },
    async product(input: { categoryId: string; price: number; mrp?: number; stock: number; gst?: number; min?: number; name?: string; active?: boolean }) {
      const name = input.name ?? `Product ${randomUUID().slice(0, 6)}`;
      const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${randomUUID().slice(0, 6)}`;
      const row = await pool.query<{ id: string }>(
        `INSERT INTO products(category_id, sku, slug, name, description, price_paise, mrp_paise, gst_rate_basis_points, minimum_stock_level, is_active, image_url)
         VALUES ($1,$2,$3,$4,'Test product description',$5,$6,$7,$8,$9,'/media/00000000-0000-4000-8000-000000000000.webp') RETURNING id`,
        [input.categoryId, slug.toUpperCase().slice(0, 60), slug, name, input.price, input.mrp ?? input.price, input.gst ?? 0, input.min ?? 2, input.active ?? true]);
      const id = row.rows[0]!.id;
      await pool.query('INSERT INTO inventory(product_id, quantity) VALUES ($1, $2)', [id, input.stock]);
      return { id, slug };
    },
    async variant(productId: string, input: { label: string; price: number; stock: number }) {
      const row = await pool.query<{ id: string }>(`INSERT INTO product_variants(product_id, label, sku, price_paise, mrp_paise, quantity) VALUES ($1,$2,$3,$4,$4,$5) RETURNING id`,
        [productId, input.label, `V-${randomUUID().slice(0, 8).toUpperCase()}`, input.price, input.stock]);
      return row.rows[0]!.id;
    },
    async zone(input: { postal: string[]; fee?: number; minimum?: number; cod?: boolean; codLimit?: number } = { postal: ['517501'] }) {
      const row = await pool.query<{ id: string }>(
        `INSERT INTO delivery_zones(name, postal_codes, delivery_fee_paise, minimum_order_paise, estimated_minutes, is_active, cod_enabled, cod_limit_paise)
         VALUES ('Zone', $1, $2, $3, 30, TRUE, $4, $5) RETURNING id`, [input.postal, input.fee ?? 3000, input.minimum ?? 0, input.cod ?? true, input.codLimit ?? 0]);
      return row.rows[0]!.id;
    },
    async scheduledSlot(start = '09:00', end = '11:00') {
      const row = await pool.query<{ id: string }>(`INSERT INTO delivery_time_slots(name, starts_at, ends_at, is_scheduled, is_active) VALUES ('Morning', $1, $2, TRUE, TRUE) RETURNING id`, [start, end]);
      return row.rows[0]!.id;
    },
    async assignDeliveryPartner(orderId: string, assignedBy: string) {
      const phone = `+919${String(Math.floor(Math.random() * 1_000_000_000)).padStart(9, '0')}`;
      const partner = await pool.query<{ id: string }>(
        `INSERT INTO users(phone_e164, role, display_name) VALUES ($1, 'delivery_partner', 'Test Delivery Partner') RETURNING id`,
        [phone],
      );
      const assignment = await pool.query<{ id: string }>(
        `INSERT INTO delivery_assignments(order_id, delivery_person_id, status, assigned_by)
         VALUES ($1, $2, 'assigned', $3) RETURNING id`,
        [orderId, partner.rows[0]!.id, assignedBy],
      );
      return assignment.rows[0]!.id;
    },
    async address(token: string, postal = '517501') {
      const created = await request('POST', '/api/v1/addresses', { token, body: { recipient_name: 'Test Customer', phone_e164: '9876543210', line1: '1 Temple Street', locality: 'Balaji Colony', postal_code: postal } });
      if (created.status !== 201) throw new Error(`address failed ${created.body}`);
      return created.json.data.id as string;
    },
  };

  /** Adds items, reads the live quote and places a COD (default) order. */
  const placeOrder = async (token: string, addressId: string, items: { product_id: string; quantity: number; variant_id?: string }[], extra: Record<string, unknown> = {}) => {
    for (const item of items) {
      const added = await request('POST', '/api/v1/cart/items', { token, body: item });
      if (added.status !== 200) return added;
    }
    const quote = await request('GET', `/api/v1/cart?address_id=${addressId}`, { token });
    return request('POST', '/api/v1/orders/checkout', {
      token, headers: { 'idempotency-key': `it-${randomUUID()}` },
      body: { address_id: addressId, delivery: { mode: 'express' }, payment_method: 'cod', expected_total_paise: quote.json.data.total_paise, ...extra },
    });
  };

  /**
   * Fulfil an order through the real workflow: staff accept and pack in the admin panel; a delivery
   * partner (signed in by SMS code) accepts, picks up (dispatched) and completes the delivery with the
   * customer's one-time code, recording cash for COD. Self-delivery cannot be dispatched or delivered
   * from the admin panel, so tests use this instead of PATCHing those statuses.
   */
  const partnerTokens = new Map<string, string>();
  let partnerSeq = 0;
  const partnerFor = async (orderId: string, assignedBy: string) => {
    const known = partnerTokens.get(orderId);
    if (known) return known;
    const phone10 = `7${String(Date.now()).slice(-6)}${String(partnerSeq++ % 1000).padStart(3, '0')}`;
    const partner = await pool.query<{ id: string }>(`INSERT INTO users(phone_e164, role, display_name) VALUES ($1, 'delivery_partner', 'Test Rider') RETURNING id`, [`+91${phone10}`]);
    await pool.query(`UPDATE delivery_assignments SET status = 'cancelled', updated_at = now() WHERE order_id = $1 AND status = 'assigned'`, [orderId]);
    await pool.query(`INSERT INTO delivery_assignments(order_id, delivery_person_id, status, assigned_by) VALUES ($1, $2, 'assigned', $3)`, [orderId, partner.rows[0]!.id, assignedBy]);
    const requested = await request('POST', '/api/v1/delivery/auth/request-otp', { body: { phone: phone10 } });
    if (requested.status !== 202) throw new Error(`Partner OTP request failed: ${requested.status} ${requested.body}`);
    const verified = await request('POST', '/api/v1/delivery/auth/verify-otp', { body: { phone: phone10, code: otpCodes.get(`+91${phone10}`) } });
    if (verified.status !== 200) throw new Error(`Partner OTP verify failed: ${verified.status} ${verified.body}`);
    partnerTokens.set(orderId, verified.json.data.accessToken as string);
    return verified.json.data.accessToken as string;
  };
  const fulfil = async (orderId: string, status: 'accepted' | 'packed' | 'dispatched' | 'delivered', staff: { token: string; userId: string }) => {
    if (status === 'accepted' || status === 'packed') return request('PATCH', `/api/v1/admin/orders/${orderId}/status`, { token: staff.token, body: { status } });
    if (status === 'dispatched') {
      const token = await partnerFor(orderId, staff.userId);
      const accepted = await request('POST', `/api/v1/delivery/me/orders/${orderId}/accept`, { token, body: {} });
      if (accepted.status !== 200) return accepted;
      return request('POST', `/api/v1/delivery/me/orders/${orderId}/pickup`, { token, body: {} });
    }
    const token = partnerTokens.get(orderId);
    if (!token) return request('PATCH', `/api/v1/admin/orders/${orderId}/status`, { token: staff.token, body: { status } });
    const order = (await pool.query<{ phone: string; total_paise: number }>(`SELECT delivery_address_snapshot->>'phone_e164' AS phone, total_paise FROM orders WHERE id = $1`, [orderId])).rows[0]!;
    const verified = await request('POST', `/api/v1/delivery/me/orders/${orderId}/verify-otp`, { token, body: { otp: otpCodes.get(order.phone) } });
    if (verified.status !== 200 || !verified.json.data.requiresCod) return verified;
    return request('POST', `/api/v1/delivery/me/orders/${orderId}/cod-collection`, { token, body: { amount: (Number(order.total_paise) / 100).toFixed(2) } });
  };

  const close = async () => {
    await app.close();
    await Promise.all([pool.end(), appPool.end()]);
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
    await rm(mediaDir, { recursive: true, force: true });
  };

  return { app, pool, appPool, request, login, seed, placeOrder, fulfil, otpCodes, routes, close, mediaDir };
}
