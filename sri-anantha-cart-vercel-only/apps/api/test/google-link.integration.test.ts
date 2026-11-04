import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { GoogleIdentity } from '../src/auth/google.js';
import { loadConfig } from '../src/config.js';
import { registerAuthRoutes } from '../src/routes/auth.js';
import { createHarness, skipReason, type Harness } from './support/harness.js';

const CLIENT_ID = 'web-client.apps.googleusercontent.com';

describe('Google account linking (integration)', { skip: skipReason }, () => {
  let h: Harness;
  let app: FastifyInstance;
  const identities = new Map<string, GoogleIdentity>();
  let verificationCalls = 0;

  const addIdentity = (key: string, identity: GoogleIdentity) => {
    const idToken = `mock-google-id-token-${key}-long-enough-for-validation`;
    identities.set(idToken, identity);
    return idToken;
  };

  const link = async (sessionToken: string | undefined, idToken: string) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/google/link',
      headers: sessionToken ? { authorization: `Bearer ${sessionToken}` } : {},
      payload: { id_token: idToken },
    });
    return { status: response.statusCode, body: response.json() as Record<string, any> };
  };

  before(async () => {
    h = await createHarness();
    app = Fastify({ logger: false });
    await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
    const config = loadConfig({
      NODE_ENV: 'test',
      SESSION_SECRET: 'integration-test-secret-0123456789abcdef',
      GOOGLE_CLIENT_IDS: CLIENT_ID,
    });
    await registerAuthRoutes(app, h.pool, {
      config,
      sendOtp: async () => undefined,
      verifyGoogleToken: async idToken => {
        verificationCalls++;
        const identity = identities.get(idToken);
        if (!identity) throw new Error('Invalid test token');
        return identity;
      },
    });
    await app.ready();
  });

  after(async () => {
    await app?.close();
    await h?.close();
  });

  test('links a verified Google identity without overwriting a separate receipt email', async () => {
    const customer = await h.login('9100000091');
    const profileEmail = 'receipts@example.com';
    const updated = await h.request('PATCH', '/api/v1/me', { token: customer.token, body: { email: profileEmail } });
    assert.equal(updated.status, 200);

    const token = addIdentity('receipt-email', {
      sub: 'google-sub-receipt-email',
      email: 'google-account@example.com',
      emailVerified: true,
      name: 'Devotee',
    });
    const response = await link(customer.token, token);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data, { linked: true });

    const saved = await h.pool.query(
      'SELECT google_sub, email, email_verified FROM users WHERE id = $1',
      [customer.userId],
    );
    assert.deepEqual(saved.rows[0], {
      google_sub: 'google-sub-receipt-email',
      email: profileEmail,
      email_verified: false,
    });

    const me = await h.request('GET', '/api/v1/me', { token: customer.token });
    assert.equal(me.json.data.google_linked, true);
  });

  test('uses the verified Google email when the profile has no email', async () => {
    const customer = await h.login('9100000092');
    const token = addIdentity('empty-profile', {
      sub: 'google-sub-empty-profile',
      email: 'verified@example.com',
      emailVerified: true,
      name: 'Devotee',
    });
    const response = await link(customer.token, token);
    assert.equal(response.status, 200);

    const saved = await h.pool.query(
      'SELECT email, email_verified FROM users WHERE id = $1',
      [customer.userId],
    );
    assert.deepEqual(saved.rows[0], { email: 'verified@example.com', email_verified: true });
  });

  test('rejects an unverified Google email without linking the identity', async () => {
    const customer = await h.login('9100000093');
    const token = addIdentity('unverified', {
      sub: 'google-sub-unverified',
      email: 'unverified@example.com',
      emailVerified: false,
      name: 'Devotee',
    });
    const response = await link(customer.token, token);
    assert.equal(response.status, 401);
    assert.equal(response.body.error, 'GOOGLE_EMAIL_UNVERIFIED');

    const saved = await h.pool.query('SELECT google_sub FROM users WHERE id = $1', [customer.userId]);
    assert.equal(saved.rows[0]!.google_sub, null);
  });

  test('cannot replace a different Google identity already linked to the customer', async () => {
    const customer = await h.login('9100000094');
    const first = addIdentity('first-link', {
      sub: 'google-sub-first-link',
      email: 'first@example.com',
      emailVerified: true,
      name: 'First',
    });
    const second = addIdentity('second-link', {
      sub: 'google-sub-second-link',
      email: 'second@example.com',
      emailVerified: true,
      name: 'Second',
    });

    assert.equal((await link(customer.token, first)).status, 200);
    const replacement = await link(customer.token, second);
    assert.equal(replacement.status, 409);
    assert.equal(replacement.body.error, 'GOOGLE_PROFILE_ALREADY_LINKED');

    const saved = await h.pool.query('SELECT google_sub FROM users WHERE id = $1', [customer.userId]);
    assert.equal(saved.rows[0]!.google_sub, 'google-sub-first-link');
  });

  test('one Google identity cannot be linked to two customer profiles', async () => {
    const firstCustomer = await h.login('9100000096');
    const secondCustomer = await h.login('9100000097');
    const token = addIdentity('duplicate-link', {
      sub: 'google-sub-duplicate-link',
      email: 'duplicate@example.com',
      emailVerified: true,
      name: 'Devotee',
    });

    assert.equal((await link(firstCustomer.token, token)).status, 200);
    const duplicate = await link(secondCustomer.token, token);
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error, 'GOOGLE_ALREADY_LINKED');

    const second = await h.pool.query('SELECT google_sub FROM users WHERE id = $1', [secondCustomer.userId]);
    assert.equal(second.rows[0]!.google_sub, null);
  });

  test('staff accounts cannot link Google identities', async () => {
    const staff = await h.login('9100000098', 'admin');
    const token = addIdentity('staff', {
      sub: 'google-sub-staff',
      email: 'staff@example.com',
      emailVerified: true,
      name: 'Staff',
    });
    const callsBefore = verificationCalls;
    const response = await link(staff.token, token);
    assert.equal(response.status, 403);
    assert.equal(response.body.error, 'STAFF_USE_PASSWORD');
    assert.equal(verificationCalls, callsBefore, 'staff requests are rejected before token verification');
  });

  test('requires an authenticated customer session', async () => {
    const token = addIdentity('anonymous', {
      sub: 'google-sub-anonymous',
      email: 'anonymous@example.com',
      emailVerified: true,
      name: 'Anonymous',
    });
    const response = await link(undefined, token);
    assert.equal(response.status, 401);
    assert.equal(response.body.error, 'UNAUTHENTICATED');
  });

  test('concurrent first-time Google sign-ins resolve to one customer profile', async () => {
    const token = addIdentity('concurrent-first-sign-in', {
      sub: 'google-sub-concurrent-first-sign-in',
      email: 'concurrent@example.com',
      emailVerified: true,
      name: 'Concurrent Devotee',
    });
    const signIn = () => app.inject({
      method: 'POST',
      url: '/api/v1/auth/google',
      payload: { id_token: token },
    });
    const [first, second] = await Promise.all([signIn(), signIn()]);
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(first.json().data.user.id, second.json().data.user.id);

    const saved = await h.pool.query(
      'SELECT count(*)::int AS count FROM users WHERE google_sub = $1',
      ['google-sub-concurrent-first-sign-in'],
    );
    assert.equal(saved.rows[0]!.count, 1);
  });

  test('rejects an ID token that the verifier cannot validate', async () => {
    const customer = await h.login('9100000099');
    const response = await link(customer.token, 'mock-google-id-token-not-in-the-test-map');
    assert.equal(response.status, 401);
    assert.equal(response.body.error, 'GOOGLE_TOKEN_INVALID');
  });
});
