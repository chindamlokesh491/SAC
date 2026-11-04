import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt } from 'node:crypto';
import type { PoolClient } from 'pg';
import { hashOtp, safeEqualHex } from '../auth/security.js';

/**
 * Shared self-delivery rules used by the admin panel, the delivery-partner portal and the
 * customer order screens, so every path enforces the same order state machine, payment
 * rule, OTP policy and COD bookkeeping.
 */

/** Customer delivery OTP policy (Phase 1 decision 5). */
export const DELIVERY_OTP_TTL_MINUTES = 10;
export const DELIVERY_OTP_MAX_ATTEMPTS = 5;
/** Initial send plus three resends. Each send invalidates the previous code. */
export const DELIVERY_OTP_MAX_SENDS = 4;
export const DELIVERY_OTP_RESEND_COOLDOWN_SECONDS = 60;

/** Fulfilment may proceed for verified online payments and for cash-on-delivery orders. */
export function paymentAllowsFulfilment(order: { payment_status: string; payment_method: string | null }): boolean {
  return order.payment_status === 'paid' || (order.payment_method === 'cod' && order.payment_status === 'pending');
}

/** Order statuses from which an assigned partner may pick up (admin has packed it, or already dispatched it). */
export const PICKUP_ORDER_STATUSES = ['packed', 'dispatched'] as const;

/**
 * The OTP is verified by hash. An AES-256-GCM copy, keyed from SESSION_SECRET, exists only so the
 * signed-in customer can see the code on the order screen; it is never returned to staff APIs.
 */
function otpKey(secret: string) { return createHash('sha256').update('sac:delivery-otp:v1:' + secret).digest(); }

export function encryptDeliveryOtp(code: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', otpKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(code, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join(':');
}

export function decryptDeliveryOtp(payload: string, secret: string): string | null {
  const [version, iv, tag, data] = payload.split(':');
  if (version !== 'v1' || !iv || !tag || !data) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', otpKey(secret), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    const code = Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
    return /^\d{6}$/.test(code) ? code : null;
  } catch { return null; }
}

/** The OTP hash is bound to the order as well as the phone, so a code can never verify a different order. */
const otpSubject = (orderId: string, phone: string) => `delivery:${orderId}:${phone}`;
export const hashDeliveryOtp = (orderId: string, phone: string, code: string, secret: string) => hashOtp(otpSubject(orderId, phone), code, secret);

export type IssueOtpResult =
  | { kind: 'ok'; code: string; sendCount: number }
  | { kind: 'cooldown'; retryAfterSeconds: number }
  | { kind: 'send_limit' }
  | { kind: 'verified' };

/**
 * Issue (or re-issue) the customer's delivery OTP inside the caller's transaction.
 * Re-issuing replaces the hash and ciphertext, which invalidates the previous code, and resets
 * the per-code attempt counter; the number of sends per order is capped.
 */
export async function issueDeliveryOtp(client: PoolClient, input: { orderId: string; phone: string; secret: string; resend: boolean }): Promise<IssueOtpResult> {
  const existing = await client.query<{ verified_at: Date | null; send_count: number; last_sent_at: Date | null }>(
    'SELECT verified_at, send_count, last_sent_at FROM order_delivery_verifications WHERE order_id = $1 FOR UPDATE', [input.orderId],
  );
  const row = existing.rows[0];
  if (row?.verified_at) return { kind: 'verified' };
  if (row && input.resend) {
    if (Number(row.send_count) >= DELIVERY_OTP_MAX_SENDS) return { kind: 'send_limit' };
    const elapsed = row.last_sent_at ? (Date.now() - new Date(row.last_sent_at).getTime()) / 1000 : Infinity;
    if (elapsed < DELIVERY_OTP_RESEND_COOLDOWN_SECONDS) return { kind: 'cooldown', retryAfterSeconds: Math.ceil(DELIVERY_OTP_RESEND_COOLDOWN_SECONDS - elapsed) };
  }
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const result = await client.query<{ send_count: number }>(
    `INSERT INTO order_delivery_verifications (order_id, otp_hash, otp_ciphertext, expires_at, failed_attempts, send_count, last_sent_at)
     VALUES ($1, $2, $3, now() + make_interval(mins => $4::int), 0, 1, now())
     ON CONFLICT (order_id) DO UPDATE SET otp_hash = EXCLUDED.otp_hash, otp_ciphertext = EXCLUDED.otp_ciphertext,
       expires_at = EXCLUDED.expires_at, verified_at = NULL, verified_by = NULL, failed_attempts = 0,
       send_count = order_delivery_verifications.send_count + 1, last_sent_at = now(), updated_at = now()
     RETURNING send_count`,
    [input.orderId, hashDeliveryOtp(input.orderId, input.phone, code, input.secret), encryptDeliveryOtp(code, input.secret), DELIVERY_OTP_TTL_MINUTES],
  );
  return { kind: 'ok', code, sendCount: Number(result.rows[0]!.send_count) };
}

