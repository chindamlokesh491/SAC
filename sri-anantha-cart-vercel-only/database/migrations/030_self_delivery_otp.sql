BEGIN;

-- Self-delivery is the default local fulfilment method. Shiprocket remains an
-- explicitly selected external carrier option.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS fulfilment_provider TEXT NOT NULL DEFAULT 'self_delivery'
    CHECK (fulfilment_provider IN ('self_delivery','shiprocket'));

-- OTP material is encrypted at rest and never exposed to staff order-list APIs.
-- Hash is used for constant-time verification; ciphertext allows the customer app
-- to display the same OTP after refresh without sending a separate SMS.
CREATE TABLE IF NOT EXISTS order_delivery_verifications (
  order_id UUID PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  otp_hash TEXT NOT NULL,
  otp_ciphertext TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ,
  verified_by UUID REFERENCES users(id) ON DELETE SET NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 10),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS order_delivery_verifications_expiry_idx
  ON order_delivery_verifications(expires_at) WHERE verified_at IS NULL;

SELECT enable_backend_rls('order_delivery_verifications');

COMMIT;
