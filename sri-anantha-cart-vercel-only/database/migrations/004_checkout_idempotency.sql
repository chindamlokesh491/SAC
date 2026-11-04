BEGIN;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS orders_user_idempotency_key_unique
  ON orders(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS payments_pending_expiry_idx ON payments(expires_at) WHERE status IN ('created','pending');

COMMIT;
