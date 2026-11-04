import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import type { AppConfig } from '../config.js';
import type { OtpSender } from '../auth/otp-sender.js';
import { requireAuth } from '../auth/session.js';
import { DELIVERY_OTP_MAX_SENDS, DELIVERY_OTP_TTL_MINUTES, decryptDeliveryOtp, issueDeliveryOtp, recordAssignmentEvent } from '../delivery/workflow.js';
import { audit, HttpError, sendHttpError, uuidPattern, withTransaction } from '../lib/http.js';

type OutForDelivery = {
  assignment_id: string; delivery_person_id: string; otp_ciphertext: string | null; expires_at: Date | null; verified_at: Date | null;
  send_count: number | null; phone: string | null;
};

/**
 * The customer's view of their delivery code. The code is shown only to the signed-in customer who
 * owns the order, and only while that order is out for delivery and the code is unused and unexpired.
 */
async function findOutForDelivery(db: Pool | PoolClient, orderId: string, userId: string, lock = false): Promise<OutForDelivery | null> {
  const result = await db.query<OutForDelivery>(
    `SELECT a.id AS assignment_id, a.delivery_person_id, v.otp_ciphertext, v.expires_at, v.verified_at, v.send_count,
            o.delivery_address_snapshot->>'phone_e164' AS phone
       FROM orders o
       JOIN delivery_assignments a ON a.order_id = o.id AND a.status = 'assigned' AND a.out_for_delivery_at IS NOT NULL
       LEFT JOIN order_delivery_verifications v ON v.order_id = o.id
      WHERE o.id = $1 AND o.user_id = $2 AND o.status = 'dispatched' AND o.fulfilment_provider = 'self_delivery'
      ${lock ? 'FOR UPDATE OF o, a' : ''}`, [orderId, userId],
  );
  return result.rows[0] ?? null;
}

export async function registerCustomerDeliveryOtpRoutes(app: FastifyInstance, pool: Pool, deps: { config: AppConfig; sendOtp: OtpSender }): Promise<void> {
  app.get<{ Params: { orderId: string } }>('/api/v1/orders/:orderId/delivery-otp', { config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } }, async (request, reply) => {
    const user = await requireAuth(pool, request, reply);
    if (!user) return;
    if (!uuidPattern.test(request.params.orderId)) return reply.code(400).send({ error: 'INVALID_ORDER_ID' });
    reply.header('cache-control', 'no-store');
    const row = await findOutForDelivery(pool, request.params.orderId, user.id);
    if (!row || row.verified_at) return reply.code(404).send({ error: 'DELIVERY_OTP_NOT_AVAILABLE', message: 'A delivery code is shown here when your order is out for delivery.' });
    const expired = !row.expires_at || new Date(row.expires_at).getTime() <= Date.now();
    const code = !expired && row.otp_ciphertext ? decryptDeliveryOtp(row.otp_ciphertext, deps.config.sessionSecret) : null;
    const sendsRemaining = Math.max(0, DELIVERY_OTP_MAX_SENDS - Number(row.send_count ?? 0));
    if (!code) return { data: { status: 'expired', otp: null, expires_at: row.expires_at, can_request_new: sendsRemaining > 0 } };
    return { data: { status: 'active', otp: code, expires_at: row.expires_at, can_request_new: sendsRemaining > 0 } };
  });

  /** The customer may ask for a new code (for example after it expired); the previous code stops working. */
  app.post<{ Params: { orderId: string } }>('/api/v1/orders/:orderId/delivery-otp/resend', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (request, reply) => {
    const user = await requireAuth(pool, request, reply);
    if (!user) return;
    if (!uuidPattern.test(request.params.orderId)) return reply.code(400).send({ error: 'INVALID_ORDER_ID' });
    if (deps.config.sessionSecret.length < 32) return reply.code(503).send({ error: 'DELIVERY_OTP_NOT_CONFIGURED' });
    try {
      const issued = await withTransaction(pool, async client => {
        const row = await findOutForDelivery(client, request.params.orderId, user.id, true);
        if (!row || row.verified_at) throw new HttpError(404, 'DELIVERY_OTP_NOT_AVAILABLE', 'This order is not waiting for a delivery code.');
        if (!row.phone) throw new HttpError(409, 'CUSTOMER_PHONE_MISSING', 'This order has no phone number.');
        const result = await issueDeliveryOtp(client, { orderId: request.params.orderId, phone: row.phone, secret: deps.config.sessionSecret, resend: true });
        if (result.kind === 'cooldown') throw new HttpError(429, 'OTP_RESEND_COOLDOWN', `Wait ${result.retryAfterSeconds} seconds before requesting another code.`);
        if (result.kind === 'send_limit') throw new HttpError(429, 'OTP_SEND_LIMIT', 'No more codes can be sent for this order. Please contact the store.');
        if (result.kind === 'verified') throw new HttpError(409, 'DELIVERY_ALREADY_VERIFIED', 'Your order has already been verified.');
        await recordAssignmentEvent(client, { assignmentId: row.assignment_id, orderId: request.params.orderId, deliveryPersonId: row.delivery_person_id, event: 'otp_sent', actorId: user.id, actorRole: 'customer', metadata: { send_count: result.sendCount, resend: true, requested_by: 'customer' } });
        await audit(client, user.id, 'order.delivery_otp_resent', 'order', request.params.orderId, { send_count: result.sendCount });
        return { phone: row.phone, code: result.code };
      });
      try { await deps.sendOtp(issued.phone, issued.code, 'delivery'); }
      catch (error) { request.log.error({ err: error }, 'Customer delivery OTP resend SMS failed'); }
      reply.header('cache-control', 'no-store');
      return { data: { status: 'active', otp: issued.code, expires_in_seconds: DELIVERY_OTP_TTL_MINUTES * 60 } };
    } catch (error) {
      if (error instanceof HttpError) return sendHttpError(reply, error);
      throw error;
    }
  });
}
