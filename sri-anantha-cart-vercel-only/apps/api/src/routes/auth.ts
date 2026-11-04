import { randomInt } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { verifyGoogleIdToken, type GoogleIdentity } from '../auth/google.js';
import { issueOtpChallenge } from '../auth/otp-challenges.js';
import type { OtpSender } from '../auth/otp-sender.js';
import { hashOtp, normalizeIndianPhone, safeEqualHex } from '../auth/security.js';
import { createSession, requireAuth, requireRole, setSessionCookie, wantsCookieSession, type UserRole } from '../auth/session.js';
import { parseOrReply, withTransaction } from '../lib/http.js';

const OTP_TTL_SECONDS = 300;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_SECONDS = 60;

export type SignedInUser = { id: string; role: UserRole; phone_e164: string | null; display_name: string | null; email: string | null; must_change_password?: boolean };

const STAFF_USE_PASSWORD = { error: 'STAFF_USE_PASSWORD', message: 'Staff accounts sign in with their password on the staff sign-in page.' };

/** Web gets an HttpOnly cookie (token never reaches JavaScript); mobile gets a bearer token for SecureStore. */
export function sendSession(request: FastifyRequest, reply: FastifyReply, session: { token: string; expiresInSeconds: number }, user: SignedInUser) {
  const publicUser = { id: user.id, role: user.role, phone: user.phone_e164, name: user.display_name, email: user.email, must_change_password: user.must_change_password ?? false };
  if (wantsCookieSession(request)) {
    setSessionCookie(reply, session.token, session.expiresInSeconds);
    return reply.code(200).send({ data: { user: publicUser, expiresInSeconds: session.expiresInSeconds } });
  }
  return reply.code(200).send({ data: { accessToken: session.token, tokenType: 'Bearer', expiresInSeconds: session.expiresInSeconds, user: publicUser } });
}

