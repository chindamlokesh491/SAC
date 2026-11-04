BEGIN;

-- Fencing token prevents a stale worker from applying results after its lease expires
-- and another worker claims the same reconciliation job.
ALTER TABLE payment_reconciliation_jobs
  ADD COLUMN IF NOT EXISTS lease_token UUID;

-- Existing processing jobs have no token and will be recovered by the worker's stale-lease pass.
UPDATE payment_reconciliation_jobs
   SET status = 'retry', locked_at = NULL, lease_token = NULL,
       next_attempt_at = now(), last_error_code = 'LEASE_TOKEN_MIGRATION', updated_at = now()
 WHERE status = 'processing';

COMMIT;
