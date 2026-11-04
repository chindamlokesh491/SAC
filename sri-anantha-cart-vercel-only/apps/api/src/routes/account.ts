import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { sha256 } from '../auth/security.js';
import { clearSessionCookie, currentToken, optionalAuth, requireAuth } from '../auth/session.js';
import { emailSchema, parseOrReply } from '../lib/http.js';

const profileSchema = z.object({
  display_name: z.string().trim().min(1, 'Enter your name').max(100).optional(),
  email: z.union([emailSchema, z.literal('')]).optional(),
}).strict();

export async function registerAccountRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  app.get('/api/v1/me', async (request, reply) => {
    const user = await requireAuth(pool, request, reply);
    if (!user) return;
    const result = await pool.query(
      `SELECT id, role, phone_e164 AS phone, display_name AS name, email, email_verified, google_sub IS NOT NULL AS google_linked, must_change_password, created_at
         FROM users WHERE id = $1`, [user.id],
    );
    return { data: result.rows[0] };
  });

  /** Session probe for storefront chrome: 200 with null when signed out (no console 401 noise). */
  app.get('/api/v1/session', async request => {
    const user = await optionalAuth(pool, request);
    if (!user) return { data: null };
    const result = await pool.query(
      `SELECT id, role, phone_e164 AS phone, display_name AS name, email, email_verified, google_sub IS NOT NULL AS google_linked, must_change_password
         FROM users WHERE id = $1`, [user.id],
    );
    return { data: result.rows[0] ?? null };
  });

  app.patch('/api/v1/me', async (request, reply) => {
    const user = await requireAuth(pool, request, reply);
    if (!user) return;
    const body = parseOrReply(profileSchema, request.body, reply);
    if (!body) return;
    const result = await pool.query(
      `UPDATE users SET
          display_name = CASE WHEN $2::boolean THEN $3 ELSE display_name END,
          email = CASE WHEN $4::boolean THEN NULLIF($5, '') ELSE email END,
          email_verified = CASE WHEN $4::boolean AND COALESCE(NULLIF($5, ''), '') IS DISTINCT FROM COALESCE(email, '') THEN FALSE ELSE email_verified END,
          updated_at = now()
        WHERE id = $1
        RETURNING id, role, phone_e164 AS phone, display_name AS name, email, email_verified, google_sub IS NOT NULL AS google_linked`,
      [user.id, body.display_name !== undefined, body.display_name ?? null, body.email !== undefined, body.email ?? ''],
    );
    return { data: result.rows[0] };
  });

  app.post('/api/v1/auth/logout', async (request, reply) => {
    const user = await requireAuth(pool, request, reply);
    if (!user) return;
    const token = currentToken(request);
    if (token) {
      await pool.query('UPDATE auth_sessions SET revoked_at = now() WHERE token_hash = $1 AND user_id = $2 AND revoked_at IS NULL', [sha256(token), user.id]);
    }
    clearSessionCookie(reply);
    return reply.code(204).send();
  });
}
