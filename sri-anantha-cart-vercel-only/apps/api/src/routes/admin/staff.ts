import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { hashPassword, temporaryPassword, verifyPassword } from '../../auth/password.js';
import { normalizeIndianPhone } from '../../auth/security.js';
import { requireRole, type AuthenticatedUser } from '../../auth/session.js';
import { audit, HttpError, parseOrReply, sendHttpError, uuidPattern, withTransaction } from '../../lib/http.js';

const LIMITS = { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } };
const passwordField = z.string().min(1, 'Enter your password to confirm').max(128);

/** Re-checks the acting admin's own password before any change to who can access the admin panel. */
async function confirmPassword(pool: Pool, actor: AuthenticatedUser, password: string) {
  const stored = await pool.query<{ password_hash: string | null }>('SELECT password_hash FROM users WHERE id = $1', [actor.id]);
  if (!(await verifyPassword(password, stored.rows[0]?.password_hash ?? null))) {
    await audit(pool, actor.id, 'staff.confirmation_failed', 'user', actor.id);
    throw new HttpError(400, 'WRONG_PASSWORD', 'Your password is incorrect', { fields: { current_password: 'Incorrect password' } });
  }
}

async function guarded(request: FastifyRequest, reply: FastifyReply, run: () => Promise<unknown>) {
  try { return await run(); } catch (error) {
    if (error instanceof HttpError) return sendHttpError(reply, error);
    throw error;
  }
}

/**
 * Admins manage staff and delivery-partner accounts from Settings. Every change needs the acting admin's own
 * password; new and reset accounts get a one-time temporary password that must be changed.
 */
