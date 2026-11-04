import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { requireRole } from '../../auth/session.js';
import { thumbOf } from '../../catalog/queries.js';
import { releaseOrderInventory, restockConsumedOrderInventory } from '../../inventory/reservations.js';
import { audit, HttpError, likePattern, paging, parseOrReply, sendHttpError, uuidPattern, withTransaction } from '../../lib/http.js';
import { displayOrderNumber, parseOrderReference, STATUS_GROUPS } from '../../lib/orders.js';
import { enqueuePaymentReconciliation } from '../../payments/reconciliation.js';
import { buildInvoice } from '../orders.js';
import { returnRefundCapSql } from '../../lib/return-refund-cap.js';
import { paymentAllowsFulfilment } from '../../delivery/workflow.js';

const ORDER_STATUSES = ['pending_payment', 'placed', 'accepted', 'packed', 'dispatched', 'delivered', 'cancelled', 'return_requested', 'refund_initiated', 'refund_completed', 'refunded'];
const NEXT_STATUS: Record<string, string> = { placed: 'accepted', accepted: 'packed', packed: 'dispatched', dispatched: 'delivered' };
const CANCELLABLE = ['placed', 'accepted', 'packed'];


export async function registerAdminOrderRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  app.get<{ Querystring: Record<string, string | undefined> }>('/api/v1/admin/orders', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['admin', 'operator']);
    if (!user) return;
    const { limit, offset } = paging(request.query, 20, 100);
    const { status, payment_status: paymentStatus, payment_method: paymentMethod, from, to, search } = request.query;
    const values: unknown[] = [];
    const filters: string[] = [];
    if (status) {
      if (STATUS_GROUPS[status]) { values.push(STATUS_GROUPS[status]); filters.push(`o.status = ANY($${values.length})`); }
      else if (ORDER_STATUSES.includes(status)) { values.push(status); filters.push(`o.status = $${values.length}`); }
      else return reply.code(400).send({ error: 'INVALID_ORDER_STATUS', message: 'Unknown status filter' });
    } else {
      filters.push(`o.status <> 'pending_payment'`);
    }
    if (paymentStatus) {
      if (!['pending', 'paid', 'failed', 'cancelled', 'refund_pending', 'refunded'].includes(paymentStatus)) return reply.code(400).send({ error: 'INVALID_PAYMENT_STATUS', message: 'Unknown payment status' });
      values.push(paymentStatus); filters.push(`o.payment_status = $${values.length}`);
    }
    if (paymentMethod) {
      if (!['upi', 'card', 'net_banking', 'wallet', 'cod'].includes(paymentMethod)) return reply.code(400).send({ error: 'INVALID_PAYMENT_METHOD', message: 'Unknown payment method' });
      values.push(paymentMethod); filters.push(`o.payment_method = $${values.length}`);
    }
    if (from) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return reply.code(400).send({ error: 'INVALID_FROM_DATE', message: 'Use YYYY-MM-DD' });
      values.push(from); filters.push(`o.created_at >= ($${values.length}::date::timestamp AT TIME ZONE 'Asia/Kolkata')`);
    }
    if (to) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) return reply.code(400).send({ error: 'INVALID_TO_DATE', message: 'Use YYYY-MM-DD' });
      values.push(to); filters.push(`o.created_at < (($${values.length}::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')`);
    }
    if (search?.trim()) {
      const number = parseOrderReference(search);
      values.push(likePattern(search));
      const like = `$${values.length}`;
      // An explicit order reference (SA10001 or #10001) is an exact, indexed lookup; bare digits may also be part of a phone number.
      if (number && /^\s*(#|SA)/i.test(search)) { values.pop(); values.push(number); filters.push(`o.order_number = $${values.length}`); }
      else if (number) { values.push(number); filters.push(`(o.order_number = $${values.length} OR u.phone_e164 ILIKE ${like} ESCAPE '\\' OR COALESCE(u.display_name, '') ILIKE ${like} ESCAPE '\\')`); }
      else filters.push(`(u.phone_e164 ILIKE ${like} ESCAPE '\\' OR COALESCE(u.display_name, '') ILIKE ${like} ESCAPE '\\' OR o.delivery_address_snapshot->>'recipient_name' ILIKE ${like} ESCAPE '\\')`);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const listValues = [...values, limit, offset];
    const [rows, total, counts] = await Promise.all([
      pool.query(
        // Page first, then count items for the returned rows only: PostgreSQL evaluates select-list
        // subqueries for every row skipped by OFFSET, which made deep pages scale with the offset.
        `SELECT page.*, (SELECT COALESCE(SUM(quantity), 0)::integer FROM order_items WHERE order_id = page.id) AS item_count
           FROM (SELECT o.id, o.order_number, o.status, o.payment_status, o.payment_method, o.total_paise, o.created_at, o.delivery_mode,
                        o.delivery_slot_start, o.estimated_delivery_at, u.phone_e164, COALESCE(u.display_name, o.delivery_address_snapshot->>'recipient_name') AS customer_name
                   FROM orders o JOIN users u ON u.id = o.user_id ${where}
                  ORDER BY o.created_at DESC LIMIT $${listValues.length - 1} OFFSET $${listValues.length}) page
          ORDER BY page.created_at DESC`, listValues),
      pool.query<{ total: number }>(`SELECT COUNT(*)::integer AS total FROM orders o JOIN users u ON u.id = o.user_id ${where}`, values),
      pool.query<{ status: string; count: number }>(`SELECT status, COUNT(*)::integer AS count FROM orders WHERE status <> 'pending_payment' GROUP BY status`),
    ]);
    return {
      data: rows.rows.map(row => ({ ...row, display_number: displayOrderNumber(row.order_number) })),
      pagination: { limit, offset, total: Number(total.rows[0]?.total ?? 0) },
      status_counts: Object.fromEntries(counts.rows.map(row => [row.status, Number(row.count)])),
    };
  });

  app.get<{ Params: { orderId: string } }>('/api/v1/admin/orders/:orderId', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['admin', 'operator']);
    if (!user) return;
    if (!uuidPattern.test(request.params.orderId)) return reply.code(400).send({ error: 'INVALID_ORDER_ID', message: 'Invalid order' });
    const order = await pool.query(
      `SELECT o.*, (SELECT r.status FROM order_returns r WHERE r.order_id = o.id) AS return_status,
              u.phone_e164 AS customer_phone, u.display_name AS customer_name, u.email AS customer_email, u.id AS customer_id, z.name AS zone_name
         FROM orders o JOIN users u ON u.id = o.user_id LEFT JOIN delivery_zones z ON z.id = o.delivery_zone_id
        WHERE o.id = $1`, [request.params.orderId],
    );
    const row = order.rows[0];
    if (!row) return reply.code(404).send({ error: 'ORDER_NOT_FOUND', message: 'Order not found' });
    const [items, payments, refunds, history, returnCap] = await Promise.all([
      pool.query(
        `SELECT oi.id, oi.product_id, oi.product_name_snapshot AS name, oi.variant_label_snapshot AS variant_label, oi.sku_snapshot AS sku,
                oi.unit_price_paise, oi.mrp_paise, oi.quantity, oi.line_total_paise, oi.gst_rate_basis_points, oi.tax_paise, oi.hsn_code_snapshot AS hsn_code,
                oi.image_url_snapshot AS image_url
           FROM order_items oi WHERE oi.order_id = $1 ORDER BY oi.id`, [row.id]),
      pool.query(
        `SELECT id, provider, payment_method, status, amount_paise, provider_transaction_id, provider_reference, verified_at, refund_amount_paise, refund_status, created_at
           FROM payments WHERE order_id = $1`, [row.id]),
      pool.query(`SELECT id, amount_paise, reason, status, method, provider_transaction_id, provider_status, created_at, updated_at FROM refunds WHERE order_id = $1 ORDER BY created_at`, [row.id]),
      pool.query(`SELECT status, payment_status, created_at FROM order_status_history WHERE order_id = $1 ORDER BY created_at, id`, [row.id]),
      pool.query<{ cap: string }>(
        `SELECT ${returnRefundCapSql('$1', '$2::integer')}::text AS cap`,
        [row.id, String(row.total_paise)],
      ),
    ]);
    const refundedOrPending = refunds.rows.filter(refund => ['initiated', 'processing', 'completed'].includes(refund.status)).reduce((sum, refund) => sum + Number(refund.amount_paise), 0);
    const fulfilmentAllowed = paymentAllowsFulfilment(row);
    const refundablePaise = Math.max(0, Math.min(Number(row.total_paise) - refundedOrPending, Number(returnCap.rows[0]?.cap ?? row.total_paise) - refundedOrPending));
    const { idempotency_key: _key, checkout_email: checkoutEmail, delivery_address_snapshot: address, ...rest } = row;
    void _key;
    return {
      data: {
        ...rest,
        display_number: displayOrderNumber(row.order_number),
        checkout_email: checkoutEmail,
        address,
        items: items.rows.map(item => ({ ...item, thumb_url: thumbOf(item.image_url) })),
        payments: payments.rows,
        refunds: refunds.rows,
        timeline: history.rows,
        actions: {
          // Self-delivery: the assigned partner performs dispatch (pickup) and delivery (customer code).
          next_status: fulfilmentAllowed && !(row.fulfilment_provider === 'self_delivery' && ['dispatched', 'delivered'].includes(NEXT_STATUS[row.status] ?? '')) ? NEXT_STATUS[row.status] ?? null : null,
          awaiting_delivery_partner: fulfilmentAllowed && row.fulfilment_provider === 'self_delivery' && ['dispatched', 'delivered'].includes(NEXT_STATUS[row.status] ?? ''),
          can_cancel: CANCELLABLE.includes(row.status),
          can_decide_return: row.status === 'return_requested',
          can_refund: ['paid', 'refund_pending'].includes(row.payment_status) && refundablePaise > 0,
          refundable_paise: refundablePaise,
          collect_cash_on_delivery: row.payment_method === 'cod' && row.payment_status === 'pending',
        },
      },
    };
  });

  app.get<{ Params: { orderId: string } }>('/api/v1/admin/orders/:orderId/invoice', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['admin', 'operator']);
    if (!user) return;
    if (!uuidPattern.test(request.params.orderId)) return reply.code(400).send({ error: 'INVALID_ORDER_ID', message: 'Invalid order' });
    const invoice = await buildInvoice(pool, request.params.orderId, null);
    if (!invoice) return reply.code(404).send({ error: 'INVOICE_NOT_AVAILABLE', message: 'Invoice not available for this order' });
    return { data: invoice };
  });

  app.patch<{ Params: { orderId: string } }>('/api/v1/admin/orders/:orderId/status', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['admin', 'operator']);
    if (!user) return;
    if (!uuidPattern.test(request.params.orderId)) return reply.code(400).send({ error: 'INVALID_ORDER_ID', message: 'Invalid order' });
    const body = parseOrReply(z.object({ status: z.enum(['accepted', 'packed', 'dispatched', 'delivered']) }).strict(), request.body, reply);
    if (!body) return;
    try {
      const result = await withTransaction(pool, async client => {
        const found = await client.query<{ status: string; payment_status: string; payment_method: string | null; fulfilment_provider: string; total_paise: number }>(
          'SELECT status, payment_status, payment_method, fulfilment_provider, total_paise FROM orders WHERE id = $1 FOR UPDATE', [request.params.orderId],
        );
        const current = found.rows[0];
        if (!current) throw new HttpError(404, 'ORDER_NOT_FOUND', 'Order not found');
        if (!paymentAllowsFulfilment(current)) throw new HttpError(409, 'ORDER_NOT_PAID', 'Only paid or cash-on-delivery orders can be fulfilled');
        if (NEXT_STATUS[current.status] !== body.status) throw new HttpError(409, 'INVALID_ORDER_TRANSITION', `An order that is ${current.status.replace('_', ' ')} cannot move to ${body.status}`);
        // Self-delivery leaves the store with the assigned partner: pickup marks it dispatched and the
        // customer's one-time code completes it. Staff cannot skip that hand-over from the admin panel.
        if (current.fulfilment_provider === 'self_delivery' && ['dispatched', 'delivered'].includes(body.status)) {
          throw new HttpError(409, 'DELIVERY_PARTNER_ACTION_REQUIRED', body.status === 'dispatched'
            ? 'Assign a delivery partner. The order is dispatched when the partner picks it up.'
            : 'The delivery partner completes this order with the customer\'s delivery code.');
        }
        let cashCollected = false;
        if (body.status === 'delivered' && current.payment_method === 'cod' && current.payment_status === 'pending') {
          // Marking a COD order delivered records that the cash was collected.
          await client.query(`UPDATE payments SET status = 'succeeded', verified_at = now(), collected_by = $2, updated_at = now() WHERE order_id = $1 AND provider = 'cod' AND status = 'pending'`, [request.params.orderId, user.id]);
          await client.query(`UPDATE orders SET status = 'delivered', payment_status = 'paid', updated_at = now() WHERE id = $1`, [request.params.orderId]);
          cashCollected = true;
        } else {
          await client.query('UPDATE orders SET status = $2, updated_at = now() WHERE id = $1', [request.params.orderId, body.status]);
        }
        await audit(client, user.id, 'order.status_changed', 'order', request.params.orderId, { from: current.status, to: body.status, cash_collected: cashCollected });
        return { order_id: request.params.orderId, previous_status: current.status, status: body.status, cash_collected: cashCollected };
      });
      return { data: result };
    } catch (error) {
      if (error instanceof HttpError) return sendHttpError(reply, error);
      throw error;
    }
  });

  // Cancel or reject before dispatch. Pending gateway payments must be reconciled first so a
  // delayed success cannot charge a cancelled order. Paid orders need a separate refund.
  app.post<{ Params: { orderId: string } }>('/api/v1/admin/orders/:orderId/cancel', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['admin', 'operator']);
    if (!user) return;
    if (!uuidPattern.test(request.params.orderId)) return reply.code(400).send({ error: 'INVALID_ORDER_ID', message: 'Invalid order' });
    const body = parseOrReply(z.object({ reason: z.string().trim().min(3, 'Enter a reason').max(300) }).strict(), request.body, reply);
    if (!body) return;
    let reconcilePaymentId: string | null = null;
    try {
      const result = await withTransaction(pool, async client => {
        const found = await client.query<{ status: string; payment_status: string; payment_method: string | null; payment_id: string | null; provider: string | null; payment_record_status: string | null }>(
          `SELECT o.status, o.payment_status, o.payment_method, p.id AS payment_id, p.provider, p.status AS payment_record_status
             FROM orders o LEFT JOIN payments p ON p.order_id = o.id WHERE o.id = $1 FOR UPDATE OF o`, [request.params.orderId]);
        const order = found.rows[0];
        if (!order) throw new HttpError(404, 'ORDER_NOT_FOUND', 'Order not found');
        if (['dispatched', 'delivered'].includes(order.status)) throw new HttpError(409, 'ORDER_MUST_USE_RETURN_WORKFLOW', 'Dispatched or delivered orders go through the return workflow');
        if (!CANCELLABLE.includes(order.status)) throw new HttpError(409, 'ORDER_NOT_CANCELLABLE', 'This order can no longer be cancelled');
        const isCod = order.provider === 'cod';
        if (!isCod && (order.payment_status === 'pending' || ['created', 'pending'].includes(order.payment_record_status ?? ''))) {
          reconcilePaymentId = order.payment_id;
          throw new HttpError(409, 'PAYMENT_RECONCILIATION_REQUIRED', 'Verify the gateway payment outcome before cancelling this order.');
        }
        const restock = await restockConsumedOrderInventory(client, request.params.orderId);
        let unitsRestored = restock.ok ? restock.units : 0;
        if (!restock.ok) {
          if (restock.reason === 'reservations_not_consumed') unitsRestored = (await releaseOrderInventory(client, request.params.orderId, 'payment_failed')).units;
          else throw new HttpError(409, 'INVENTORY_RECONCILIATION_REQUIRED', 'Stock records for this order need review before cancelling');
        }
        const refundRequired = order.payment_status === 'paid';
        if (isCod) {
          await client.query(`UPDATE payments SET status = 'cancelled', updated_at = now() WHERE order_id = $1 AND provider = 'cod' AND status = 'pending'`, [request.params.orderId]);
          await client.query(`UPDATE orders SET status = 'cancelled', payment_status = CASE WHEN payment_status = 'pending' THEN 'cancelled' ELSE payment_status END, cancellation_reason = $2, updated_at = now() WHERE id = $1`, [request.params.orderId, body.reason]);
        } else {
          await client.query(`UPDATE orders SET status = 'cancelled', cancellation_reason = $2, updated_at = now() WHERE id = $1`, [request.params.orderId, body.reason]);
        }
        await client.query(`UPDATE delivery_assignments SET status = 'cancelled', updated_at = now() WHERE order_id = $1 AND status = 'assigned'`, [request.params.orderId]);
        // A cancelled order must not leave a usable or viewable delivery code behind.
        await client.query(`UPDATE order_delivery_verifications SET expires_at = now(), otp_ciphertext = '', updated_at = now() WHERE order_id = $1 AND verified_at IS NULL`, [request.params.orderId]);
        await audit(client, user.id, 'order.cancelled', 'order', request.params.orderId, { reason: body.reason, refund_required: refundRequired, inventory_units_restored: unitsRestored });
        return { order_id: request.params.orderId, status: 'cancelled', refund_required: refundRequired, inventory_units_restored: unitsRestored };
      });
      return { data: result };
    } catch (error) {
      if (reconcilePaymentId) await enqueuePaymentReconciliation(pool, reconcilePaymentId, 'ADMIN_CANCELLATION_REQUIRES_PAYMENT_RECONCILIATION');
      if (error instanceof HttpError) return sendHttpError(reply, error);
      throw error;
    }
  });

}
