BEGIN;

-- This migration intentionally fails rather than silently orphaning old PayU
-- gateway records. Reconcile/export any historical PayU payments before upgrade.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM payments WHERE provider = 'payu') THEN
    RAISE EXCEPTION 'PayU payment records exist; reconcile/export them before switching the provider constraint to Razorpay';
  END IF;
  IF EXISTS (SELECT 1 FROM payment_reconciliation_jobs WHERE provider = 'payu') THEN
    RAISE EXCEPTION 'PayU reconciliation jobs exist; resolve them before switching to Razorpay';
  END IF;
END $$;

ALTER TABLE payments ALTER COLUMN provider SET DEFAULT 'razorpay';
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_provider_check;
ALTER TABLE payments ADD CONSTRAINT payments_provider_check CHECK (provider IN ('razorpay', 'cod'));

ALTER TABLE payment_reconciliation_jobs ALTER COLUMN provider SET DEFAULT 'razorpay';
ALTER TABLE payment_reconciliation_jobs DROP CONSTRAINT IF EXISTS payment_reconciliation_jobs_provider_check;
ALTER TABLE payment_reconciliation_jobs ADD CONSTRAINT payment_reconciliation_jobs_provider_check CHECK (provider = 'razorpay');

ALTER TABLE refunds ADD COLUMN IF NOT EXISTS provider_refund_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS refunds_provider_refund_id_uq
  ON refunds(provider_refund_id) WHERE provider_refund_id IS NOT NULL;

COMMIT;
