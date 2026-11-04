import { randomInt } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { issueOtpChallenge } from '../auth/otp-challenges.js';
import type { OtpSender } from '../auth/otp-sender.js';
import { hashOtp, normalizeIndianPhone, safeEqualHex, sha256 } from '../auth/security.js';
import { clearSessionCookie, createSession, currentToken, requireRole, setSessionCookie, wantsCookieSession } from '../auth/session.js';
import { parseOrReply, withTransaction } from '../lib/http.js';

const TTL = 300;
const COOLDOWN = 60;
const MAX_ATTEMPTS = 5;
/** Partner sign-in codes are hashed under their own subject, so a customer sign-in code for the same
 * number can never open a delivery-partner session (and vice versa). */
const partnerOtpSubject = (phone: string) => `delivery-partner-login:${phone}`;

export async function registerDeliveryPartnerAuthRoutes(app: FastifyInstance, pool: Pool, deps: { config: AppConfig; sendOtp: OtpSender }): Promise<void> {
  app.post('/api/v1/delivery/auth/request-otp', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (request, reply) => {
    const body = parseOrReply(z.object({ phone: z.string().max(20) }).strict(), request.body, reply);
    if (!body) return;
    const phone = normalizeIndianPhone(body.phone);
    if (!phone) return reply.code(400).send({ error: 'INVALID_PHONE', message: 'Enter a valid 10-digit Indian mobile number.' });
    if (deps.config.sessionSecret.length < 32) return reply.code(503).send({ error: 'AUTH_NOT_CONFIGURED' });
    const partner = await pool.query('SELECT id FROM users WHERE phone_e164=$1 AND role=\'delivery_partner\' AND is_active=TRUE AND staff_removed_at IS NULL LIMIT 1', [phone]);
    if (partner.rows[0]) {
      const code = String(randomInt(0, 1000000)).padStart(6, '0');
      const challenge = await issueOtpChallenge(pool, phone, hashOtp(partnerOtpSubject(phone), code, deps.config.sessionSecret), TTL, COOLDOWN);
      if (challenge.kind === 'cooldown') return reply.code(429).send({ error: 'OTP_COOLDOWN', message: 'Wait before requesting another code.' });
      if (challenge.kind === 'hourly_limit') return reply.code(429).send({ error: 'OTP_LIMIT', message: 'Too many codes requested. Try again later.' });
      try {
        const sent = await deps.sendOtp(phone, code, 'login');
        if (sent.providerMessageId) {
          try { await pool.query('UPDATE otp_challenges SET provider_message_id=$2 WHERE id=$1', [challenge.id, sent.providerMessageId]); }
          catch (error) { request.log.warn({ err: error }, 'Partner OTP provider reference could not be persisted'); }
        }
      }
      catch (error) {
        await pool.query('DELETE FROM otp_challenges WHERE id=$1 AND consumed_at IS NULL', [challenge.id]);
        request.log.error({ err: error }, 'Delivery partner OTP delivery failed');
        return reply.code(503).send({ error: 'OTP_DELIVERY_UNAVAILABLE', message: 'Verification messages are temporarily unavailable.' });
      }
    }
    return reply.code(202).send({ message: 'If this number is registered for delivery access, a verification code has been sent.', expiresInSeconds: TTL, resendAfterSeconds: COOLDOWN });
  });

  app.post('/api/v1/delivery/auth/verify-otp', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (request, reply) => {
    const body = parseOrReply(z.object({ phone: z.string().max(20), code: z.string().regex(/^\d{6}$/) }).strict(), request.body, reply);
    if (!body) return;
    const phone = normalizeIndianPhone(body.phone);
    if (!phone || deps.config.sessionSecret.length < 32) return reply.code(401).send({ error: 'OTP_INVALID', message: 'The code is invalid or expired.' });
    const outcome = await withTransaction(pool, async client => {
      const result = await client.query('SELECT id, code_hash FROM otp_challenges WHERE phone_e164=$1 AND consumed_at IS NULL AND expires_at>now() AND attempts<$2 ORDER BY created_at DESC LIMIT 1 FOR UPDATE', [phone, MAX_ATTEMPTS]);
      const challenge = result.rows[0] as { id: string; code_hash: string } | undefined;
      if (!challenge || !safeEqualHex(challenge.code_hash, hashOtp(partnerOtpSubject(phone), body.code, deps.config.sessionSecret))) {
        if (challenge) await client.query('UPDATE otp_challenges SET attempts=attempts+1 WHERE id=$1', [challenge.id]);
        return { kind: 'invalid' as const };
      }
      const found = await client.query('SELECT id, role, phone_e164, display_name, email, must_change_password, is_active FROM users WHERE phone_e164=$1 AND role=\'delivery_partner\' AND is_active=TRUE AND staff_removed_at IS NULL FOR UPDATE', [phone]);
      const user = found.rows[0] as { id: string; role: 'delivery_partner'; phone_e164: string; display_name: string | null; email: string | null; must_change_password: boolean } | undefined;
      await client.query('UPDATE otp_challenges SET consumed_at=now() WHERE id=$1', [challenge.id]);
      if (!user) return { kind: 'invalid' as const };
      const session = await createSession(client, user.id, user.role);
      return { kind: 'ok' as const, user, session };
    });
    if (outcome.kind !== 'ok') return reply.code(401).send({ error: 'OTP_INVALID', message: 'The code is invalid or expired.' });
    const publicUser = { id: outcome.user.id, role: outcome.user.role, phone: outcome.user.phone_e164, name: outcome.user.display_name, email: outcome.user.email, must_change_password: outcome.user.must_change_password };
    if (wantsCookieSession(request)) {
      setSessionCookie(reply, outcome.session.token, outcome.session.expiresInSeconds);
      return { data: { user: publicUser, expiresInSeconds: outcome.session.expiresInSeconds } };
    }
    return { data: { accessToken: outcome.session.token, tokenType: 'Bearer', expiresInSeconds: outcome.session.expiresInSeconds, user: publicUser } };
  });

  app.post('/api/v1/delivery/auth/logout', async (request, reply) => {
    const token = currentToken(request);
    if (token) await pool.query('UPDATE auth_sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL', [sha256(token)]);
    clearSessionCookie(reply);
    return reply.code(200).send({ data: { ok: true } });
  });

  app.get('/api/v1/delivery/me', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['delivery_partner']);
    if (!user) return;
    const result = await pool.query(
      `SELECT u.id,u.delivery_partner_code,u.display_name,u.phone_e164,u.delivery_partner_online,
              (SELECT value->>'support_phone' FROM store_settings WHERE key='store') AS support_phone,
              (SELECT value->>'support_email' FROM store_settings WHERE key='store') AS support_email,
              (SELECT COUNT(*)::integer FROM delivery_assignments a
                WHERE a.delivery_person_id=u.id AND a.status='assigned' AND a.accepted_at IS NULL AND a.delivered_at IS NULL) AS active_count,
              (SELECT COUNT(*)::integer FROM delivery_assignments a
                WHERE a.delivery_person_id=u.id AND a.status='assigned' AND a.accepted_at IS NOT NULL AND a.delivered_at IS NULL) AS in_progress_count,
              (SELECT COUNT(*)::integer FROM delivery_assignments a
                WHERE a.delivery_person_id=u.id AND a.status='completed' AND a.delivered_at::date=CURRENT_DATE) AS completed_today
         FROM users u
        WHERE u.id=$1 AND u.role='delivery_partner' AND u.is_active=TRUE`,
      [user.id],
    );
    const p = result.rows[0] as any;
    if (!p) return reply.code(404).send({ error: 'PARTNER_NOT_FOUND' });
    return { data: { partner: { id: p.id, partnerCode: p.delivery_partner_code, name: p.display_name ?? 'Delivery Partner', phone: p.phone_e164, vehicle: null, online: p.delivery_partner_online }, summary: { assigned: p.active_count, inProgress: p.in_progress_count, completedToday: p.completed_today }, support: { phone: p.support_phone ?? '', email: p.support_email ?? '', termsUrl: '/terms', privacyUrl: '/privacy' } } };
  });

  app.patch('/api/v1/delivery/me/availability', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['delivery_partner']);
    if (!user) return;
    const body = parseOrReply(z.object({ online: z.boolean() }).strict(), request.body, reply);
    if (!body) return;
    await pool.query('UPDATE users SET delivery_partner_online=$2,delivery_partner_availability_changed_at=now(),updated_at=now() WHERE id=$1', [user.id, body.online]);
    return { data: { online: body.online } };
  });
}
