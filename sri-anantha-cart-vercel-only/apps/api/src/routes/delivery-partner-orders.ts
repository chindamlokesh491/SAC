import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { OtpSender } from '../auth/otp-sender.js';
import { requireRole } from '../auth/session.js';
import {
  DELIVERY_OTP_MAX_ATTEMPTS, DELIVERY_OTP_MAX_SENDS, DELIVERY_OTP_TTL_MINUTES, PICKUP_ORDER_STATUSES,
  completeAssignment, issueDeliveryOtp, paymentAllowsFulfilment, recordAssignmentEvent, settleCodDelivery, verifyDeliveryOtp,
} from '../delivery/workflow.js';
import { audit, HttpError, parseOrReply, sendHttpError, withTransaction } from '../lib/http.js';
import { displayOrderNumber } from '../lib/orders.js';

const uuid = z.string().uuid();
const orderParams = z.object({ orderId: uuid }).strict();
const tabSchema = z.enum(['assigned', 'in_progress', 'completed']);
const PARTNER = 'delivery_partner';

type AssignmentRow = {
  assignment_id: string; accepted_at: Date | null; out_for_delivery_at: Date | null; otp_verified_at: Date | null; delivered_at: Date | null;
  order_status: string; payment_method: string | null; payment_status: string; total_paise: number; fulfilment_provider: string;
  delivery_exception: string | null; delivery_address_snapshot: { phone_e164?: string } | null;
};

function stage(row: { status?: string; assignment_status?: string; delivered_at: Date | null; otp_verified_at: Date | null; payment_method: string | null; payment_status: string; out_for_delivery_at: Date | null; accepted_at: Date | null }): string {
  if (row.delivered_at || (row.status ?? row.assignment_status) === 'completed') return 'delivered';
  if (row.otp_verified_at && row.payment_method === 'cod' && row.payment_status !== 'paid') return 'awaiting_cod';
  if (row.out_for_delivery_at) return 'out_for_delivery';
  if (row.accepted_at) return 'awaiting_pickup';
  return 'awaiting_acceptance';
}

/** Lock the caller's active assignment and its order. Only the assigned partner can act on an order. */
async function lockAssignment(client: import('pg').PoolClient, orderId: string, partnerId: string): Promise<AssignmentRow> {
  const found = await client.query<AssignmentRow>(
    `SELECT a.id AS assignment_id, a.accepted_at, a.out_for_delivery_at, a.otp_verified_at, a.delivered_at,
            o.status AS order_status, o.payment_method, o.payment_status, o.total_paise, o.fulfilment_provider,
            o.delivery_exception, o.delivery_address_snapshot
       FROM delivery_assignments a JOIN orders o ON o.id = a.order_id
      WHERE a.order_id = $1 AND a.delivery_person_id = $2 AND a.status = 'assigned'
      FOR UPDATE OF a, o`, [orderId, partnerId],
  );
  const row = found.rows[0];
  if (!row) throw new HttpError(404, 'ORDER_NOT_FOUND', 'This order is not assigned to you.');
  if (row.order_status === 'cancelled') throw new HttpError(409, 'ORDER_CANCELLED', 'This order has been cancelled. Return the items to the store.');
  return row;
}

