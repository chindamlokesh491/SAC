import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { verifyGoogleIdToken, type GoogleIdentity } from '../auth/google.js';
import { createSession, requireRole, STAFF_ROLES, type UserRole } from '../auth/session.js';
import { audit, withTransaction } from '../lib/http.js';
import { sendSession, type SignedInUser } from './auth.js';

/**
 * Staff Google sign-in is restricted to pre-provisioned staff identities.
 * An email can be linked only when the existing staff record has already
 * been marked email_verified by an administrator. Google tokens are verified
 * against configured OAuth client IDs before any database lookup is trusted.
 */
export async function registerStaffGoogleAuthRoute(
  app: FastifyInstance,
  pool: Pool,
  config: AppConfig,
  verifier: (token: string, clientIds: string[]) => Promise<GoogleIdentity> = verifyGoogleIdToken,
): Promise<void> {
  app.post('/api/v1/auth/staff/google/link', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (request, reply) => {
    const actor = await requireRole(pool, request, reply, STAFF_ROLES);
    if (!actor) return;
    const body = (() => { try { return z.object({ id_token: z.string().min(20).max(4096) }).strict().parse(request.body); } catch { return null; } })();
    if (!body) return reply.code(400).send({ error: 'INVALID_INPUT' });
    if (!config.googleClientIds.length) return reply.code(503).send({ error: 'GOOGLE_NOT_CONFIGURED' });
    let identity: GoogleIdentity;
    try { identity = await verifier(body.id_token, config.googleClientIds); }
    catch { return reply.code(401).send({ error: 'GOOGLE_TOKEN_INVALID' }); }
    if (!identity.email || !identity.emailVerified) return reply.code(401).send({ error: 'GOOGLE_EMAIL_UNVERIFIED' });
    try {
      await withTransaction(pool, async client => {
        const current = await client.query('SELECT google_sub FROM users WHERE id=$1 AND role=ANY($2) FOR UPDATE', [actor.id, STAFF_ROLES]);
        if (!current.rows[0]) throw new Error('STAFF_ACCOUNT_NOT_FOUND');
        if (current.rows[0].google_sub && current.rows[0].google_sub !== identity.sub) throw new Error('GOOGLE_IDENTITY_ALREADY_LINKED');
        await client.query('UPDATE users SET google_sub=$2,email=COALESCE(email,$3),email_verified=CASE WHEN email IS NULL OR lower(email)=$3 THEN TRUE ELSE email_verified END,updated_at=now() WHERE id=$1', [actor.id,identity.sub,(identity.email ?? "").trim().toLowerCase()]);
        await audit(client,actor.id,'staff.google_linked','user',actor.id,{role:actor.role});
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') return reply.code(409).send({ error: 'GOOGLE_ALREADY_LINKED' });
      if (error instanceof Error && error.message === 'GOOGLE_IDENTITY_ALREADY_LINKED') return reply.code(409).send({ error: 'GOOGLE_IDENTITY_ALREADY_LINKED' });
      throw error;
    }
    return { data: { linked: true } };
  });

  app.post('/api/v1/auth/staff/google', {
    config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
  }, async (request, reply) => {
    const body = (() => {
      try { return z.object({ id_token: z.string().min(20).max(4096) }).strict().parse(request.body); }
      catch { return null; }
    })();
    if (!body) return reply.code(400).send({ error: 'INVALID_INPUT', message: 'A valid Google ID token is required' });
    if (!config.googleClientIds.length) return reply.code(503).send({ error: 'GOOGLE_NOT_CONFIGURED', message: 'Google sign-in is not available yet' });

    let identity: GoogleIdentity;
    try {
      identity = await verifier(body.id_token, config.googleClientIds);
    } catch (error) {
      request.log.warn({ err: error }, 'Staff Google ID token rejected');
      return reply.code(401).send({ error: 'GOOGLE_TOKEN_INVALID', message: 'Google sign-in could not be verified' });
    }
    if (!identity.email || !identity.emailVerified) {
      return reply.code(401).send({ error: 'GOOGLE_EMAIL_UNVERIFIED', message: 'Use a Google account with a verified email address' });
    }

    const outcome = await withTransaction(pool, async client => {
      let found = await client.query<SignedInUser & { is_active: boolean; google_sub: string | null }>(
        `SELECT id, role, phone_e164, display_name, email, must_change_password, is_active, google_sub
           FROM users WHERE google_sub = $1 AND role = ANY($2) FOR UPDATE`,
        [identity.sub, STAFF_ROLES],
      );
      let user = found.rows[0];
      if (!user) {
        // Email auto-linking is allowed only for an administrator-preverified staff email.
        found = await client.query<SignedInUser & { is_active: boolean; google_sub: string | null }>(
          `SELECT id, role, phone_e164, display_name, email, must_change_password, is_active, google_sub
             FROM users
            WHERE lower(email) = $1 AND email_verified = TRUE AND role = ANY($2)
            FOR UPDATE`,
          [(identity.email ?? "").trim().toLowerCase(), STAFF_ROLES],
        );
        user = found.rows[0];
        if (!user) return { kind: 'not_provisioned' as const };
        if (user.google_sub && user.google_sub !== identity.sub) return { kind: 'already_linked' as const };
        await client.query(
          `UPDATE users SET google_sub = $2, updated_at = now() WHERE id = $1 AND (google_sub IS NULL OR google_sub = $2)`,
          [user.id, identity.sub],
        );
        await audit(client, user.id, 'staff.google_linked', 'user', user.id, { role: user.role });
      }
      if (!user.is_active) return { kind: 'disabled' as const };
      const session = await createSession(client, user.id, user.role as UserRole);
      return { kind: 'ok' as const, user, session };
    });

    if (outcome.kind === 'not_provisioned') return reply.code(403).send({ error: 'STAFF_ACCOUNT_NOT_PROVISIONED', message: 'This Google account is not linked to an active staff account. Contact an administrator.' });
    if (outcome.kind === 'already_linked') return reply.code(409).send({ error: 'GOOGLE_ACCOUNT_ALREADY_LINKED', message: 'A different Google account is already linked to this staff profile.' });
    if (outcome.kind === 'disabled') return reply.code(403).send({ error: 'ACCOUNT_DISABLED', message: 'This staff account has been disabled.' });
    return sendSession(request, reply, outcome.session, outcome.user);
  });
}
