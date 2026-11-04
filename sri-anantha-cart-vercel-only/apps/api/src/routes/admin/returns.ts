import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { requireRole } from '../../auth/session.js';
import { audit, HttpError, sendHttpError, uuidPattern, withTransaction } from '../../lib/http.js';

const decisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  reason: z.string().trim().max(300).optional(),
}).strict();

const statusSchema = z.object({
  status: z.enum(['pickup_scheduled', 'picked_up', 'in_transit', 'received']),
  pickup_method: z.enum(['self_dropoff', 'courier']).optional(),
  pickup_reference: z.string().trim().max(160).optional(),
  note: z.string().trim().max(300).optional(),
}).strict();

export async function registerAdminReturnRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  app.get<{ Querystring: { status?: string; limit?: string; offset?: string } }>('/api/v1/admin/returns', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['admin', 'operator']);
    if (!user) return;
    const allowed = ['requested', 'accepted', 'rejected', 'pickup_scheduled', 'picked_up', 'in_transit', 'received', 'refund_pending', 'refunded', 'cancelled'];
    if (request.query.status && !allowed.includes(request.query.status)) return reply.code(400).send({ error: 'INVALID_RETURN_STATUS' });
    const limit = Math.min(Math.max(Number.parseInt(request.query.limit ?? '25', 10) || 25, 1), 100);
    const offset = Math.max(Number.parseInt(request.query.offset ?? '0', 10) || 0, 0);
    const values: unknown[] = [];
    const where = request.query.status ? 'WHERE r.status = $1' : '';
    if (request.query.status) values.push(request.query.status);
    values.push(limit, offset);
    const rows = await pool.query(
      "SELECT r.id, r.order_id, o.order_number, ('SA' || (10000 + o.order_number)) AS display_number, r.customer_id, u.display_name AS customer_name, u.phone_e164, r.reason, r.status, r.pickup_method, r.return_carrier, r.pickup_reference, r.parcel_description, r.decided_at, r.received_at, r.created_at, r.updated_at, (SELECT count(*)::integer FROM return_evidence e WHERE e.return_id = r.id) AS evidence_count FROM order_returns r JOIN orders o ON o.id = r.order_id JOIN users u ON u.id = r.customer_id " + where + " ORDER BY r.created_at DESC LIMIT $" + (values.length - 1) + " OFFSET $" + values.length,
      values,
    );
    return { data: rows.rows, pagination: { limit, offset } };
  });

  app.get<{ Params: { orderId: string } }>('/api/v1/admin/orders/:orderId/return', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['admin', 'operator']);
    if (!user) return;
    if (!uuidPattern.test(request.params.orderId)) return reply.code(400).send({ error: 'INVALID_ORDER_ID' });
    const result = await pool.query(
      "SELECT r.id, r.order_id, r.customer_id, r.reason, r.status, r.decision_reason, r.pickup_method, r.return_carrier, r.pickup_reference, r.parcel_description, r.decided_at, r.received_at, r.created_at, r.updated_at, COALESCE((SELECT json_agg(json_build_object('id', e.id, 'content_type', e.content_type, 'byte_size', e.byte_size, 'created_at', e.created_at) ORDER BY e.created_at) FROM return_evidence e WHERE e.return_id = r.id), '[]'::json) AS evidence, COALESCE((SELECT json_agg(json_build_object('from_status', ev.from_status, 'to_status', ev.to_status, 'note', ev.note, 'created_at', ev.created_at) ORDER BY ev.created_at) FROM return_events ev WHERE ev.return_id = r.id), '[]'::json) AS timeline, COALESCE((SELECT json_agg(json_build_object('order_item_id', ri.order_item_id, 'name', ri.product_name_snapshot, 'variant_label', ri.variant_label_snapshot, 'sku', ri.sku_snapshot, 'quantity', ri.quantity, 'unit_price_paise', ri.unit_price_paise, 'refund_amount_paise', ri.refund_amount_paise, 'tax_amount_paise', ri.tax_amount_paise) ORDER BY ri.created_at) FROM order_return_items ri WHERE ri.return_id = r.id), '[]'::json) AS items FROM order_returns r WHERE r.order_id = $1",
      [request.params.orderId],
    );
    if (!result.rows[0]) return reply.code(404).send({ error: 'RETURN_NOT_FOUND' });
    return { data: result.rows[0] };
  });

  app.patch<{ Params: { orderId: string } }>('/api/v1/admin/orders/:orderId/return-decision', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['admin']);
    if (!user) return;
    if (!uuidPattern.test(request.params.orderId)) return reply.code(400).send({ error: 'INVALID_ORDER_ID' });
    const parsed = decisionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_RETURN_DECISION', message: parsed.error.issues[0]?.message });
    if (parsed.data.decision === 'reject' && !parsed.data.reason?.trim()) {
      return reply.code(400).send({ error: 'REJECTION_REASON_REQUIRED', message: 'Provide a clear reason when rejecting a return request' });
    }
    try {
      const result = await withTransaction(pool, async client => {
        const found = await client.query<{ id: string; status: string; pickup_method: string | null; order_status: string }>(
          'SELECT r.id, r.status, r.pickup_method, o.status AS order_status FROM order_returns r JOIN orders o ON o.id = r.order_id WHERE r.order_id = $1 FOR UPDATE OF r, o',
          [request.params.orderId],
        );
        const current = found.rows[0];
        if (!current) throw new HttpError(404, 'RETURN_NOT_FOUND', 'There is no return request for this order');
        if (current.order_status !== 'return_requested') throw new HttpError(409, 'RETURN_ORDER_STATE_MISMATCH', 'The order is no longer in the return-request state');
        if (current.status !== 'requested') throw new HttpError(409, 'RETURN_NOT_PENDING', 'This return has already been reviewed');
        const next = parsed.data.decision === 'approve' ? 'accepted' : 'rejected';
        await client.query(
          'UPDATE order_returns SET status = $2, decision_reason = $3, decided_by = $4, decided_at = now(), updated_at = now() WHERE id = $1',
          [current.id, next, parsed.data.reason ?? null, user.id],
        );
        if (next === 'rejected') {
          await client.query("UPDATE orders SET status = 'delivered', updated_at = now() WHERE id = $1 AND status = 'return_requested'", [request.params.orderId]);
        }
        await client.query(
          'INSERT INTO return_events (return_id, from_status, to_status, note, actor_user_id) VALUES ($1,$2,$3,$4,$5)',
          [current.id, current.status, next, parsed.data.reason ?? null, user.id],
        );
        await audit(client, user.id, 'return.' + next, 'order', request.params.orderId, { return_id: current.id, reason: parsed.data.reason ?? null });
        return { order_id: request.params.orderId, return_id: current.id, status: next, refund_required: false };
      });
      return { data: result };
    } catch (error) {
      if (error instanceof HttpError) return sendHttpError(reply, error);
      throw error;
    }
  });

  app.patch<{ Params: { orderId: string } }>('/api/v1/admin/orders/:orderId/return-status', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['admin', 'operator']);
    if (!user) return;
    if (!uuidPattern.test(request.params.orderId)) return reply.code(400).send({ error: 'INVALID_ORDER_ID' });
    const parsed = statusSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_RETURN_STATUS', message: parsed.error.issues[0]?.message });
    if (parsed.data.status === 'pickup_scheduled' && !parsed.data.pickup_method) {
      return reply.code(400).send({ error: 'PICKUP_METHOD_REQUIRED', message: 'Choose self drop-off or courier pickup' });
    }
    if (parsed.data.status !== 'pickup_scheduled' && parsed.data.pickup_method !== undefined) {
      return reply.code(400).send({ error: 'PICKUP_METHOD_NOT_ALLOWED', message: 'Pickup method can only be selected when scheduling the return' });
    }
    if (!['pickup_scheduled', 'picked_up'].includes(parsed.data.status) && parsed.data.pickup_reference !== undefined) {
      return reply.code(400).send({ error: 'PICKUP_REFERENCE_NOT_ALLOWED', message: 'Pickup reference is only accepted when scheduling or receiving a self drop-off' });
    }
    const transitions: Record<string, string> = {
      accepted: 'pickup_scheduled',
      pickup_scheduled: 'picked_up',
      picked_up: 'received',
      in_transit: 'received',
    };
    try {
      const result = await withTransaction(pool, async client => {
        const found = await client.query<{ id: string; status: string; pickup_method: string | null; order_status: string }>(
          'SELECT r.id, r.status, r.pickup_method, o.status AS order_status FROM order_returns r JOIN orders o ON o.id = r.order_id WHERE r.order_id = $1 FOR UPDATE OF r, o',
          [request.params.orderId],
        );
        const current = found.rows[0];
        if (!current) throw new HttpError(404, 'RETURN_NOT_FOUND', 'There is no return request for this order');
        if (!['return_requested', 'refund_initiated'].includes(current.order_status)) throw new HttpError(409, 'RETURN_ORDER_STATE_MISMATCH', 'The order is no longer in the return workflow');
        const expectedNext = current.status === 'pickup_scheduled' && current.pickup_method === 'courier'
          ? null : transitions[current.status];
        if (expectedNext !== parsed.data.status) {
          throw new HttpError(409, 'INVALID_RETURN_TRANSITION', 'Return must move from ' + current.status + ' to ' + (expectedNext ?? 'a customer courier tracking update or final state'));
        }
        if (parsed.data.status === 'picked_up' && current.pickup_method !== 'self_dropoff') {
          throw new HttpError(409, 'COURIER_PICKUP_REQUIRES_TRACKING', 'Courier returns move to in transit only after the customer submits tracking details');
        }
        if (parsed.data.status === 'received' && !['return_requested', 'refund_initiated'].includes(current.order_status)) {
          throw new HttpError(409, 'RETURN_ORDER_STATE_MISMATCH', 'The order is not in the expected return workflow state');
        }
        await client.query(
          "UPDATE order_returns SET status = $2, pickup_method = COALESCE($3, pickup_method), pickup_reference = COALESCE($4, pickup_reference), received_at = CASE WHEN $2 = 'received' THEN now() ELSE received_at END, updated_at = now() WHERE id = $1",
          [current.id, parsed.data.status, parsed.data.pickup_method ?? null, parsed.data.pickup_reference ?? null],
        );
        if (parsed.data.status === 'received') {
          await client.query("UPDATE orders SET status = 'refund_initiated', updated_at = now() WHERE id = $1 AND status = 'return_requested'", [request.params.orderId]);
        }
        await client.query(
          'INSERT INTO return_events (return_id, from_status, to_status, note, actor_user_id) VALUES ($1,$2,$3,$4,$5)',
          [current.id, current.status, parsed.data.status, parsed.data.note ?? parsed.data.pickup_reference ?? null, user.id],
        );
        await audit(client, user.id, 'return.' + parsed.data.status, 'order', request.params.orderId, {
          return_id: current.id, pickup_method: parsed.data.pickup_method ?? null, pickup_reference: parsed.data.pickup_reference ?? null,
        });
        return { order_id: request.params.orderId, return_id: current.id, status: parsed.data.status, refund_can_be_recorded: parsed.data.status === 'received' };
      });
      return { data: result };
    } catch (error) {
      if (error instanceof HttpError) return sendHttpError(reply, error);
      throw error;
    }
  });
}
