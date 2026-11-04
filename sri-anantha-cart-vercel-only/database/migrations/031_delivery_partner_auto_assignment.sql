BEGIN;

-- Dedicated delivery-person accounts are not administrators or operators.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('customer','admin','operator','delivery_partner'));

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_password_staff_only;
ALTER TABLE users ADD CONSTRAINT users_password_staff_only
  CHECK (password_hash IS NULL OR role IN ('admin','operator','delivery_partner'));

-- Delivery OTP remains valid until it is successfully consumed by the assigned delivery person.
ALTER TABLE order_delivery_verifications ALTER COLUMN expires_at DROP NOT NULL;
UPDATE order_delivery_verifications SET expires_at = NULL
 WHERE verified_at IS NULL AND expires_at IS NOT NULL;

-- Preserve the fulfilment choice for orders that already have a Shiprocket shipment.
UPDATE orders o SET fulfilment_provider = 'shiprocket'
 WHERE EXISTS (SELECT 1 FROM delivery_shipments s WHERE s.order_id = o.id AND s.provider = 'shiprocket');

CREATE TABLE IF NOT EXISTS delivery_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  delivery_person_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'assigned'
    CHECK (status IN ('assigned','completed','reassignment_required','cancelled')),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  assigned_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS delivery_assignments_one_active_order_uq
  ON delivery_assignments(order_id) WHERE status = 'assigned';
CREATE INDEX IF NOT EXISTS delivery_assignments_person_status_idx
  ON delivery_assignments(delivery_person_id, status, assigned_at DESC);
CREATE INDEX IF NOT EXISTS delivery_assignments_order_history_idx
  ON delivery_assignments(order_id, created_at DESC);

-- COD is intentionally collected separately from delivery OTP acceptance.
CREATE TABLE IF NOT EXISTS order_cod_collections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
  delivery_assignment_id UUID NOT NULL REFERENCES delivery_assignments(id) ON DELETE RESTRICT,
  collected_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  method TEXT NOT NULL DEFAULT 'cash' CHECK (method IN ('cash')),
  notes TEXT,
  collected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_cod_collections_collector_idx
  ON order_cod_collections(collected_by, collected_at DESC);

SELECT enable_backend_rls('delivery_assignments');
SELECT enable_backend_rls('order_cod_collections');

COMMIT;
