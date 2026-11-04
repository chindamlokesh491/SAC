import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { requireRole } from '../../auth/session.js';
import { audit } from '../../lib/http.js';
import { returnRefundCapSql } from '../../lib/return-refund-cap.js';
import { createRazorpayRefund, fetchRazorpayPaymentRefunds, fetchRazorpayRefund, razorpayConfig } from '../../payments/razorpay.js';
import { deriveRefundOrderState } from '../../payments/refund-state.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function refreshOrderRefundTotals(client: PoolClient, orderId: string, providerReference?: string | null): Promise<void> {
  const orderResult = await client.query<{ status: string; cancellation_reason: string | null; return_reason: string | null; total_paise: number }>(
    'SELECT status, cancellation_reason, return_reason, total_paise FROM orders WHERE id = $1 FOR UPDATE', [orderId],
  );
  const order = orderResult.rows[0];
  if (!order) throw new Error('REFUND_ORDER_NOT_FOUND');
  const totals = await client.query<{ completed_total: string; pending_total: string }>(
    `SELECT COALESCE(SUM(amount_paise) FILTER (WHERE status = 'completed'),0)::text AS completed_total,
            COALESCE(SUM(amount_paise) FILTER (WHERE status IN ('initiated','processing')),0)::text AS pending_total
       FROM refunds WHERE order_id = $1`, [orderId],
  );
  const state = deriveRefundOrderState({
    currentStatus: order.status,
    cancellationReason: order.cancellation_reason,
    returnReason: order.return_reason,
    orderTotalPaise: Number(order.total_paise),
    completedRefundPaise: Number(totals.rows[0]?.completed_total ?? 0),
    pendingRefundPaise: Number(totals.rows[0]?.pending_total ?? 0),
  });
  const refundStatus = state.hasPendingRefund ? 'processing' : state.completedRefundPaise > 0 ? 'completed' : 'failed';
  await client.query('UPDATE orders SET payment_status = $2, status = $3, updated_at = now() WHERE id = $1', [orderId, state.paymentStatus, state.orderStatus]);
  const returnRow = await client.query<{ id: string; status: string; refund_cap_paise: string }>(
    `SELECT r.id, r.status,
            ${returnRefundCapSql('$1', '$2::integer')}::text AS refund_cap_paise
       FROM order_returns r WHERE r.order_id = $1 FOR UPDATE`,
    [orderId, String(order.total_paise)],
  );
  const currentReturn = returnRow.rows[0];
  if (currentReturn && ['received', 'refund_pending'].includes(currentReturn.status)) {
    const returnCap = Number(currentReturn.refund_cap_paise);
    const returnStatus = Number(totals.rows[0]?.completed_total ?? 0) >= returnCap && returnCap > 0 && !state.hasPendingRefund
      ? 'refunded' : state.hasPendingRefund ? 'refund_pending' : 'received';
    if (currentReturn.status !== returnStatus) {
      await client.query('UPDATE order_returns SET status = $2, updated_at = now() WHERE id = $1', [currentReturn.id, returnStatus]);
      await client.query(
        'INSERT INTO return_events (return_id, from_status, to_status, note, actor_user_id) VALUES ($1,$2,$3,$4,NULL)',
        [currentReturn.id, currentReturn.status, returnStatus, 'Refund status synchronized from the refund record'],
      );
    }
  }
  await client.query(
    `UPDATE payments SET status = CASE WHEN $2 = 'refunded' THEN 'refunded' WHEN $2 = 'refund_pending' THEN 'refund_pending' ELSE 'succeeded' END,
            refund_amount_paise = $3, refund_status = $4,
            refunded_at = CASE WHEN $3 > 0 THEN COALESCE(refunded_at, now()) ELSE refunded_at END,
            refund_transaction_id = COALESCE($5, refund_transaction_id), updated_at = now()
       WHERE order_id = $1`,
    [orderId, state.paymentStatus, state.completedRefundPaise, refundStatus, providerReference ?? null],
  );
}

function providerStatus(status: 'pending' | 'processed' | 'failed'): { refund: 'processing' | 'completed' | 'failed'; provider: 'queued' | 'success' | 'failure' } {
  if (status === 'processed') return { refund: 'completed', provider: 'success' };
  if (status === 'failed') return { refund: 'failed', provider: 'failure' };
  return { refund: 'processing', provider: 'queued' };
}

