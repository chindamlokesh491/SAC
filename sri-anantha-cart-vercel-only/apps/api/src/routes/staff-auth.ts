import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { dummyPasswordHash, hashPassword, passwordProblem, verifyPassword } from '../auth/password.js';
import { normalizeIndianPhone, sha256 } from '../auth/security.js';
import { createSession, currentToken, requireAuth, STAFF_ROLES, type UserRole } from '../auth/session.js';
import { audit, HttpError, parseOrReply, sendHttpError, withTransaction } from '../lib/http.js';
import { sendSession, type SignedInUser } from './auth.js';

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const INVALID_CREDENTIALS = { error: 'INVALID_CREDENTIALS', message: 'Mobile number or password is incorrect' };

type StaffRow = SignedInUser & { is_active: boolean; password_hash: string | null; failed_login_attempts: number; locked_until: Date | null };

/**
 * Staff (admin / operator) sign in with mobile number + password. Accounts are created and
 * reset only from the server console (`staff:grant`), which issues a temporary password.
 */
export async function registerStaffAuthRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  app.post('/api/v1/auth/staff/login', {
    config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
  }, async (request, reply) => {
    const body = parseOrReply(z.object({ phone: z.string().max(20), password: z.string().min(1).max(128) }).strict(), request.body, reply);
    if (!body) return;
    const phone = normalizeIndianPhone(body.phone);
    const found = phone ? await pool.query<StaffRow>(
      `SELECT id, role, phone_e164, display_name, email, must_change_password, is_active, password_hash, failed_login_attempts, locked_until
         FROM users WHERE phone_e164 = $1 AND role = ANY($2)`, [phone, ['admin', 'operator']],
    ) : null;
    const user = found?.rows[0];
    if (!user?.password_hash) {
      await verifyPassword(body.password, await dummyPasswordHash());
      return reply.code(401).send(INVALID_CREDENTIALS);
    }
    if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
      const minutes = Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 60_000);
      return reply.code(429).send({ error: 'ACCOUNT_LOCKED', message: `Too many wrong attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.` });
    }
    if (!(await verifyPassword(body.password, user.password_hash))) {
      const attempts = user.failed_login_attempts + 1;
      const lock = attempts >= MAX_FAILED_ATTEMPTS;
      await pool.query(
        `UPDATE users SET failed_login_attempts = $2, locked_until = CASE WHEN $3 THEN now() + ($4 * interval '1 minute') ELSE locked_until END WHERE id = $1`,
        [user.id, lock ? 0 : attempts, lock, LOCK_MINUTES],
      );
      if (lock) await audit(pool, user.id, 'staff.locked_out', 'user', user.id, { minutes: LOCK_MINUTES });
      return reply.code(401).send(INVALID_CREDENTIALS);
    }
    if (!user.is_active) return reply.code(403).send({ error: 'ACCOUNT_DISABLED', message: 'This account has been disabled.' });
    const session = await withTransaction(pool, async client => {
      await client.query('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1', [user.id]);
      return createSession(client, user.id, user.role as UserRole);
    });
    return sendSession(request, reply, session, user);
  });

  app.post('/api/v1/auth/staff/password', {
    config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
  }, async (request, reply) => {
    const actor = await requireAuth(pool, request, reply);
    if (!actor) return;
    if (!STAFF_ROLES.includes(actor.role)) return reply.code(403).send({ error: 'FORBIDDEN', message: 'Only staff accounts have a password' });
    const body = parseOrReply(z.object({ current_password: z.string().min(1).max(128), new_password: z.string().max(128) }).strict(), request.body, reply);
    if (!body) return;
    const problem = passwordProblem(body.new_password, actor.phone_e164);
    if (problem) return reply.code(400).send({ error: 'WEAK_PASSWORD', message: problem, fields: { new_password: problem } });
    if (body.new_password === body.current_password) return reply.code(400).send({ error: 'WEAK_PASSWORD', message: 'Choose a password different from the current one', fields: { new_password: 'Must be different' } });
    const stored = await pool.query<{ password_hash: string | null }>('SELECT password_hash FROM users WHERE id = $1', [actor.id]);
    if (!(await verifyPassword(body.current_password, stored.rows[0]?.password_hash ?? null))) {
      return reply.code(400).send({ error: 'WRONG_PASSWORD', message: 'Current password is incorrect', fields: { current_password: 'Incorrect password' } });
    }
    const hash = await hashPassword(body.new_password);
    const token = currentToken(request);
    await withTransaction(pool, async client => {
      await client.query(
        `UPDATE users SET password_hash = $2, password_changed_at = now(), must_change_password = FALSE, failed_login_attempts = 0, locked_until = NULL, updated_at = now() WHERE id = $1`,
        [actor.id, hash],
      );
      // Every other device is signed out; this one stays signed in.
      await client.query('UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND token_hash <> $2', [actor.id, token ? sha256(token) : '']);
      await audit(client, actor.id, 'staff.password_changed', 'user', actor.id);
    });
    return { data: { changed: true } };
  });

  app.post('/api/v1/auth/staff/phone', {
    config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
  }, async (request, reply) => {
    const actor = await requireAuth(pool, request, reply);
    if (!actor) return;
    if (!STAFF_ROLES.includes(actor.role)) return reply.code(403).send({ error: 'FORBIDDEN', message: 'Only staff accounts can change their sign-in number here' });
    if (actor.must_change_password) return reply.code(403).send({ error: 'PASSWORD_CHANGE_REQUIRED', message: 'Set a new password before continuing' });
    const body = parseOrReply(z.object({ current_password: z.string().min(1).max(128), phone: z.string().max(20) }).strict(), request.body, reply);
    if (!body) return;
    const phone = normalizeIndianPhone(body.phone);
    if (!phone) return reply.code(400).send({ error: 'INVALID_PHONE', message: 'Enter a valid 10-digit mobile number', fields: { phone: 'Enter a valid 10-digit mobile number' } });
    const stored = await pool.query<{ password_hash: string | null }>('SELECT password_hash FROM users WHERE id = $1', [actor.id]);
    if (!(await verifyPassword(body.current_password, stored.rows[0]?.password_hash ?? null))) {
      return reply.code(400).send({ error: 'WRONG_PASSWORD', message: 'Current password is incorrect', fields: { current_password: 'Incorrect password' } });
    }
    try {
      await withTransaction(pool, async client => {
        const taken = await client.query('SELECT 1 FROM users WHERE phone_e164 = $1 AND id <> $2', [phone, actor.id]);
        if (taken.rowCount) throw new HttpError(409, 'PHONE_IN_USE', 'This number is already registered to another account', { fields: { phone: 'Already registered' } });
        await client.query('UPDATE users SET phone_e164 = $2, updated_at = now() WHERE id = $1', [actor.id, phone]);
        await audit(client, actor.id, 'staff.phone_changed', 'user', actor.id, { from: actor.phone_e164, to: phone });
      });
    } catch (error) {
      if (error instanceof HttpError) return sendHttpError(reply, error);
      throw error;
    }
    return { data: { phone } };
  });
}