export async function registerDeliveryPartnerOrderRoutes(app: FastifyInstance, pool: Pool, deps: { config: AppConfig; sendOtp: OtpSender }): Promise<void> {
  const secretReady = () => deps.config.sessionSecret.length >= 32;
  const handle = async <T>(reply: import('fastify').FastifyReply, work: () => Promise<T>): Promise<T | undefined> => {
    try { return await work(); }
    catch (error) {
      if (error instanceof HttpError) { sendHttpError(reply, error); return undefined; }
      throw error;
    }
  };

  app.get('/api/v1/delivery/me/orders', async (request, reply) => {
    const user = await requireRole(pool, request, reply, [PARTNER]);
    if (!user) return;
    const query = parseOrReply(z.object({ tab: tabSchema }).strict(), request.query, reply);
    if (!query) return;
    const filter = query.tab === 'assigned' ? `a.status = 'assigned' AND a.accepted_at IS NULL`
      : query.tab === 'in_progress' ? `a.status = 'assigned' AND a.accepted_at IS NOT NULL AND a.delivered_at IS NULL`
      : `a.status = 'completed' AND a.completed_at > now() - interval '7 days'`;
    const result = await pool.query(
      `SELECT a.id AS assignment_id, a.status AS assignment_status, a.assigned_at, a.accepted_at, a.picked_up_at, a.out_for_delivery_at, a.otp_verified_at, a.delivered_at,
              o.id AS order_id, o.order_number, o.created_at AS placed_at, o.status AS order_status, o.payment_method, o.payment_status, o.total_paise, o.delivery_exception,
              o.delivery_address_snapshot,
              (SELECT COALESCE(SUM(oi.quantity), 0)::integer FROM order_items oi WHERE oi.order_id = o.id) AS unit_count
         FROM delivery_assignments a JOIN orders o ON o.id = a.order_id
        WHERE a.delivery_person_id = $1 AND ${filter}
        ORDER BY ${query.tab === 'completed' ? 'a.completed_at' : 'a.assigned_at'} DESC LIMIT 100`, [user.id],
    );
    return { data: { orders: result.rows.map(r => ({
      orderId: r.order_id, orderNumber: displayOrderNumber(r.order_number), placedAt: r.placed_at, assignedAt: r.assigned_at,
      totalAmount: (Number(r.total_paise) / 100).toFixed(2), paymentMethod: r.payment_method, orderStatus: r.order_status,
      customerName: r.delivery_address_snapshot?.recipient_name ?? 'Customer',
      addressSummary: [r.delivery_address_snapshot?.locality, r.delivery_address_snapshot?.city, r.delivery_address_snapshot?.postal_code].filter(Boolean).join(', '),
      itemCount: r.unit_count, distanceKm: null, assignmentStatus: r.assignment_status, stage: stage(r), deliveryException: r.delivery_exception,
      deliveredAt: r.delivered_at,
    })) } };
  });

  app.get('/api/v1/delivery/me/orders/:orderId', async (request, reply) => {
    const user = await requireRole(pool, request, reply, [PARTNER]);
    if (!user) return;
    const params = parseOrReply(orderParams, request.params, reply);
    if (!params) return;
    const result = await pool.query(
      `SELECT a.*, o.id AS order_id, o.order_number, o.created_at AS placed_at, o.status AS order_status, o.payment_method, o.payment_status, o.total_paise,
              o.delivery_exception, o.delivery_address_snapshot, o.delivery_slot_start, o.delivery_slot_end, o.estimated_delivery_at,
              v.expires_at AS otp_expires_at, v.send_count AS otp_send_count, v.failed_attempts AS otp_failed_attempts,
              (SELECT json_build_object('id', c.id, 'amount', c.amount_paise, 'collectedAt', c.collected_at) FROM order_cod_collections c WHERE c.order_id = o.id) AS collection
         FROM delivery_assignments a JOIN orders o ON o.id = a.order_id
         LEFT JOIN order_delivery_verifications v ON v.order_id = o.id
        WHERE a.order_id = $1 AND a.delivery_person_id = $2 AND a.status IN ('assigned', 'completed')
        ORDER BY (a.status = 'assigned') DESC, a.assigned_at DESC LIMIT 1`, [params.orderId, user.id],
    );
    const r = result.rows[0];
    if (!r) return reply.code(404).send({ error: 'ORDER_NOT_FOUND' });
    const active = r.status === 'assigned';
    const address = r.delivery_address_snapshot ?? {};
    const items = await pool.query('SELECT id, product_name_snapshot AS name, variant_label_snapshot AS variant, quantity, image_url_snapshot AS image_url FROM order_items WHERE order_id = $1 ORDER BY id', [r.order_id]);
    const issues = await pool.query('SELECT id, reason, status, created_at AS reported_at FROM delivery_issues WHERE assignment_id = $1 ORDER BY created_at DESC', [r.id]);
    const total = Number(r.total_paise) / 100;
    const otpIssued = Boolean(r.out_for_delivery_at && r.otp_expires_at);
    reply.header('cache-control', 'no-store');
    return { data: {
      order: { id: r.order_id, orderNumber: displayOrderNumber(r.order_number), placedAt: r.placed_at, status: r.order_status, deliveryException: r.delivery_exception,
        itemCount: items.rows.reduce((n: number, x: { quantity: number }) => n + Number(x.quantity), 0),
        slot: r.delivery_slot_start ? { start: r.delivery_slot_start, end: r.delivery_slot_end } : null, estimatedDeliveryAt: r.estimated_delivery_at },
      assignment: { id: r.id, status: r.status, stage: stage(r), assignedAt: r.assigned_at, acceptedAt: r.accepted_at, pickedUpAt: r.picked_up_at,
        outForDeliveryAt: r.out_for_delivery_at, otpVerifiedAt: r.otp_verified_at, deliveredAt: r.delivered_at,
        readyForPickup: active && (PICKUP_ORDER_STATUSES as readonly string[]).includes(r.order_status) },
      // Contact details are only needed while the delivery is active; history shows the locality only.
      customer: active
        ? { name: address.recipient_name ?? 'Customer', phone: address.phone_e164 ?? '', fullAddress: [address.line1, address.line2, address.locality, address.city, address.state, address.postal_code].filter(Boolean).join(', '),
            address: { line1: address.line1 ?? '', line2: address.line2 ?? null, landmark: address.delivery_instructions ?? null, city: address.city ?? '', state: address.state ?? '', pincode: address.postal_code ?? '' }, location: null }
        : { name: address.recipient_name ?? 'Customer', phone: '', fullAddress: [address.locality, address.city, address.postal_code].filter(Boolean).join(', '), address: null, location: null },
      distanceKm: null,
      items: items.rows.map((i: { id: string; name: string; variant: string | null; quantity: number; image_url: string | null }) => ({ id: i.id, name: i.name, variant: i.variant, quantity: i.quantity, imageUrl: i.image_url })),
      payment: { method: r.payment_method, status: r.payment_status, total: total.toFixed(2),
        codAmount: r.payment_method === 'cod' && r.payment_status !== 'paid' ? total.toFixed(2) : null,
        collection: r.collection ? { amount: (Number(r.collection.amount) / 100).toFixed(2), collectedAt: r.collection.collectedAt } : null },
      // The code itself is never sent to the partner; the customer reads it out.
      otp: otpIssued && !r.otp_verified_at ? { expiresAt: r.otp_expires_at, sendsRemaining: Math.max(0, DELIVERY_OTP_MAX_SENDS - Number(r.otp_send_count ?? 0)),
        attemptsRemaining: Math.max(0, DELIVERY_OTP_MAX_ATTEMPTS - Number(r.otp_failed_attempts ?? 0)) } : null,
      pickup: null, issues: issues.rows.map((i: { id: string; reason: string; status: string; reported_at: Date }) => ({ id: i.id, reason: i.reason, status: i.status, reportedAt: i.reported_at })),
    } };
  });

  app.post('/api/v1/delivery/me/orders/:orderId/accept', async (request, reply) => {
    const user = await requireRole(pool, request, reply, [PARTNER]); if (!user) return;
    const p = parseOrReply(orderParams, request.params, reply); if (!p) return;
    const done = await handle(reply, () => withTransaction(pool, async client => {
      const row = await lockAssignment(client, p.orderId, user.id);
      if (!row.accepted_at) {
        await client.query('UPDATE delivery_assignments SET accepted_at = now(), updated_at = now() WHERE id = $1', [row.assignment_id]);
        await recordAssignmentEvent(client, { assignmentId: row.assignment_id, orderId: p.orderId, deliveryPersonId: user.id, event: 'accepted', fromStatus: 'assigned', toStatus: 'accepted', actorId: user.id, actorRole: PARTNER });
        await audit(client, user.id, 'delivery_assignment.accepted', 'order', p.orderId, { delivery_assignment_id: row.assignment_id });
      }
      return true;
    }));
    if (!done) return;
    return { data: { assignmentStatus: 'accepted' } };
  });

  app.post('/api/v1/delivery/me/orders/:orderId/reject', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (request, reply) => {
    const user = await requireRole(pool, request, reply, [PARTNER]); if (!user) return;
    const p = parseOrReply(orderParams, request.params, reply); if (!p) return;
    const body = parseOrReply(z.object({
      reason: z.enum(['vehicle_unavailable', 'too_far', 'shift_ending', 'personal_emergency', 'other']),
      note: z.string().trim().max(500).optional(),
    }).strict(), request.body, reply);
    if (!body) return;
    if (body.reason === 'other' && !body.note) return reply.code(400).send({ error: 'NOTE_REQUIRED', message: 'Tell the store why you cannot take this order.' });
    const done = await handle(reply, () => withTransaction(pool, async client => {
      const row = await lockAssignment(client, p.orderId, user.id);
      // Once the goods are with the partner, problems go through "report an issue" so the store keeps custody records.
      if (row.out_for_delivery_at) throw new HttpError(409, 'ALREADY_PICKED_UP', 'You have already picked up this order. Report an issue instead.');
      await client.query(
        `UPDATE delivery_assignments SET status = 'reassignment_required', rejected_at = now(), rejection_reason = $2, updated_at = now() WHERE id = $1`,
        [row.assignment_id, body.reason],
      );
      await client.query(`UPDATE orders SET delivery_exception = 'reassignment_required', updated_at = now() WHERE id = $1`, [p.orderId]);
      await recordAssignmentEvent(client, { assignmentId: row.assignment_id, orderId: p.orderId, deliveryPersonId: user.id, event: 'rejected', fromStatus: row.accepted_at ? 'accepted' : 'assigned', toStatus: 'reassignment_required', actorId: user.id, actorRole: PARTNER, metadata: { reason: body.reason, note: body.note ?? null } });
      await client.query(
        `INSERT INTO delivery_notifications_outbox (audience, event_type, order_id, payload) VALUES ('admin', 'delivery.assignment_rejected', $1, $2::jsonb)`,
        [p.orderId, JSON.stringify({ assignment_id: row.assignment_id, reason: body.reason })],
      );
      await audit(client, user.id, 'delivery_assignment.rejected', 'order', p.orderId, { delivery_assignment_id: row.assignment_id, reason: body.reason });
      return true;
    }));
    if (!done) return;
    return { data: { assignmentStatus: 'reassignment_required' } };
  });

  app.post('/api/v1/delivery/me/orders/:orderId/pickup', async (request, reply) => {
    const user = await requireRole(pool, request, reply, [PARTNER]); if (!user) return;
    const p = parseOrReply(orderParams, request.params, reply); if (!p) return;
    if (!secretReady()) return reply.code(503).send({ error: 'DELIVERY_OTP_NOT_CONFIGURED' });
    const result = await handle(reply, () => withTransaction(pool, async client => {
      const row = await lockAssignment(client, p.orderId, user.id);
      if (!row.accepted_at) throw new HttpError(409, 'ASSIGNMENT_NOT_ACCEPTED', 'Accept the order before picking it up.');
      if (row.out_for_delivery_at) throw new HttpError(409, 'ALREADY_OUT_FOR_DELIVERY', 'This order is already out for delivery. Do not generate another customer OTP.');
      if (row.fulfilment_provider !== 'self_delivery') throw new HttpError(409, 'NOT_SELF_DELIVERY', 'This order is not delivered by the store.');
      // State machine: the store must have packed the order (or dispatched it to this partner) first.
      if (!(PICKUP_ORDER_STATUSES as readonly string[]).includes(row.order_status)) throw new HttpError(409, 'ORDER_NOT_READY_FOR_PICKUP', 'The store has not packed this order yet.');
      // Payment is re-checked at pickup, not only at assignment time.
      if (!paymentAllowsFulfilment(row)) throw new HttpError(409, 'ORDER_NOT_PAID', 'This order is not paid and cannot be handed over.');
      if (row.delivery_exception === 'reassignment_required') throw new HttpError(409, 'REASSIGNMENT_REQUIRED', 'The store is reassigning this order.');
      const phone = String(row.delivery_address_snapshot?.phone_e164 ?? '');
      if (!phone) throw new HttpError(409, 'CUSTOMER_PHONE_MISSING', 'The order has no customer phone number. Contact the store.');
      const issued = await issueDeliveryOtp(client, { orderId: p.orderId, phone, secret: deps.config.sessionSecret, resend: false });
      if (issued.kind !== 'ok') throw new HttpError(409, 'INVALID_ORDER_STATE', 'This order has already been verified as delivered.');
      await client.query('UPDATE delivery_assignments SET picked_up_at = COALESCE(picked_up_at, now()), out_for_delivery_at = COALESCE(out_for_delivery_at, now()), updated_at = now() WHERE id = $1', [row.assignment_id]);
      await client.query(
        `UPDATE orders SET status = 'dispatched', picked_up_at = COALESCE(picked_up_at, now()), out_for_delivery_at = COALESCE(out_for_delivery_at, now()), updated_at = now() WHERE id = $1`,
        [p.orderId],
      );
      await recordAssignmentEvent(client, { assignmentId: row.assignment_id, orderId: p.orderId, deliveryPersonId: user.id, event: 'out_for_delivery', fromStatus: 'accepted', toStatus: 'out_for_delivery', actorId: user.id, actorRole: PARTNER });
      await recordAssignmentEvent(client, { assignmentId: row.assignment_id, orderId: p.orderId, deliveryPersonId: user.id, event: 'otp_sent', actorId: user.id, actorRole: PARTNER, metadata: { send_count: issued.sendCount } });
      if (row.order_status === 'packed') {
        await audit(client, user.id, 'order.status_changed', 'order', p.orderId, { from: 'packed', to: 'dispatched', via: 'delivery_partner_pickup', delivery_assignment_id: row.assignment_id });
      }
      await audit(client, user.id, 'delivery.picked_up', 'order', p.orderId, { delivery_assignment_id: row.assignment_id });
      return { phone, code: issued.code };
    }));
    if (!result) return;
    let otpSent = true;
    try { await deps.sendOtp(result.phone, result.code, 'delivery'); }
    catch (error) { otpSent = false; request.log.error({ err: error }, 'Delivery verification OTP send failed'); }
    // The customer can also read the code on their order screen, so a failed SMS does not block delivery.
    return { data: { stage: 'out_for_delivery', otpSent, otpExpiresInSeconds: DELIVERY_OTP_TTL_MINUTES * 60 } };
  });

  app.post('/api/v1/delivery/me/orders/:orderId/resend-otp', { config: { rateLimit: { max: 3, timeWindow: '10 minutes' } } }, async (request, reply) => {
    const user = await requireRole(pool, request, reply, [PARTNER]); if (!user) return;
    const p = parseOrReply(orderParams, request.params, reply); if (!p) return;
    if (!secretReady()) return reply.code(503).send({ error: 'DELIVERY_OTP_NOT_CONFIGURED' });
    const result = await handle(reply, () => withTransaction(pool, async client => {
      const row = await lockAssignment(client, p.orderId, user.id);
      if (!row.out_for_delivery_at) throw new HttpError(409, 'NOT_OUT_FOR_DELIVERY', 'Pick up the order first.');
      if (row.otp_verified_at) throw new HttpError(409, 'DELIVERY_ALREADY_VERIFIED', 'The delivery code has already been verified.');
      const phone = String(row.delivery_address_snapshot?.phone_e164 ?? '');
      if (!phone) throw new HttpError(409, 'CUSTOMER_PHONE_MISSING', 'The order has no customer phone number. Contact the store.');
      const issued = await issueDeliveryOtp(client, { orderId: p.orderId, phone, secret: deps.config.sessionSecret, resend: true });
      if (issued.kind === 'cooldown') throw new HttpError(429, 'OTP_RESEND_COOLDOWN', `Wait ${issued.retryAfterSeconds} seconds before sending another code.`);
      if (issued.kind === 'send_limit') throw new HttpError(429, 'OTP_SEND_LIMIT', 'The maximum number of codes has been sent. Contact the store.');
      if (issued.kind === 'verified') throw new HttpError(409, 'DELIVERY_ALREADY_VERIFIED', 'The delivery code has already been verified.');
      await recordAssignmentEvent(client, { assignmentId: row.assignment_id, orderId: p.orderId, deliveryPersonId: user.id, event: 'otp_sent', actorId: user.id, actorRole: PARTNER, metadata: { send_count: issued.sendCount, resend: true } });
      return { phone, code: issued.code, sendsRemaining: DELIVERY_OTP_MAX_SENDS - issued.sendCount };
    }));
    if (!result) return;
    try { await deps.sendOtp(result.phone, result.code, 'delivery'); }
    catch (error) {
      request.log.error({ err: error }, 'Delivery verification OTP resend failed');
      return { data: { resent: true, otpSent: false, expiresInSeconds: DELIVERY_OTP_TTL_MINUTES * 60, sendsRemaining: result.sendsRemaining } };
    }
    return { data: { resent: true, otpSent: true, expiresInSeconds: DELIVERY_OTP_TTL_MINUTES * 60, sendsRemaining: result.sendsRemaining } };
  });

  app.post('/api/v1/delivery/me/orders/:orderId/verify-otp', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (request, reply) => {
    const user = await requireRole(pool, request, reply, [PARTNER]); if (!user) return;
    const p = parseOrReply(orderParams, request.params, reply); if (!p) return;
    const body = parseOrReply(z.object({ otp: z.string().regex(/^\d{6}$/) }).strict(), request.body, reply); if (!body) return;
    if (!secretReady()) return reply.code(503).send({ error: 'DELIVERY_OTP_NOT_CONFIGURED' });
    const outcome = await handle(reply, () => withTransaction(pool, async client => {
      const row = await lockAssignment(client, p.orderId, user.id);
      if (!row.out_for_delivery_at || row.order_status !== 'dispatched') {
        if (row.otp_verified_at) return { kind: 'already' as const, method: row.payment_method, paid: row.payment_status === 'paid' };
        throw new HttpError(409, 'NOT_OUT_FOR_DELIVERY', 'This order is not out for delivery.');
      }
      if (row.otp_verified_at) return { kind: 'already' as const, method: row.payment_method, paid: row.payment_status === 'paid' };
      const phone = String(row.delivery_address_snapshot?.phone_e164 ?? '');
      const verified = await verifyDeliveryOtp(client, { orderId: p.orderId, phone, code: body.otp, secret: deps.config.sessionSecret, verifierId: user.id });
      if (verified.kind === 'invalid') {
        await recordAssignmentEvent(client, { assignmentId: row.assignment_id, orderId: p.orderId, deliveryPersonId: user.id, event: 'otp_failed', actorId: user.id, actorRole: PARTNER, metadata: { failed_attempt: verified.failedAttempts } });
        return { kind: 'invalid' as const, attemptsRemaining: Math.max(0, DELIVERY_OTP_MAX_ATTEMPTS - verified.failedAttempts) };
      }
      if (verified.kind === 'missing') throw new HttpError(409, 'OTP_NOT_ISSUED', 'No delivery code has been issued for this order.');
      if (verified.kind === 'expired') return { kind: 'expired' as const };
      if (verified.kind === 'locked') return { kind: 'locked' as const };
      if (verified.kind === 'already') return { kind: 'already' as const, method: row.payment_method, paid: row.payment_status === 'paid' };
      await client.query('UPDATE delivery_assignments SET otp_verified_at = now(), updated_at = now() WHERE id = $1', [row.assignment_id]);
      await recordAssignmentEvent(client, { assignmentId: row.assignment_id, orderId: p.orderId, deliveryPersonId: user.id, event: 'otp_verified', actorId: user.id, actorRole: PARTNER });
      await audit(client, user.id, 'order.delivery_otp_verified', 'order', p.orderId, { delivery_assignment_id: row.assignment_id });
      if (row.payment_method === 'cod') return { kind: 'ok' as const, method: row.payment_method, total: Number(row.total_paise) };
      // Prepaid: payment is re-checked before completing delivery.
      if (row.payment_status !== 'paid') throw new HttpError(409, 'ORDER_NOT_PAID', 'This order is not paid. Contact the store before handing it over.');
      await client.query(`UPDATE orders SET status = 'delivered', updated_at = now() WHERE id = $1`, [p.orderId]);
      await completeAssignment(client, row.assignment_id);
      await recordAssignmentEvent(client, { assignmentId: row.assignment_id, orderId: p.orderId, deliveryPersonId: user.id, event: 'delivered', fromStatus: 'out_for_delivery', toStatus: 'completed', actorId: user.id, actorRole: PARTNER });
      await audit(client, user.id, 'order.status_changed', 'order', p.orderId, { from: 'dispatched', to: 'delivered', via: 'delivery_partner_otp', delivery_assignment_id: row.assignment_id });
      return { kind: 'ok' as const, method: row.payment_method, total: Number(row.total_paise) };
    }));
    if (!outcome) return;
    if (outcome.kind === 'locked') return reply.code(429).send({ error: 'OTP_ATTEMPTS_EXCEEDED', message: 'Too many wrong codes. Send a new code to the customer.' });
    if (outcome.kind === 'expired') return reply.code(410).send({ error: 'OTP_EXPIRED', message: 'The delivery code has expired. Send a new code to the customer.' });
    if (outcome.kind === 'invalid') return reply.code(400).send({ error: 'OTP_INVALID', message: 'The delivery code is incorrect.', attemptsRemaining: outcome.attemptsRemaining });
    if (outcome.kind === 'already') return { data: { delivered: outcome.method !== 'cod' || outcome.paid, requiresCod: outcome.method === 'cod' && !outcome.paid } };
    return { data: { delivered: outcome.method !== 'cod', requiresCod: outcome.method === 'cod', ...(outcome.method === 'cod' ? { codAmount: (outcome.total / 100).toFixed(2) } : {}) } };
  });

  app.post('/api/v1/delivery/me/orders/:orderId/cod-collection', async (request, reply) => {
    const user = await requireRole(pool, request, reply, [PARTNER]); if (!user) return;
    const p = parseOrReply(orderParams, request.params, reply); if (!p) return;
    const body = parseOrReply(z.object({ amount: z.string().regex(/^\d{1,8}(?:\.\d{1,2})?$/) }).strict(), request.body, reply); if (!body) return;
    const [rupees, paise = ''] = body.amount.split('.');
    const amountPaise = Number(rupees) * 100 + Number(paise.padEnd(2, '0'));
    const outcome = await handle(reply, () => withTransaction(pool, async client => {
      // An idempotent retry after success finds a completed assignment, so check the collection first.
      const existing = await client.query<{ order_status: string }>(
        `SELECT o.status AS order_status FROM order_cod_collections c JOIN orders o ON o.id = c.order_id
          JOIN delivery_assignments a ON a.id = c.delivery_assignment_id
         WHERE c.order_id = $1 AND a.delivery_person_id = $2`, [p.orderId, user.id],
      );
      if (existing.rows[0]) return { delivered: existing.rows[0].order_status === 'delivered', duplicate: true };
      const row = await lockAssignment(client, p.orderId, user.id);
      if (row.payment_method !== 'cod') throw new HttpError(409, 'NOT_COD', 'This order is prepaid.');
      if (!row.otp_verified_at) throw new HttpError(409, 'DELIVERY_OTP_REQUIRED', 'Verify the customer delivery code first.');
      if (row.order_status !== 'dispatched' || row.payment_status !== 'pending') throw new HttpError(409, 'INVALID_ORDER_STATE', 'This order is not awaiting cash collection.');
      // COD orders cannot be partly refunded before delivery, so the amount due is the order total.
      if (Number(row.total_paise) !== amountPaise) throw new HttpError(409, 'COD_AMOUNT_MISMATCH', `Enter the exact COD amount due: ₹${(Number(row.total_paise) / 100).toFixed(2)}.`);
      await settleCodDelivery(client, { orderId: p.orderId, assignmentId: row.assignment_id, collectorId: user.id, amountPaise });
      await recordAssignmentEvent(client, { assignmentId: row.assignment_id, orderId: p.orderId, deliveryPersonId: user.id, event: 'cod_collected', actorId: user.id, actorRole: PARTNER, metadata: { amount_paise: amountPaise } });
      await recordAssignmentEvent(client, { assignmentId: row.assignment_id, orderId: p.orderId, deliveryPersonId: user.id, event: 'delivered', fromStatus: 'awaiting_cod', toStatus: 'completed', actorId: user.id, actorRole: PARTNER });
      await audit(client, user.id, 'order.cod_collected', 'order', p.orderId, { amount_paise: amountPaise, delivery_assignment_id: row.assignment_id });
      await audit(client, user.id, 'order.status_changed', 'order', p.orderId, { from: 'dispatched', to: 'delivered', via: 'delivery_partner_cod', cash_collected: true });
      return { delivered: true, duplicate: false };
    }));
    if (!outcome) return;
    return { data: outcome };
  });

  app.post('/api/v1/delivery/me/orders/:orderId/report-issue', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (request, reply) => {
    const user = await requireRole(pool, request, reply, [PARTNER]); if (!user) return;
    const p = parseOrReply(orderParams, request.params, reply); if (!p) return;
    const body = parseOrReply(z.object({
      reason: z.enum(['customer_not_available', 'customer_phone_unreachable', 'incorrect_address', 'customer_refused', 'payment_issue', 'other']),
      description: z.string().max(1000).optional(), clientRequestId: uuid,
    }).strict(), request.body, reply);
    if (!body) return;
    if (body.reason === 'other' && !body.description?.trim()) return reply.code(400).send({ error: 'DESCRIPTION_REQUIRED', message: 'Describe the problem.' });
    const issue = await handle(reply, () => withTransaction(pool, async client => {
      const row = await lockAssignment(client, p.orderId, user.id);
      if (!row.accepted_at) throw new HttpError(409, 'ASSIGNMENT_NOT_ACCEPTED', 'Accept the order before reporting a delivery problem, or reject it.');
      const inserted = await client.query<{ id: string; created_at: Date }>(
        `INSERT INTO delivery_issues (order_id, assignment_id, delivery_person_id, reported_by, reason, description, client_request_id)
         VALUES ($1, $2, $3, $3, $4, $5, $6)
         ON CONFLICT (assignment_id, client_request_id) WHERE client_request_id IS NOT NULL DO UPDATE SET updated_at = delivery_issues.updated_at
         RETURNING id, created_at`,
        [p.orderId, row.assignment_id, user.id, body.reason, body.description?.trim() || null, body.clientRequestId],
      );
      await client.query(`UPDATE orders SET delivery_exception = 'issue_reported', updated_at = now() WHERE id = $1`, [p.orderId]);
      await recordAssignmentEvent(client, { assignmentId: row.assignment_id, orderId: p.orderId, deliveryPersonId: user.id, event: 'issue_reported', actorId: user.id, actorRole: PARTNER, metadata: { reason: body.reason, issue_id: inserted.rows[0]!.id } });
      await client.query(
        `INSERT INTO delivery_notifications_outbox (audience, event_type, order_id, payload) VALUES ('admin', 'delivery.issue_reported', $1, $2::jsonb)`,
        [p.orderId, JSON.stringify({ issue_id: inserted.rows[0]!.id, reason: body.reason })],
      );
      await audit(client, user.id, 'delivery.issue_reported', 'order', p.orderId, { issue_id: inserted.rows[0]!.id, reason: body.reason });
      return inserted.rows[0]!;
    }));
    if (!issue) return;
    return { data: { issueId: issue.id, reportedAt: issue.created_at } };
  });
}