export async function registerAdminStaffRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  app.get('/api/v1/admin/staff', async (request, reply) => {
    const actor = await requireRole(pool, request, reply, ['admin']);
    if (!actor) return;
    const result = await pool.query(
      `SELECT u.id, u.display_name, u.phone_e164, u.role, u.must_change_password, u.created_at,
              (SELECT MAX(s.created_at) FROM auth_sessions s WHERE s.user_id = u.id) AS last_sign_in_at
         FROM users u WHERE u.role IN ('admin','operator','delivery_partner') ORDER BY u.role, u.created_at`);
    return { data: result.rows.map(row => ({ ...row, is_you: row.id === actor.id })) };
  });

  app.post('/api/v1/admin/staff', LIMITS, async (request, reply) => {
    const actor = await requireRole(pool, request, reply, ['admin']);
    if (!actor) return;
    const body = parseOrReply(z.object({
      phone: z.string().max(20), role: z.enum(['admin', 'operator', 'delivery_partner']), name: z.string().trim().max(100).optional(), current_password: passwordField,
    }).strict(), request.body, reply);
    if (!body) return;
    return guarded(request, reply, async () => {
      await confirmPassword(pool, actor, body.current_password);
      const phone = normalizeIndianPhone(body.phone);
      if (!phone) throw new HttpError(400, 'INVALID_PHONE', 'Enter a valid 10-digit mobile number', { fields: { phone: 'Enter a valid 10-digit mobile number' } });
      const password = body.role === 'delivery_partner' ? null : temporaryPassword();
      const hash = password ? await hashPassword(password) : null;
      const created = await withTransaction(pool, async client => {
        const existing = await client.query<{ id: string; role: string; staff_removed_at: Date | null }>('SELECT id, role, staff_removed_at FROM users WHERE phone_e164 = $1 FOR UPDATE', [phone]);
        const found = existing.rows[0];
        if (found && found.role !== 'customer') throw new HttpError(409, 'ALREADY_STAFF', 'This number already has staff access', { fields: { phone: 'Already staff' } });
        if (found && !found.staff_removed_at) throw new HttpError(409, 'PHONE_IS_CUSTOMER', 'This number belongs to a customer account. Use a different number for staff access.', { fields: { phone: 'Already a customer account' } });
        const user = found
          ? await client.query<{ id: string }>(
            `UPDATE users SET role = $2, display_name = COALESCE($3, display_name), password_hash = $4, must_change_password = $5, password_changed_at = CASE WHEN $5 THEN now() ELSE NULL END,
                    is_active = TRUE, blocked_at = NULL, staff_removed_at = NULL, failed_login_attempts = 0, locked_until = NULL, updated_at = now()
              WHERE id = $1 RETURNING id`, [found.id, body.role, body.name || null, hash, body.role !== 'delivery_partner'])
          : await client.query<{ id: string }>(
            `INSERT INTO users (phone_e164, role, display_name, password_hash, must_change_password, password_changed_at)
             VALUES ($1, $2, $3, $4, $5, CASE WHEN $5 THEN now() ELSE NULL END) RETURNING id`, [phone, body.role, body.name || null, hash, body.role !== 'delivery_partner']);
        await audit(client, actor.id, 'staff.added', 'user', user.rows[0]!.id, { role: body.role, phone });
        return user.rows[0]!;
      });
      // Shown once to the admin who created the account; only the hash is stored.
      return reply.code(201).send({ data: { id: created.id, phone, role: body.role, temporary_password: password } });
    });
  });

  app.post<{ Params: { staffId: string } }>('/api/v1/admin/staff/:staffId/reset-password', LIMITS, async (request, reply) => {
    const actor = await requireRole(pool, request, reply, ['admin']);
    if (!actor) return;
    if (!uuidPattern.test(request.params.staffId)) return reply.code(400).send({ error: 'INVALID_STAFF_ID', message: 'Invalid staff account' });
    const body = parseOrReply(z.object({ current_password: passwordField }).strict(), request.body, reply);
    if (!body) return;
    return guarded(request, reply, async () => {
      await confirmPassword(pool, actor, body.current_password);
      if (request.params.staffId === actor.id) throw new HttpError(400, 'USE_MY_ACCOUNT', 'Change your own password from My account');
      const password = temporaryPassword();
      const hash = await hashPassword(password);
      await withTransaction(pool, async client => {
        const updated = await client.query(
          `UPDATE users SET password_hash = $2, must_change_password = TRUE, password_changed_at = now(), failed_login_attempts = 0, locked_until = NULL, updated_at = now()
            WHERE id = $1 AND role IN ('admin','operator') RETURNING id`, [request.params.staffId, hash]);
        if (!updated.rowCount) throw new HttpError(404, 'STAFF_NOT_FOUND', 'Staff account not found');
        await client.query('UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [request.params.staffId]);
        await audit(client, actor.id, 'staff.password_reset', 'user', request.params.staffId);
      });
      return { data: { id: request.params.staffId, temporary_password: password } };
    });
  });

  app.post<{ Params: { staffId: string } }>('/api/v1/admin/staff/:staffId/remove', LIMITS, async (request, reply) => {
    const actor = await requireRole(pool, request, reply, ['admin']);
    if (!actor) return;
    if (!uuidPattern.test(request.params.staffId)) return reply.code(400).send({ error: 'INVALID_STAFF_ID', message: 'Invalid staff account' });
    const body = parseOrReply(z.object({ current_password: passwordField }).strict(), request.body, reply);
    if (!body) return;
    return guarded(request, reply, async () => {
      await confirmPassword(pool, actor, body.current_password);
      if (request.params.staffId === actor.id) throw new HttpError(400, 'CANNOT_REMOVE_SELF', 'You cannot remove your own access. Ask another admin.');
      await withTransaction(pool, async client => {
        // Lock every admin row so two admins cannot remove each other at the same moment.
        const admins = await client.query<{ id: string }>(`SELECT id FROM users WHERE role = 'admin' ORDER BY id FOR UPDATE`);
        const target = await client.query<{ role: string }>(`SELECT role FROM users WHERE id = $1 AND role IN ('admin','operator','delivery_partner') FOR UPDATE`, [request.params.staffId]);
        if (!target.rows[0]) throw new HttpError(404, 'STAFF_NOT_FOUND', 'Staff account not found');
        if (target.rows[0].role === 'admin' && admins.rowCount === 1) throw new HttpError(409, 'LAST_ADMIN', 'The store must keep at least one admin');
        // The account is kept (it is referenced by the audit log) but loses all access.
        await client.query(`UPDATE users SET role = 'customer', password_hash = NULL, must_change_password = FALSE, is_active = FALSE, blocked_at = now(), staff_removed_at = now(), updated_at = now() WHERE id = $1`, [request.params.staffId]);
        await client.query('UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [request.params.staffId]);
        await audit(client, actor.id, 'staff.removed', 'user', request.params.staffId, { role: target.rows[0].role });
      });
      return { data: { id: request.params.staffId, removed: true } };
    });
  });
}
