import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { consumeOrderInventory } from '../inventory/reservations.js';
import { withTransaction } from '../lib/http.js';
import { razorpayConfig, verifyRazorpayWebhookSignature } from '../payments/razorpay.js';
import { deriveRefundOrderState } from '../payments/refund-state.js';

type RazorpayWebhookBody = {
  event?: string;
  payload?: {
    payment?: { entity?: { id?: string; order_id?: string; amount?: number; currency?: string; status?: string; captured?: boolean } };
    refund?: { entity?: { id?: string; payment_id?: string; status?: 'pending' | 'processed' | 'failed'; amount?: number } };
  };
};

/** Public provider callback. Signature is checked against the original request bytes. */
export async function registerRazorpayWebhookRoute(app: FastifyInstance, pool: Pool): Promise<void> {
  app.post('/api/v1/webhooks/razorpay', async (request, reply) => {
    const config = razorpayConfig();
    const signature = request.headers['x-razorpay-signature'];
    const eventId = request.headers['x-razorpay-event-id'];
    const rawBody = (request as FastifyRequest & { rawBody?: Buffer }).rawBody;
    if (!config?.webhookSecret || typeof signature !== 'string' || typeof eventId !== 'string' || !rawBody) {
      return reply.code(503).send({ error: 'WEBHOOK_NOT_CONFIGURED' });
    }
    if (!verifyRazorpayWebhookSignature(rawBody, signature, config.webhookSecret)) {
      return reply.code(400).send({ error: 'INVALID_WEBHOOK_SIGNATURE' });
    }
    const body = request.body as RazorpayWebhookBody;
    if (!body || typeof body.event !== 'string' || !/^[a-z][a-z_.]{1,99}$/.test(body.event) || eventId.length < 1 || eventId.length > 200) {
      return reply.code(400).send({ error: 'INVALID_WEBHOOK_EVENT' });
    }

    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO webhook_events (provider, event_id, event_type, payload, signature_verified, status)
       VALUES ('razorpay', $1, $2, $3::jsonb, true, 'received')
       ON CONFLICT (provider, event_id) DO UPDATE SET
         attempts = webhook_events.attempts + 1,
         status = CASE WHEN webhook_events.status IN ('failed','received') THEN 'received' ELSE webhook_events.status END,
         last_error = NULL
       WHERE webhook_events.status IN ('failed','received')
       RETURNING id`, [eventId, body.event, JSON.stringify(body)],
    );
    const eventRow = inserted.rows[0];
    if (!eventRow) return reply.code(200).send({ received: true, duplicate: true });

    try {
      if (body.event === 'payment.captured') {
        const payment = body.payload?.payment?.entity;
        if (!payment?.id || !payment.order_id || !Number.isSafeInteger(payment.amount) || payment.currency !== 'INR' || payment.status !== 'captured' || payment.captured !== true) {
          throw new Error('WEBHOOK_PAYMENT_ENTITY_INVALID');
        }
        await withTransaction(pool, async client => {
          const result = await client.query<{ id: string; order_id: string; amount_paise: number; status: string; payment_status: string; order_status: string; provider_reference: string | null }>(
            `SELECT p.id, p.order_id, p.amount_paise, p.status, p.provider_reference, o.payment_status, o.status AS order_status
               FROM payments p JOIN orders o ON o.id = p.order_id
              WHERE p.provider = 'razorpay' AND p.provider_transaction_id = $1
              FOR UPDATE OF p, o`, [payment.order_id],
          );
          const stored = result.rows[0];
          if (!stored || Number(stored.amount_paise) !== payment.amount) throw new Error('WEBHOOK_PAYMENT_MISMATCH');
          if (stored.payment_status === 'paid') {
            if (stored.provider_reference !== payment.id) throw new Error('DUPLICATE_CAPTURE_REQUIRES_MANUAL_REVIEW');
            await client.query(`UPDATE webhook_events SET status = 'processed', processed_at = now() WHERE id = $1`, [eventRow.id]);
            return;
          }
          if (stored.order_status !== 'pending_payment' || !['pending','created'].includes(stored.status)) throw new Error('WEBHOOK_ORDER_STATE_MISMATCH');
          if (!(await consumeOrderInventory(client, stored.order_id))) throw new Error('WEBHOOK_INVENTORY_RESERVATION_EXPIRED');
          await client.query(
            `UPDATE payments SET status = 'succeeded', provider_reference = $2, verified_at = now(), updated_at = now()
              WHERE id = $1 AND status IN ('created','pending')`, [stored.id, payment.id],
          );
          await client.query(`UPDATE orders SET payment_status = 'paid', status = 'placed', updated_at = now() WHERE id = $1`, [stored.order_id]);
          await client.query(`UPDATE webhook_events SET status = 'processed', processed_at = now() WHERE id = $1`, [eventRow.id]);
        });
      } else if (body.event === 'refund.processed' || body.event === 'refund.failed') {
        const refund = body.payload?.refund?.entity;
        if (!refund?.id || !refund.payment_id || !refund.status) throw new Error('WEBHOOK_REFUND_ENTITY_INVALID');
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const found = await client.query<{ id: string; order_id: string }>(
            `SELECT r.id, r.order_id FROM refunds r JOIN payments p ON p.id = r.payment_id
              WHERE r.provider_refund_id = $1 AND p.provider_reference = $2 AND r.method = 'gateway' FOR UPDATE OF r, p`,
            [refund.id, refund.payment_id],
          );
          const row = found.rows[0];
          if (!row) throw new Error('WEBHOOK_REFUND_NOT_MATCHED');
          if (row) {
            const status = refund.status === 'processed' ? 'completed' : refund.status === 'failed' ? 'failed' : 'processing';
            const providerStatus = refund.status === 'processed' ? 'success' : refund.status === 'failed' ? 'failure' : 'queued';
            await client.query(`UPDATE refunds SET status = $2, provider_status = $3, updated_at = now() WHERE id = $1`, [row.id, status, providerStatus]);
            const orderResult = await client.query<{ status: string; cancellation_reason: string | null; return_reason: string | null; total_paise: number }>(
              'SELECT status, cancellation_reason, return_reason, total_paise FROM orders WHERE id = $1 FOR UPDATE', [row.order_id],
            );
            const totals = await client.query<{ completed_total: string; pending_total: string }>(
              `SELECT COALESCE(SUM(amount_paise) FILTER (WHERE status = 'completed'),0)::text AS completed_total,
                      COALESCE(SUM(amount_paise) FILTER (WHERE status IN ('initiated','processing')),0)::text AS pending_total
                 FROM refunds WHERE order_id = $1`, [row.order_id],
            );
            const order = orderResult.rows[0];
            if (order) {
              const state = deriveRefundOrderState({ currentStatus: order.status, cancellationReason: order.cancellation_reason, returnReason: order.return_reason, orderTotalPaise: Number(order.total_paise), completedRefundPaise: Number(totals.rows[0]?.completed_total ?? 0), pendingRefundPaise: Number(totals.rows[0]?.pending_total ?? 0) });
              const paymentRefundStatus = state.hasPendingRefund ? 'processing' : state.completedRefundPaise > 0 ? 'completed' : 'failed';
              await client.query('UPDATE orders SET payment_status = $2, status = $3, updated_at = now() WHERE id = $1', [row.order_id, state.paymentStatus, state.orderStatus]);
              await client.query(`UPDATE payments SET status = CASE WHEN $2 = 'refunded' THEN 'refunded' WHEN $2 = 'refund_pending' THEN 'refund_pending' ELSE 'succeeded' END, refund_amount_paise = $3, refund_status = $4, updated_at = now() WHERE order_id = $1`, [row.order_id, state.paymentStatus, state.completedRefundPaise, paymentRefundStatus]);
            }
          }
          await client.query(`UPDATE webhook_events SET status = 'processed', processed_at = now() WHERE id = $1`, [eventRow.id]);
          await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
      } else {
        // Other verified events are durably recorded for future provider-specific handlers.
        await pool.query(`UPDATE webhook_events SET status = 'ignored', processed_at = now() WHERE id = $1`, [eventRow.id]);
      }
      return reply.code(200).send({ received: true });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'WEBHOOK_PROCESSING_FAILED';
      await pool.query(`UPDATE webhook_events SET status = 'failed', last_error = $2 WHERE id = $1`, [eventRow.id, code.slice(0, 2000)]);
      request.log.error({ err: error, eventId }, 'Razorpay webhook processing failed');
      return reply.code(500).send({ error: 'WEBHOOK_PROCESSING_FAILED' });
    }
  });
}
