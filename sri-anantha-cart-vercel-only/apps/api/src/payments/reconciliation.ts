import type { Pool } from 'pg';

/** Parse a provider decimal amount without floating-point rounding. */
export function reconciliationAmountToPaise(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{1,8}(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(amount) ? amount : null;
}

export function terminalPaymentOutcomeConflicts(paymentStatus: string, providerOutcome: 'success' | 'failure'): boolean {
  if (paymentStatus === 'succeeded') return providerOutcome !== 'success';
  if (paymentStatus === 'failed' || paymentStatus === 'cancelled') return providerOutcome !== 'failure';
  return true;
}

export async function enqueuePaymentReconciliation(pool: Pool, paymentId: string, reason: string): Promise<void> {
  await pool.query(
    `INSERT INTO payment_reconciliation_jobs (payment_id, status, last_error_code)
     VALUES ($1, 'queued', $2)
     ON CONFLICT (payment_id) DO UPDATE SET
       status = CASE WHEN payment_reconciliation_jobs.status = 'processing' THEN 'processing' ELSE 'queued' END,
       attempts = CASE WHEN payment_reconciliation_jobs.status IN ('resolved','needs_review') THEN 0 ELSE payment_reconciliation_jobs.attempts END,
       next_attempt_at = CASE WHEN payment_reconciliation_jobs.status IN ('resolved','needs_review') THEN now() ELSE LEAST(payment_reconciliation_jobs.next_attempt_at, now()) END,
       resolved_at = CASE WHEN payment_reconciliation_jobs.status IN ('resolved','needs_review') THEN NULL ELSE payment_reconciliation_jobs.resolved_at END,
       locked_at = CASE WHEN payment_reconciliation_jobs.status = 'processing' THEN payment_reconciliation_jobs.locked_at ELSE NULL END,
       last_error_code = EXCLUDED.last_error_code, updated_at = now()`,
    [paymentId, reason.slice(0, 80)],
  );
}
