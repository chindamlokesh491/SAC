import test from 'node:test';
import assert from 'node:assert/strict';
import { requireAuth, requireRole } from '../src/auth/session.js';
import { sha256 } from '../src/auth/security.js';

function mockReply() {
  const state: { statusCode?: number; payload?: unknown } = {};
  const reply = {
    code(statusCode: number) { state.statusCode = statusCode; return this; },
    send(payload?: unknown) { state.payload = payload; return this; },
  };
  return { reply: reply as never, state };
}

function mockRequest(authorization?: string) {
  return { headers: authorization ? { authorization } : {} } as never;
}

test('requireAuth rejects missing and malformed bearer tokens without querying the database', async () => {
  let calls = 0;
  const pool = { query: async () => { calls += 1; return { rows: [] }; } } as never;

  for (const header of [undefined, 'Basic abc', 'Bearer too-short', 'Bearer token with spaces']) {
    const { reply, state } = mockReply();
    const user = await requireAuth(pool, mockRequest(header), reply);
    assert.equal(user, null);
    assert.equal(state.statusCode, 401);
  }
  assert.equal(calls, 0);
});

test('requireAuth hashes the bearer token and rejects expired or unknown sessions', async () => {
  const token = 'A'.repeat(43);
  let received: unknown[] | undefined;
  const pool = { query: async (_sql: string, values: unknown[]) => { received = values; return { rows: [] }; } } as never;
  const { reply, state } = mockReply();
  const user = await requireAuth(pool, mockRequest(`Bearer ${token}`), reply);
  assert.equal(user, null);
  assert.equal(state.statusCode, 401);
  assert.deepEqual(received, [sha256(token)]);
});

test('requireAuth returns only the active session user selected by the database', async () => {
  const token = 'B'.repeat(43);
  const expected = { id: 'user-1', role: 'customer', phone_e164: '+919876543210' };
  const pool = { query: async () => ({ rows: [expected] }) } as never;
  const request = mockRequest(`Bearer ${token}`) as { authUser?: unknown };
  const { reply, state } = mockReply();
  const user = await requireAuth(pool, request as never, reply);
  assert.deepEqual(user, expected);
  assert.deepEqual(request.authUser, expected);
  assert.equal(state.statusCode, undefined);
});

test('requireRole returns 403 for a customer requesting an admin-only operation', async () => {
  const token = 'C'.repeat(43);
  const pool = { query: async () => ({ rows: [{ id: 'user-1', role: 'customer', phone_e164: '+919876543210' }] }) } as never;
  const { reply, state } = mockReply();
  const user = await requireRole(pool, mockRequest(`Bearer ${token}`), reply, ['admin']);
  assert.equal(user, null);
  assert.equal(state.statusCode, 403);
  assert.deepEqual(state.payload, { error: 'FORBIDDEN', message: 'You do not have permission to perform this action' });
});