export async function registerAuthRoutes(app: FastifyInstance, pool: Pool, deps: {
  config: AppConfig;
  sendOtp: OtpSender;
  /** Injectable verifier keeps the Google account-linking route testable without live Google credentials. */
  verifyGoogleToken?: (idToken: string, clientIds: string[]) => Promise<GoogleIdentity>;
}): Promise<void> {
  const { config, sendOtp } = deps;
  const verifyGoogle = deps.verifyGoogleToken ?? verifyGoogleIdToken;

  app.post('/api/v1/auth/otp/request', {
    config: { rateLimit: { max: 5, timeWindow: '10 minutes' } },
  }, async (request, reply) => {
    const body = parseOrReply(z.object({ phone: z.string().max(20) }).strict(), request.body, reply);
    if (!body) return;
    const phone = normalizeIndianPhone(body.phone);
    if (!phone || !phone.startsWith('+91') || phone.length !== 13) {
      return reply.code(400).send({ error: 'INVALID_PHONE', message: 'Enter a valid 10-digit Indian mobile number' });
    }
    if (config.sessionSecret.length < 32) {
      return reply.code(503).send({ error: 'AUTH_NOT_CONFIGURED', message: 'Authentication is not configured' });
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const codeHash = hashOtp(phone, code, config.sessionSecret);
    let challengeId: string;
    try {
      const challenge = await issueOtpChallenge(pool, phone, codeHash, OTP_TTL_SECONDS, RESEND_COOLDOWN_SECONDS);
      if (challenge.kind === 'cooldown') return reply.code(429).send({ error: 'OTP_COOLDOWN', message: 'Please wait a minute before requesting another code' });
      if (challenge.kind === 'hourly_limit') return reply.code(429).send({ error: 'OTP_LIMIT', message: 'Too many codes requested for this number. Try again later.' });
      challengeId = challenge.id;
    } catch (error) {
      request.log.error({ err: error }, 'OTP challenge creation failed');
      return reply.code(503).send({ error: 'OTP_SERVICE_UNAVAILABLE', message: 'Verification messages are temporarily unavailable' });
    }
    try {
      const delivery = await sendOtp(phone, code);
      if (delivery.providerMessageId) {
        try { await pool.query('UPDATE otp_challenges SET provider_message_id = $2 WHERE id = $1', [challengeId, delivery.providerMessageId]); }
        catch (error) { request.log.warn({ err: error }, 'OTP provider reference could not be persisted'); }
      }
    } catch (error) {
      await pool.query('DELETE FROM otp_challenges WHERE id = $1 AND consumed_at IS NULL', [challengeId]);
      request.log.error({ err: error }, 'OTP provider delivery failed');
      return reply.code(503).send({ error: 'OTP_DELIVERY_UNAVAILABLE', message: 'Verification messages are temporarily unavailable' });
    }
    return reply.code(202).send({ message: 'A verification code has been sent', expiresInSeconds: OTP_TTL_SECONDS, resendAfterSeconds: RESEND_COOLDOWN_SECONDS });
  });

  // Staging-only tester retrieval. Requires an established admin session; codes
  // are never included in the public OTP request or verification responses.
  app.get('/api/v1/auth/otp/dev-outbox', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    if (!config.allowDevOtp || config.deploymentEnvironment !== 'staging' || config.otpProvider !== 'dev-outbox' || !config.otpDevOutboxPath) {
      return reply.code(404).header('cache-control', 'no-store').send({ error: 'NOT_FOUND' });
    }
    const staff = await requireRole(pool, request, reply, ['admin']);
    if (!staff) return;
    const query = parseOrReply(z.object({ phone: z.string().max(20) }).strict(), request.query, reply);
    if (!query) return;
    const phone = normalizeIndianPhone(query.phone);
    if (!phone || !phone.startsWith('+91') || phone.length !== 13) {
      return reply.code(400).header('cache-control', 'no-store').send({ error: 'INVALID_PHONE' });
    }
    try {
      const raw = await readFile(config.otpDevOutboxPath, 'utf8');
      const cutoff = Date.now() - OTP_TTL_SECONDS * 1000;
      const entries = raw.split('\n').filter(Boolean).slice(-200).flatMap(line => {
        try {
          const item = JSON.parse(line) as { phone?: string; code?: string; at?: string };
          const created = item.at ? Date.parse(item.at) : NaN;
          return item.phone === phone && /^\d{6}$/.test(item.code ?? '') && Number.isFinite(created) && created >= cutoff && created <= Date.now()
            ? [{ code: item.code!, at: item.at! }] : [];
        } catch { return []; }
      });
      const latest = entries.at(-1);
      if (!latest) return reply.code(404).header('cache-control', 'no-store').send({ error: 'OTP_NOT_AVAILABLE', message: 'No active staging code is available for this number' });
      return reply.header('cache-control', 'no-store, private').header('pragma', 'no-cache').send({ data: latest });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return reply.code(404).header('cache-control', 'no-store').send({ error: 'OTP_NOT_AVAILABLE' });
      request.log.error({ err: error }, 'Staging OTP outbox read failed');
      return reply.code(503).header('cache-control', 'no-store').send({ error: 'OTP_OUTBOX_UNAVAILABLE' });
    }
  });

  app.post('/api/v1/auth/otp/verify', {
    config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
  }, async (request, reply) => {
    const body = parseOrReply(z.object({ phone: z.string().max(20), code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') }).strict(), request.body, reply);
    if (!body) return;
    const phone = normalizeIndianPhone(body.phone);
    if (!phone) return reply.code(400).send({ error: 'INVALID_INPUT', message: 'A valid phone number and six-digit code are required' });
    if (config.sessionSecret.length < 32) return reply.code(503).send({ error: 'AUTH_NOT_CONFIGURED', message: 'Authentication is not configured' });

    const outcome = await withTransaction(pool, async client => {
      const result = await client.query<{ id: string; code_hash: string }>(
        `SELECT id, code_hash FROM otp_challenges
          WHERE phone_e164 = $1 AND consumed_at IS NULL AND expires_at > now() AND attempts < $2
          ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [phone, MAX_ATTEMPTS],
      );
      const challenge = result.rows[0];
      if (!challenge) return { kind: 'invalid' as const };
      if (!safeEqualHex(challenge.code_hash, hashOtp(phone, body.code, config.sessionSecret))) {
        await client.query('UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = $1', [challenge.id]);
        return { kind: 'invalid' as const };
      }
      await client.query('UPDATE otp_challenges SET consumed_at = now() WHERE id = $1', [challenge.id]);
      const userResult = await client.query<SignedInUser & { is_active: boolean }>(
        `INSERT INTO users(phone_e164) VALUES ($1)
         ON CONFLICT(phone_e164) DO UPDATE SET updated_at = now()
         RETURNING id, role, phone_e164, display_name, email, is_active`, [phone],
      );
      const user = userResult.rows[0]!;
      if (!user.is_active) return { kind: 'disabled' as const };
      // A text message alone must never open the admin panel (SIM swap / shared phones).
      if (user.role !== 'customer') return { kind: 'staff' as const };
      return { kind: 'ok' as const, user, session: await createSession(client, user.id, user.role) };
    });
    if (outcome.kind === 'invalid') return reply.code(401).send({ error: 'OTP_INVALID', message: 'The code is invalid or expired' });
    if (outcome.kind === 'staff') return reply.code(403).send(STAFF_USE_PASSWORD);
    if (outcome.kind === 'disabled') return reply.code(403).send({ error: 'ACCOUNT_DISABLED', message: 'This account has been blocked. Please contact support.' });
    return sendSession(request, reply, outcome.session, outcome.user);
  });

  app.post('/api/v1/auth/google', {
    config: { rateLimit: { max: 20, timeWindow: '10 minutes' } },
  }, async (request, reply) => {
    const body = parseOrReply(z.object({ id_token: z.string().min(20).max(4096) }).strict(), request.body, reply);
    if (!body) return;
    if (!config.googleClientIds.length) return reply.code(503).send({ error: 'GOOGLE_NOT_CONFIGURED', message: 'Google sign-in is not available yet' });
    let identity;
    try {
      identity = await verifyGoogle(body.id_token, config.googleClientIds);
    } catch (error) {
      request.log.warn({ err: error }, 'Google ID token rejected');
      return reply.code(401).send({ error: 'GOOGLE_TOKEN_INVALID', message: 'Google sign-in could not be verified' });
    }
    if (!identity.emailVerified || !identity.email) return reply.code(401).send({ error: 'GOOGLE_EMAIL_UNVERIFIED', message: 'Use a Google account with a verified email address' });
    const outcome = await withTransaction(pool, async client => {
      // Accounts are matched only by Google's stable subject ID, never by email,
      // so an unverified email typed into another profile cannot be taken over.
      const existing = await client.query<SignedInUser & { is_active: boolean }>(
        `SELECT id, role, phone_e164, display_name, email, is_active FROM users WHERE google_sub = $1 FOR UPDATE`, [identity.sub],
      );
      let user = existing.rows[0];
      if (!user) {
        // The pre-insert SELECT is useful for the normal path, but cannot lock a
        // row that does not exist. Use the partial unique index as a race-safe
        // upsert so simultaneous first sign-ins both resolve to the same account.
        const created = await client.query<SignedInUser & { is_active: boolean }>(
          `INSERT INTO users(google_sub, email, email_verified, display_name) VALUES ($1, $2, TRUE, $3)
           ON CONFLICT (google_sub) WHERE google_sub IS NOT NULL
           DO UPDATE SET updated_at = now()
           RETURNING id, role, phone_e164, display_name, email, is_active`, [identity.sub, identity.email, identity.name],
        );
        user = created.rows[0]!;
      }
      if (!user.is_active) return { kind: 'disabled' as const };
      if (user.role !== 'customer') return { kind: 'staff' as const };
      return { kind: 'ok' as const, user, session: await createSession(client, user.id, user.role) };
    });
    if (outcome.kind === 'disabled') return reply.code(403).send({ error: 'ACCOUNT_DISABLED', message: 'This account has been blocked. Please contact support.' });
    if (outcome.kind === 'staff') return reply.code(403).send(STAFF_USE_PASSWORD);
    return sendSession(request, reply, outcome.session, outcome.user);
  });

  /** Lets a signed-in customer explicitly attach a verified Google identity. */
  app.post('/api/v1/auth/google/link', {
    config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
  }, async (request, reply) => {
    const user = await requireAuth(pool, request, reply);
    if (!user) return;
    if (user.role !== 'customer') return reply.code(403).send(STAFF_USE_PASSWORD);

    const body = parseOrReply(z.object({ id_token: z.string().min(20).max(4096) }).strict(), request.body, reply);
    if (!body) return;
    if (!config.googleClientIds.length) return reply.code(503).send({ error: 'GOOGLE_NOT_CONFIGURED', message: 'Google sign-in is not available yet' });

    let identity;
    try {
      identity = await verifyGoogle(body.id_token, config.googleClientIds);
    } catch {
      return reply.code(401).send({ error: 'GOOGLE_TOKEN_INVALID', message: 'Google sign-in could not be verified' });
    }
    if (!identity.emailVerified || !identity.email) {
      return reply.code(401).send({ error: 'GOOGLE_EMAIL_UNVERIFIED', message: 'Use a Google account with a verified email address' });
    }

    try {
      // The partial unique index on google_sub is the final race-safe guard. The
      // WHERE clause also prevents replacing a different Google identity on this account.
      const linked = await pool.query(
        `UPDATE users
            SET google_sub = $2,
                -- The profile email is also used for order receipts. Preserve a different
                -- customer-supplied address; only adopt/verify the Google email when empty
                -- or when it already matches the verified Google identity.
                email = CASE WHEN email IS NULL THEN $3 ELSE email END,
                email_verified = CASE WHEN email IS NULL OR lower(email) = $3 THEN TRUE ELSE email_verified END,
                updated_at = now()
          WHERE id = $1 AND (google_sub IS NULL OR google_sub = $2)
          RETURNING id`,
        [user.id, identity.sub, identity.email],
      );
      if (!linked.rowCount) {
        return reply.code(409).send({ error: 'GOOGLE_PROFILE_ALREADY_LINKED', message: 'A different Google account is already linked to this profile' });
      }
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        return reply.code(409).send({ error: 'GOOGLE_ALREADY_LINKED', message: 'This Google account is already linked to another profile' });
      }
      request.log.error({ err: error }, 'Google account linking failed');
      return reply.code(503).send({ error: 'GOOGLE_LINK_UNAVAILABLE', message: 'Google account linking is temporarily unavailable' });
    }
    return { data: { linked: true } };
  });
}
