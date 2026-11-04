BEGIN;

-- Admin retries must not create duplicate refund instructions after a timeout.
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE refunds ADD CONSTRAINT refunds_idempotency_key_length
  CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 8 AND 128) NOT VALID;
ALTER TABLE refunds VALIDATE CONSTRAINT refunds_idempotency_key_length;
CREATE UNIQUE INDEX IF NOT EXISTS refunds_order_idempotency_key_uq
  ON refunds(order_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMIT;
