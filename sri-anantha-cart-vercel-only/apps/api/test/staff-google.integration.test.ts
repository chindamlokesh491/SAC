import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { GoogleIdentity } from '../src/auth/google.js';
import { loadConfig } from '../src/config.js';
import { registerStaffGoogleAuthRoute } from '../src/routes/staff-google-auth.js';
import { createHarness, skipReason, type Harness } from './support/harness.js';

describe('staff Google routes cannot create or elevate accounts (integration)', { skip: skipReason }, () => {
  let h: Harness;
  let app: FastifyInstance;
  const identities = new Map<string, GoogleIdentity>();
  const token = (key: string, identity: GoogleIdentity) => {
    const idToken = `mock-staff-google-token-${key}-long-enough`;
    identities.set(idToken, identity);
    return idToken;
  };
  const post = async (url: string, body: unknown, bearer?: string) => {
    const response = await app.inject({ method: 'POST', url, payload: body as object, headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });
    return { status: response.statusCode, json: response.json() as Record<string, any> };
  };
  const userCount = async () => Number((await h.pool.query('SELECT COUNT(*) FROM users')).rows[0].count);

  before(async () => {
    h = await createHarness();
    app = Fastify({ logger: false });
    await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
    const config = loadConfig({ NODE_ENV: 'test', SESSION_SECRET: 'integration-test-secret-0123456789abcdef', GOOGLE_CLIENT_IDS: 'staff-client.apps.googleusercontent.com' });
    await registerStaffGoogleAuthRoute(app, h.pool, config, async idToken => {
      const identity = identities.get(idToken);
      if (!identity) throw new Error('invalid test token');
      return identity;
    });
    await app.ready();
  });
  after(async () => { await app?.close(); await h?.close(); });

  it('rejects an unknown Google account without creating a user', async () => {
    const before = await userCount();
    const result = await post('/api/v1/auth/staff/google', { id_token: token('stranger', { sub: 'g-stranger', email: 'stranger@example.com', emailVerified: true, name: 'Stranger' }) });
    assert.equal(result.status, 403);
    assert.equal(result.json.error, 'STAFF_ACCOUNT_NOT_PROVISIONED');
    assert.equal(await userCount(), before);
  });

  it('never signs a customer in as staff, even with a matching verified email', async () => {
    const customer = await h.login('9100000301');
    await h.pool.query(`UPDATE users SET email = 'customer@example.com', email_verified = TRUE WHERE id = $1`, [customer.userId]);
    const result = await post('/api/v1/auth/staff/google', { id_token: token('customer', { sub: 'g-customer', email: 'customer@example.com', emailVerified: true, name: 'C' }) });
    assert.equal(result.status, 403);
    const row = (await h.pool.query('SELECT role, google_sub FROM users WHERE id = $1', [customer.userId])).rows[0];
    assert.deepEqual(row, { role: 'customer', google_sub: null });
  });

  it('auto-links a preverified staff email case-insensitively and keeps the role', async () => {
    const operator = await h.login('9100000302', 'operator');
    await h.pool.query(`UPDATE users SET email = 'ops@example.com', email_verified = TRUE WHERE id = $1`, [operator.userId]);
    const result = await post('/api/v1/auth/staff/google', { id_token: token('ops', { sub: 'g-ops', email: 'Ops@Example.com', emailVerified: true, name: 'Ops' }) });
    assert.equal(result.status, 200, JSON.stringify(result.json));
    assert.equal(result.json.data.user.role, 'operator');
    assert.equal((await h.pool.query('SELECT google_sub FROM users WHERE id = $1', [operator.userId])).rows[0].google_sub, 'g-ops');
  });

  it('rejects unverified Google emails', async () => {
    const result = await post('/api/v1/auth/staff/google', { id_token: token('unverified', { sub: 'g-unv', email: 'ops@example.com', emailVerified: false, name: 'U' }) });
    assert.equal(result.status, 401);
  });

  it('linking requires a staff session and cannot be used by customers', async () => {
    const identity = token('link', { sub: 'g-link', email: 'Admin.Link@Example.com', emailVerified: true, name: 'A' });
    assert.equal((await post('/api/v1/auth/staff/google/link', { id_token: identity })).status, 401);
    const customer = await h.login('9100000303');
    assert.equal((await post('/api/v1/auth/staff/google/link', { id_token: identity }, customer.token)).status, 403);

    const admin = await h.login('9100000304', 'admin');
    const linked = await post('/api/v1/auth/staff/google/link', { id_token: identity }, admin.token);
    assert.equal(linked.status, 200, JSON.stringify(linked.json));
    const row = (await h.pool.query('SELECT role, google_sub, email, email_verified FROM users WHERE id = $1', [admin.userId])).rows[0];
    assert.deepEqual(row, { role: 'admin', google_sub: 'g-link', email: 'admin.link@example.com', email_verified: true });

    // A second, different Google identity cannot replace the linked one.
    const other = token('link-other', { sub: 'g-link-other', email: 'other@example.com', emailVerified: true, name: 'O' });
    assert.equal((await post('/api/v1/auth/staff/google/link', { id_token: other }, admin.token)).status, 409);
    // The linked identity now signs in as the same admin, not a new account.
    const signedIn = await post('/api/v1/auth/staff/google', { id_token: identity });
    assert.equal(signedIn.status, 200);
    assert.equal(signedIn.json.data.user.id, admin.userId);
  });

  it('a removed staff member can no longer sign in with Google', async () => {
    const removed = await h.login('9100000305', 'operator');
    await h.pool.query(`UPDATE users SET google_sub = 'g-removed' WHERE id = $1`, [removed.userId]);
    await h.pool.query(`UPDATE users SET role = 'customer', password_hash = NULL, is_active = FALSE, staff_removed_at = now() WHERE id = $1`, [removed.userId]);
    const result = await post('/api/v1/auth/staff/google', { id_token: token('removed', { sub: 'g-removed', email: 'removed@example.com', emailVerified: true, name: 'R' }) });
    assert.equal(result.status, 403);
  });
});
