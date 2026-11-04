BEGIN;

-- Durable retry queue for PayU transactions whose callback cannot yet be reconciled.
CREATE TABLE IF NOT EXISTS payment_reconciliation_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'payu' CHECK (provider = 'payu'),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','retry','resolved','needs_review')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  last_error_code TEXT,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (payment_id)
);
CREATE INDEX IF NOT EXISTS payment_reconciliation_due_idx
  ON payment_reconciliation_jobs(next_attempt_at, created_at)
  WHERE status IN ('queued','retry');

COMMIT;
