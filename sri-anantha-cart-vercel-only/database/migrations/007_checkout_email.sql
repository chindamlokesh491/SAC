BEGIN;

-- Bind the contact email used in the PayU payment request to the original order.
-- This prevents an idempotent retry from silently changing payment-form identity.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS checkout_email TEXT;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_checkout_email_format;
ALTER TABLE orders ADD CONSTRAINT orders_checkout_email_format
  CHECK (checkout_email IS NULL OR (length(checkout_email) <= 254 AND checkout_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'));

COMMIT;
