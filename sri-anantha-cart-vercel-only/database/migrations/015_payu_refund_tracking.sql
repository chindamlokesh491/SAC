BEGIN;

-- Persist provider identifiers before/after a refund request so retries and
-- reconciliation use the same token instead of potentially issuing a duplicate.
ALTER TABLE refunds
  ADD COLUMN IF NOT EXISTS provider_token TEXT,
  ADD COLUMN IF NOT EXISTS provider_request_id TEXT,
  ADD COLUMN IF NOT EXISTS provider_status TEXT,
  ADD COLUMN IF NOT EXISTS provider_bank_reference TEXT;

ALTER TABLE refunds
  ADD CONSTRAINT refunds_provider_token_length
    CHECK (provider_token IS NULL OR length(provider_token) BETWEEN 8 AND 23) NOT VALID;
ALTER TABLE refunds VALIDATE CONSTRAINT refunds_provider_token_length;

ALTER TABLE refunds
  ADD CONSTRAINT refunds_provider_status_allowed
    CHECK (provider_status IS NULL OR provider_status IN (
      'requesting', 'queued', 'in_progress', 'requested',
      'overdraft_pending', 'success', 'failure', 'unknown'
    )) NOT VALID;
ALTER TABLE refunds VALIDATE CONSTRAINT refunds_provider_status_allowed;

CREATE UNIQUE INDEX IF NOT EXISTS refunds_provider_token_uq
  ON refunds(provider_token) WHERE provider_token IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS refunds_provider_request_id_uq
  ON refunds(provider_request_id) WHERE provider_request_id IS NOT NULL;

COMMIT;
