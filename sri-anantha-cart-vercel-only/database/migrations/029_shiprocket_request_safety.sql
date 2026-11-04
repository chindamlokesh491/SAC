BEGIN;

-- Safe, operator-visible state around external create-order / AWB calls. A network
-- timeout may occur after Shiprocket accepted a request, so ambiguous calls must
-- never be retried automatically.
ALTER TABLE delivery_shipments
  ADD COLUMN IF NOT EXISTS request_state TEXT NOT NULL DEFAULT 'created'
    CHECK (request_state IN ('pending','created','ambiguous','failed')),
  ADD COLUMN IF NOT EXISTS awb_state TEXT NOT NULL DEFAULT 'not_requested'
    CHECK (awb_state IN ('not_requested','pending','assigned','ambiguous','failed')),
  ADD COLUMN IF NOT EXISTS provider_error_code TEXT
    CHECK (provider_error_code IS NULL OR length(provider_error_code) <= 120),
  ADD COLUMN IF NOT EXISTS provider_error_at TIMESTAMPTZ;

-- Existing rows with an external ID are known-created. An incomplete older row
-- cannot safely be assumed absent from Shiprocket, so mark it ambiguous.
UPDATE delivery_shipments
   SET request_state = CASE WHEN external_shipment_id IS NOT NULL THEN 'created' ELSE 'ambiguous' END,
       awb_state = CASE WHEN awb_code IS NOT NULL THEN 'assigned' ELSE 'not_requested' END
 WHERE provider = 'shiprocket'
   AND (request_state = 'created' OR (awb_code IS NOT NULL AND awb_state = 'not_requested'));

-- New rows must begin in a pending state, not be mistaken for a completed provider request.
ALTER TABLE delivery_shipments ALTER COLUMN request_state SET DEFAULT 'pending';

-- The application also takes a per-order advisory lock. This database constraint
-- protects idempotency if another code path or process bypasses that lock.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM delivery_shipments
     WHERE provider = 'shiprocket'
     GROUP BY order_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate Shiprocket shipments exist for an order; reconcile them before applying migration 029';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS delivery_shipments_shiprocket_order_uidx
  ON delivery_shipments (order_id) WHERE provider = 'shiprocket';

CREATE INDEX IF NOT EXISTS delivery_shipments_request_state_idx
  ON delivery_shipments (request_state, created_at DESC);

COMMIT;