export type VerifyOtpResult = { kind: 'ok' } | { kind: 'missing' } | { kind: 'already' } | { kind: 'expired' } | { kind: 'locked' } | { kind: 'invalid'; failedAttempts: number };

/** Server-side, one-time verification. A wrong code counts against the current code's attempt limit. */
export async function verifyDeliveryOtp(client: PoolClient, input: { orderId: string; phone: string; code: string; secret: string; verifierId: string }): Promise<VerifyOtpResult> {
  const found = await client.query<{ otp_hash: string; verified_at: Date | null; expires_at: Date | null; failed_attempts: number }>(
    'SELECT otp_hash, verified_at, expires_at, failed_attempts FROM order_delivery_verifications WHERE order_id = $1 FOR UPDATE', [input.orderId],
  );
  const row = found.rows[0];
  if (!row) return { kind: 'missing' };
  if (row.verified_at) return { kind: 'already' };
  if (!row.expires_at || new Date(row.expires_at).getTime() <= Date.now()) return { kind: 'expired' };
  if (Number(row.failed_attempts) >= DELIVERY_OTP_MAX_ATTEMPTS) return { kind: 'locked' };
  if (!safeEqualHex(row.otp_hash, hashDeliveryOtp(input.orderId, input.phone, input.code, input.secret))) {
    const updated = await client.query<{ failed_attempts: number }>(
      'UPDATE order_delivery_verifications SET failed_attempts = failed_attempts + 1, updated_at = now() WHERE order_id = $1 RETURNING failed_attempts', [input.orderId],
    );
    return { kind: 'invalid', failedAttempts: Number(updated.rows[0]!.failed_attempts) };
  }
  // One-time use: the ciphertext is erased once the code has been consumed.
  await client.query(
    `UPDATE order_delivery_verifications SET verified_at = now(), verified_by = $2, otp_ciphertext = '', updated_at = now() WHERE order_id = $1`,
    [input.orderId, input.verifierId],
  );
  return { kind: 'ok' };
}

/**
 * Record cash collected for a COD order and complete delivery, in the caller's transaction.
 * Every COD self-delivery (partner portal or admin override) produces exactly one
 * order_cod_collections row, so collections reconcile with payments.
 */
export async function settleCodDelivery(client: PoolClient, input: { orderId: string; assignmentId: string; collectorId: string; amountPaise: number }): Promise<void> {
  await client.query(
    `INSERT INTO order_cod_collections (order_id, delivery_assignment_id, collected_by, amount_paise, method) VALUES ($1, $2, $3, $4, 'cash')`,
    [input.orderId, input.assignmentId, input.collectorId, input.amountPaise],
  );
  await client.query(
    `UPDATE payments SET status = 'succeeded', verified_at = now(), collected_by = $2, updated_at = now()
      WHERE order_id = $1 AND provider = 'cod' AND status IN ('pending', 'created')`, [input.orderId, input.collectorId],
  );
  await client.query(`UPDATE orders SET status = 'delivered', payment_status = 'paid', updated_at = now() WHERE id = $1`, [input.orderId]);
  await completeAssignment(client, input.assignmentId);
}

export async function completeAssignment(client: PoolClient, assignmentId: string): Promise<void> {
  await client.query(
    `UPDATE delivery_assignments SET status = 'completed', completed_at = now(), delivered_at = COALESCE(delivered_at, now()), updated_at = now() WHERE id = $1`,
    [assignmentId],
  );
}

export async function recordAssignmentEvent(client: PoolClient, input: {
  assignmentId: string; orderId: string; deliveryPersonId: string; event: string; actorId: string; actorRole: string;
  fromStatus?: string | null; toStatus?: string | null; metadata?: Record<string, unknown>;
}): Promise<void> {
  await client.query(
    `INSERT INTO delivery_assignment_events (assignment_id, order_id, delivery_person_id, event, from_status, to_status, actor_user_id, actor_role, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [input.assignmentId, input.orderId, input.deliveryPersonId, input.event, input.fromStatus ?? null, input.toStatus ?? null,
      input.actorId, input.actorRole, JSON.stringify(input.metadata ?? {})],
  );
}
