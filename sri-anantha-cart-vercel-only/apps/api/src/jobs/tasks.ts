import type { Pool } from 'pg';
import { consumeOrderInventory, reconcileExpiredInventoryReservations } from '../inventory/reservations.js';
import { fetchRazorpayOrderPayments, razorpayConfig } from '../payments/razorpay.js';
import { deleteUnusedMedia } from '../media/cleanup.js';
import type { MediaStore } from '../media/store.js';

export type TaskContext = {
  pool: Pool;
  media: MediaStore;
  /** Storefront on-demand revalidation endpoint and its token; unset in local development. */
  storefrontRevalidateUrl: string | null;
  revalidateToken: string | null;
  fetch?: typeof fetch;
  log: (message: string, detail?: Record<string, unknown>) => void;
};
export type Handler = (payload: Record<string, unknown>, context: TaskContext) => Promise<void>;

/** A failure that retrying cannot fix (bad configuration, invalid payload): the job goes straight to 'dead'. */
export class PermanentJobError extends Error {}

/**
 * Every handler is idempotent: running it twice has the same effect as running it once.
 * Provider-side payment reconciliation runs separately from the generic job queue.
 */
export const handlers: Record<string, Handler> = {
  // Releases stock held by unpaid checkouts whose reservation expired (locks each order row).
  'inventory.expire_reservations': async (_payload, { pool, log }) => {
    const result = await reconcileExpiredInventoryReservations(pool, 100);
    if (result.ordersReleased) log('Released expired stock reservations', result);
  },
  // Moves the 90-day sales window forward (cheap: reads product_sales_daily only).
  'catalog.refresh_sales': async (_payload, { pool }) => {
    await pool.query('SELECT refresh_product_sales_summary()');
  },
  // Nightly full recomputation from order history, correcting any drift.
  'catalog.rebuild_sales': async (_payload, { pool }) => {
    await pool.query('SELECT rebuild_product_sales()');
  },
  // Tells the storefront to drop its cached catalogue after an admin change.
  'storefront.revalidate': async (_payload, { storefrontRevalidateUrl, revalidateToken, fetch: fetchImpl = fetch }) => {
    if (!storefrontRevalidateUrl || !revalidateToken) return; // not configured: pages refresh within 60 s anyway
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetchImpl(storefrontRevalidateUrl, { method: 'POST', headers: { 'x-revalidate-token': revalidateToken }, signal: controller.signal });
      if (response.status === 401) throw new PermanentJobError('Storefront rejected the revalidate token (check REVALIDATE_TOKEN on both services)');
      if (!response.ok) throw new Error(`Storefront revalidate returned ${response.status}`);
    } finally { clearTimeout(timer); }
  },
  // Deletes uploaded images that were never attached to anything (e.g. an abandoned product form).
  'media.cleanup_orphans': async (_payload, { pool, media, log }) => {
    const candidates = await pool.query<{ public_url: string }>(
      `SELECT public_url FROM media_assets WHERE created_at < now() - interval '24 hours' AND storage = $1 AND public_url IS NOT NULL
        ORDER BY created_at LIMIT 200`, [media.kind]);
    const removed = await deleteUnusedMedia(pool, media, candidates.rows.map(row => row.public_url));
    if (removed) log('Removed unused images', { removed });
  },
  // Reconcile uncertain/expired Razorpay checkouts with the provider before stock is released.
  'payments.reconcile': async (_payload, { pool, log }) => {
    const config = razorpayConfig();
    if (!config) return; // Credentials are intentionally absent in local/demo environments.
    const claimed = await pool.query<{ id: string; payment_id: string; lease_token: string; attempts: number }>(
      `WITH due AS (
         SELECT id FROM payment_reconciliation_jobs
          WHERE (status IN ('queued','retry') AND next_attempt_at <= now())
             OR (status = 'processing' AND locked_at < now() - interval '5 minutes')
          ORDER BY next_attempt_at, created_at FOR UPDATE SKIP LOCKED LIMIT 20
       )
       UPDATE payment_reconciliation_jobs j
          SET status = 'processing', locked_at = now(), lease_token = gen_random_uuid(),
              attempts = j.attempts + 1, updated_at = now()
         FROM due WHERE j.id = due.id
       RETURNING j.id, j.payment_id, j.lease_token, j.attempts`,
    );
    for (const job of claimed.rows) {
      try {
        const lookup = await pool.query<{ order_id: string; provider_transaction_id: string; amount_paise: number; expires_at: Date | null; payment_status: string; order_status: string }>(
          `SELECT p.order_id, p.provider_transaction_id, p.amount_paise, p.expires_at,
                  o.payment_status, o.status AS order_status
             FROM payments p JOIN orders o ON o.id = p.order_id
            WHERE p.id = $1 AND p.provider = 'razorpay'`, [job.payment_id],
        );
        const payment = lookup.rows[0];
        if (!payment || !payment.provider_transaction_id) {
          await pool.query(`UPDATE payment_reconciliation_jobs SET status = 'needs_review', last_error_code = 'PAYMENT_REFERENCE_MISSING', locked_at = NULL, lease_token = NULL, updated_at = now() WHERE id = $1 AND lease_token = $2`, [job.id, job.lease_token]);
          continue;
        }
        const provider = await fetchRazorpayOrderPayments(config, payment.provider_transaction_id);
        const capturedPayments = provider.items.filter(item => item.status === 'captured' && item.captured === true);
        const captured = capturedPayments[0];
        if (capturedPayments.length > 1 || (captured && (captured.amount !== Number(payment.amount_paise) || captured.currency !== 'INR' || captured.order_id !== payment.provider_transaction_id))) {
          await pool.query(`UPDATE payment_reconciliation_jobs SET status = 'needs_review', last_error_code = 'PROVIDER_AMOUNT_OR_ORDER_MISMATCH', locked_at = NULL, lease_token = NULL, updated_at = now() WHERE id = $1 AND lease_token = $2`, [job.id, job.lease_token]);
          continue;
        }
        if (captured) {
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            const lease = await client.query(`SELECT id FROM payment_reconciliation_jobs WHERE id = $1 AND lease_token = $2 AND status = 'processing' FOR UPDATE`, [job.id, job.lease_token]);
            if (!lease.rowCount) { await client.query('ROLLBACK'); continue; }
            const locked = await client.query<{ status: string; payment_status: string }>(
              `SELECT p.status, o.payment_status FROM payments p JOIN orders o ON o.id = p.order_id
                WHERE p.id = $1 AND p.order_id = $2 FOR UPDATE OF p, o`, [job.payment_id, payment.order_id],
            );
            if (locked.rows[0]?.payment_status !== 'paid') {
              if (!(await consumeOrderInventory(client, payment.order_id))) throw new Error('INVENTORY_RESERVATION_EXPIRED_AFTER_CAPTURE');
              await client.query(`UPDATE payments SET status = 'succeeded', provider_reference = $2, verified_at = now(), updated_at = now() WHERE id = $1`, [job.payment_id, captured.id]);
              await client.query(`UPDATE orders SET payment_status = 'paid', status = 'placed', updated_at = now() WHERE id = $1`, [payment.order_id]);
            }
            await client.query(`UPDATE payment_reconciliation_jobs SET status = 'resolved', resolved_at = now(), locked_at = NULL, lease_token = NULL, last_error_code = NULL, updated_at = now() WHERE id = $1 AND lease_token = $2`, [job.id, job.lease_token]);
            await client.query('COMMIT');
          } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
          continue;
        }
        // Razorpay Orders cannot be cancelled/expired through the Orders API. A local
        // checkout timeout is therefore NOT proof that the provider order is unpayable.
        // Keep the stock reservation and require an operator decision rather than
        // releasing inventory while the customer could still complete payment.
        const expired = payment.expires_at !== null && new Date(payment.expires_at).getTime() <= Date.now();
        if (expired || job.attempts >= 10) {
          await pool.query(
            `UPDATE payment_reconciliation_jobs
                SET status = 'needs_review', last_error_code = $3, locked_at = NULL, lease_token = NULL, updated_at = now()
              WHERE id = $1 AND lease_token = $2`,
            [job.id, job.lease_token, expired ? 'LOCAL_TIMEOUT_PROVIDER_ORDER_STILL_OPEN' : 'PROVIDER_PAYMENT_STILL_UNRESOLVED'],
          );
        } else {
          await pool.query(`UPDATE payment_reconciliation_jobs SET status = 'retry', next_attempt_at = now() + ($3::integer * interval '1 minute'), last_error_code = 'PROVIDER_PAYMENT_PENDING', locked_at = NULL, lease_token = NULL, updated_at = now() WHERE id = $1 AND lease_token = $2`, [job.id, job.lease_token, Math.min(60, 2 ** Math.min(job.attempts, 6))]);
        }
      } catch (error) {
        const code = error instanceof Error ? error.message : 'RAZORPAY_RECONCILIATION_FAILED';
        await pool.query(`UPDATE payment_reconciliation_jobs SET status = CASE WHEN attempts >= 10 THEN 'needs_review' ELSE 'retry' END, next_attempt_at = now() + interval '5 minutes', last_error_code = $3, locked_at = NULL, lease_token = NULL, updated_at = now() WHERE id = $1 AND lease_token = $2`, [job.id, job.lease_token, code.slice(0, 80)]);
        log('Razorpay payment reconciliation failed', { paymentId: job.payment_id, error: code });
      }
    }
    if (claimed.rowCount) log('Razorpay reconciliation batch completed', { claimed: claimed.rowCount });
  },
  // Keeps the queue tables small: finished jobs and published events older than 14 days.
  'jobs.prune': async (_payload, { pool }) => {
    await pool.query(`DELETE FROM jobs WHERE status = 'succeeded' AND finished_at < now() - interval '14 days'`);
    await pool.query(`DELETE FROM outbox_events WHERE published_at < now() - interval '14 days'`);
  },
};

/** Which jobs each outbox topic produces. */
export const outboxRoutes: Record<string, string[]> = {
  'catalog.changed': ['storefront.revalidate'],
};

/** Recurring jobs. Interval schedules enqueue one job per time slot; a dedupe key makes extra workers harmless. */
export type Schedule = { kind: string; everySeconds: number } | { kind: string; dailyAtIst: string };
export const schedules: Schedule[] = [
  { kind: 'inventory.expire_reservations', everySeconds: 60 },
  { kind: 'payments.reconcile', everySeconds: 60 },
  { kind: 'catalog.refresh_sales', everySeconds: 15 * 60 },
  { kind: 'catalog.rebuild_sales', dailyAtIst: '03:10' },
  { kind: 'media.cleanup_orphans', dailyAtIst: '03:40' },
  { kind: 'jobs.prune', dailyAtIst: '04:10' },
];