export async function registerAdminRefundRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  app.post<{ Params: { orderId: string }; Body: { amount_paise: number; reason: string } }>('/api/v1/admin/orders/:orderId/refunds', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['admin']);
    if (!user) return;
    const { orderId } = request.params; const body = request.body;
    const idempotencyKey = request.headers['idempotency-key'];
    if (!uuid.test(orderId) || !body || !Number.isSafeInteger(body.amount_paise) || body.amount_paise <= 0 || typeof body.reason !== 'string' || body.reason.trim().length < 3 || body.reason.trim().length > 300) return reply.code(400).send({ error: 'INVALID_REFUND_REQUEST' });
    if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) return reply.code(400).send({ error: 'IDEMPOTENCY_KEY_REQUIRED' });

    const client = await pool.connect();
    let refund: { id: string; amount_paise: number; reason: string; status: string; method: string; provider_status: string | null; provider_refund_id: string | null };
    let gatewayPaymentId: string | null = null;
    let replay = false;
    try {
      await client.query('BEGIN');
      const found = await client.query<{ status: string; payment_status: string; total_paise: number; refund_cap_paise: number; return_reason: string | null; return_status: string | null }>(
        `SELECT o.status, o.payment_status, o.total_paise, o.return_reason,
                ${returnRefundCapSql('o.id', 'o.total_paise')} AS refund_cap_paise,
                (SELECT r.status FROM order_returns r WHERE r.order_id = o.id) AS return_status
           FROM orders o WHERE o.id = $1 FOR UPDATE`, [orderId]);
      const orderRow = found.rows[0];
      const payment = orderRow ? (await client.query<{ id: string; provider: string | null; provider_reference: string | null }>(
        `SELECT id, provider, provider_reference FROM payments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [orderId])).rows[0] : undefined;
      const order = orderRow ? { ...orderRow, payment_id: payment?.id ?? null, provider: payment?.provider ?? null, provider_reference: payment?.provider_reference ?? null } : undefined;
      if (!order) { await client.query('ROLLBACK'); return reply.code(404).send({ error: 'ORDER_NOT_FOUND' }); }
      const priorRequest = await client.query<typeof refund>(
        `SELECT id, amount_paise, reason, status, method, provider_status, provider_refund_id
           FROM refunds WHERE order_id = $1 AND idempotency_key = $2`, [orderId, idempotencyKey]);
      if (priorRequest.rows[0]) {
        refund = priorRequest.rows[0];
        if (Number(refund.amount_paise) !== body.amount_paise || refund.reason !== body.reason.trim()) {
          await client.query('ROLLBACK');
          return reply.code(409).send({ error: 'IDEMPOTENCY_KEY_REUSED' });
        }
        replay = true;
        await client.query('COMMIT');
      } else {
        if (!['paid', 'refund_pending'].includes(order.payment_status)) { await client.query('ROLLBACK'); return reply.code(409).send({ error: 'ORDER_NOT_REFUNDABLE' }); }
        if (order.return_reason && order.return_status !== 'received') {
          await client.query('ROLLBACK');
          return reply.code(409).send({ error: 'RETURN_NOT_RECEIVED', message: 'A new return refund can be recorded only after the returned item is received and checked' });
        }
        const existing = await client.query<{ total: string }>(
          `SELECT COALESCE(SUM(amount_paise),0)::text AS total FROM refunds WHERE order_id = $1 AND status IN ('initiated','processing','completed')`, [orderId]);
        const exposure = Number(existing.rows[0]?.total ?? 0);
        if (body.amount_paise + exposure > Number(order.refund_cap_paise)) { await client.query('ROLLBACK'); return reply.code(409).send({ error: order.return_reason ? 'REFUND_EXCEEDS_RETURN_ITEMS' : 'REFUND_EXCEEDS_ORDER_TOTAL', message: order.return_reason ? 'Refunds for a return cannot exceed the selected return-item value' : 'Refund exceeds the remaining order value' }); }
        const gatewayEnabled = process.env.RAZORPAY_REFUNDS_ENABLED === 'true' && razorpayConfig() !== null && order.provider === 'razorpay' && /^pay_[A-Za-z0-9]+$/.test(order.provider_reference ?? '');
        gatewayPaymentId = gatewayEnabled ? order.provider_reference : null;
        const inserted = await client.query<typeof refund>(
          `INSERT INTO refunds (order_id, payment_id, amount_paise, reason, status, created_by, idempotency_key, method, provider_status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           RETURNING id, amount_paise, reason, status, method, provider_status, provider_refund_id`,
          [orderId, order.payment_id, body.amount_paise, body.reason.trim(), gatewayEnabled ? 'processing' : 'initiated', user.id, idempotencyKey, gatewayEnabled ? 'gateway' : 'manual', gatewayEnabled ? 'requesting' : null]);
        refund = inserted.rows[0]!;
        await refreshOrderRefundTotals(client, orderId);
        await audit(client, user.id, 'refund.recorded', 'order', orderId, { refund_id: refund.id, amount_paise: body.amount_paise, method: refund.method, idempotency_key: idempotencyKey, gateway_call_pending: gatewayEnabled });
        await client.query('COMMIT');
      }
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }

    if (refund.method === 'gateway' && !refund.provider_refund_id && !replay && gatewayPaymentId) {
      const config = razorpayConfig();
      if (config) {
        try {
          const created = await createRazorpayRefund(config, {
            paymentId: gatewayPaymentId,
            amountPaise: body.amount_paise,
            receipt: refund.id.replace(/-/g, '').slice(0, 40),
            idempotencyKey: refund.id.replace(/-/g, '').slice(0, 32),
            notes: { refund_id: refund.id, order_id: orderId },
          });
          const mapped = providerStatus(created.status);
          const update = await pool.connect();
          try {
            await update.query('BEGIN');
            await update.query(
              `UPDATE refunds SET provider_refund_id = $2, provider_status = $3, status = $4, updated_at = now() WHERE id = $1`,
              [refund.id, created.id, mapped.provider, mapped.refund],
            );
            await refreshOrderRefundTotals(update, orderId, created.id);
            await update.query('COMMIT');
            refund.provider_refund_id = created.id; refund.provider_status = mapped.provider; refund.status = mapped.refund;
          } catch (error) { await update.query('ROLLBACK'); throw error; } finally { update.release(); }
        } catch (error) {
          // The provider may have accepted a request before a network timeout. Do not
          // issue another refund automatically; keep it pending for manual reconciliation.
          await pool.query(`UPDATE refunds SET provider_status = 'unknown', status = 'processing', updated_at = now() WHERE id = $1 AND provider_refund_id IS NULL`, [refund.id]);
          request.log.error({ err: error, refundId: refund.id }, 'Razorpay refund result is uncertain; automatic retry suppressed');
          refund.provider_status = 'unknown'; refund.status = 'processing';
        }
      }
    }
    return reply.code(replay ? 200 : refund.method === 'gateway' ? 202 : 201).send({ data: refund, gateway_action_required: refund.method === 'gateway' && !refund.provider_refund_id, idempotent_replay: replay });
  });

  app.get<{ Querystring: { status?: string; limit?: string; offset?: string } }>('/api/v1/admin/refunds', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['admin', 'operator']);
    if (!user) return;
    const limit = Math.min(Math.max(Number.parseInt(request.query.limit ?? '25', 10) || 25, 1), 100);
    const offset = Math.max(Number.parseInt(request.query.offset ?? '0', 10) || 0, 0);
    const values: unknown[] = [];
    let where = '';
    if (request.query.status) {
      if (!['initiated', 'processing', 'completed', 'failed'].includes(request.query.status)) return reply.code(400).send({ error: 'INVALID_REFUND_STATUS_FILTER' });
      values.push(request.query.status); where = `WHERE r.status = $${values.length}`;
    }
    values.push(limit, offset);
    const result = await pool.query(
      `SELECT r.id, r.order_id, o.order_number, 'SA' || (10000 + o.order_number) AS display_number, r.payment_id, r.amount_paise, r.reason, r.status, r.method, o.payment_method,
              r.provider_transaction_id, r.provider_refund_id, r.provider_status,
              r.provider_bank_reference, r.created_at, r.updated_at
         FROM refunds r JOIN orders o ON o.id = r.order_id ${where}
        ORDER BY r.created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return { data: result.rows, pagination: { limit, offset }, capabilities: { razorpay_refunds_enabled: process.env.RAZORPAY_REFUNDS_ENABLED === 'true' && razorpayConfig() !== null } };
  });

  app.post<{ Params: { refundId: string } }>('/api/v1/admin/refunds/:refundId/reconcile', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['admin']);
    if (!user) return;
    if (!uuid.test(request.params.refundId)) return reply.code(400).send({ error: 'INVALID_REFUND_ID' });
    const config = razorpayConfig();
    if (!config) return reply.code(503).send({ error: 'RAZORPAY_NOT_CONFIGURED' });
    const found = await pool.query<{ id: string; order_id: string; payment_id: string | null; provider_refund_id: string | null; method: string }>(
      'SELECT id, order_id, payment_id, provider_refund_id, method FROM refunds WHERE id = $1', [request.params.refundId]);
    const row = found.rows[0];
    if (!row) return reply.code(404).send({ error: 'REFUND_NOT_FOUND' });
    if (row.method !== 'gateway' || !row.payment_id) return reply.code(409).send({ error: 'REFUND_PROVIDER_REFERENCE_UNAVAILABLE' });
    let providerRefundId = row.provider_refund_id;
    if (!providerRefundId) {
      // A network timeout can hide a successful provider response. Search the payment's
      // refunds by the stable receipt derived from our refund UUID before any retry.
      const payment = await pool.query<{ provider_reference: string | null }>(
        "SELECT provider_reference FROM payments WHERE id = $1 AND provider = 'razorpay'", [row.payment_id]);
      const paymentId = payment.rows[0]?.provider_reference;
      if (!paymentId) return reply.code(409).send({ error: 'REFUND_PAYMENT_REFERENCE_UNAVAILABLE' });
      const providerRefunds = await fetchRazorpayPaymentRefunds(config, paymentId);
      const expectedReceipt = row.id.replace(/-/g, '').slice(0, 40);
      const match = providerRefunds.items.find(item => item.receipt === expectedReceipt);
      if (!match) return reply.code(409).send({ error: 'REFUND_NOT_FOUND_AT_PROVIDER', message: 'No matching provider refund was found. Check the Razorpay Dashboard before taking any further action.' });
      providerRefundId = match.id;
    }
    const provider = await fetchRazorpayRefund(config, providerRefundId);
    const mapped = providerStatus(provider.status);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE refunds SET provider_refund_id = COALESCE(provider_refund_id, $2), provider_status = $3, status = $4, updated_at = now() WHERE id = $1`, [row.id, provider.id, mapped.provider, mapped.refund]);
      await refreshOrderRefundTotals(client, row.order_id, provider.id);
      await audit(client, user.id, 'refund.reconciled', 'refund', row.id, { provider_refund_id: provider.id, provider_status: provider.status });
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    return { data: { refund_id: row.id, status: mapped.refund, provider_status: mapped.provider } };
  });

  app.patch<{ Params: { refundId: string }; Body: { status: 'processing' | 'completed' | 'failed'; provider_transaction_id?: string } }>('/api/v1/admin/refunds/:refundId/status', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['admin']);
    if (!user) return;
    const { refundId } = request.params; const body = request.body;
    if (!uuid.test(refundId) || !body || !['processing', 'completed', 'failed'].includes(body.status) || (body.provider_transaction_id !== undefined && (typeof body.provider_transaction_id !== 'string' || body.provider_transaction_id.trim().length < 1 || body.provider_transaction_id.length > 160))) return reply.code(400).send({ error: 'INVALID_REFUND_STATUS' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query<{ order_id: string; status: string; method: string; provider_status: string | null }>(
        'SELECT order_id, status, method, provider_status FROM refunds WHERE id = $1 FOR UPDATE', [refundId]);
      const refund = found.rows[0];
      if (!refund) { await client.query('ROLLBACK'); return reply.code(404).send({ error: 'REFUND_NOT_FOUND' }); }
      if (refund.method === 'gateway' || refund.provider_status) { await client.query('ROLLBACK'); return reply.code(409).send({ error: 'PROVIDER_MANAGED_REFUND' }); }
      if (['completed', 'failed'].includes(refund.status)) { await client.query('ROLLBACK'); return reply.code(409).send({ error: 'REFUND_ALREADY_FINAL' }); }
      await client.query('UPDATE refunds SET status = $2, provider_transaction_id = COALESCE($3, provider_transaction_id), updated_at = now() WHERE id = $1', [refundId, body.status, body.provider_transaction_id?.trim() ?? null]);
      await refreshOrderRefundTotals(client, refund.order_id, body.provider_transaction_id?.trim() ?? null);
      await audit(client, user.id, 'refund.status_changed', 'refund', refundId, { status: body.status, provider_transaction_id: body.provider_transaction_id ?? null, gateway_confirmed_by_admin: true });
      await client.query('COMMIT');
      return { data: { refund_id: refundId, status: body.status } };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  });
}
