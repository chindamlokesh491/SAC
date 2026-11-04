BEGIN;

-- A return is its own workflow, independent from the order's fulfilment/payment status.
-- This prevents approval from being mistaken for physical receipt or refund completion.
CREATE TABLE order_returns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
  customer_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  status TEXT NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested','accepted','rejected','pickup_scheduled','picked_up','in_transit','received','refund_pending','refunded','closed')),
  decision_reason TEXT,
  pickup_method TEXT CHECK (pickup_method IS NULL OR pickup_method IN ('self_dropoff','courier')),
  return_carrier TEXT CHECK (return_carrier IS NULL OR length(return_carrier) BETWEEN 2 AND 80),
  pickup_reference TEXT CHECK (pickup_reference IS NULL OR length(pickup_reference) BETWEEN 2 AND 160),
  parcel_description TEXT CHECK (parcel_description IS NULL OR length(parcel_description) BETWEEN 3 AND 500),
  decided_by UUID REFERENCES users(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX order_returns_status_created_idx ON order_returns(status, created_at DESC);
CREATE INDEX order_returns_customer_created_idx ON order_returns(customer_id, created_at DESC);

CREATE TABLE return_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id UUID NOT NULL REFERENCES order_returns(id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL UNIQUE CHECK (storage_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$'),
  content_type TEXT NOT NULL DEFAULT 'image/webp' CHECK (content_type = 'image/webp'),
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 5242880),
  uploaded_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX return_evidence_return_created_idx ON return_evidence(return_id, created_at);

CREATE TABLE return_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id UUID NOT NULL REFERENCES order_returns(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL CHECK (to_status IN ('requested','accepted','rejected','pickup_scheduled','picked_up','in_transit','received','refund_pending','refunded','closed')),
  note TEXT,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX return_events_return_created_idx ON return_events(return_id, created_at);

-- Preserve in-flight legacy return requests/approvals when this migration is first applied.
-- Legacy approval moved the order directly to refund_initiated, so it is imported as accepted
-- unless an actual refund record/payment state proves that a refund is already in progress/completed.
WITH migrated AS (
  INSERT INTO order_returns (order_id, customer_id, reason, status, decision_reason, decided_at, created_at, updated_at)
  SELECT o.id, o.user_id,
         CASE WHEN length(trim(COALESCE(o.return_reason, ''))) >= 3 THEN left(trim(o.return_reason), 500)
              ELSE 'Return requested before return workflow migration' END,
         CASE
           WHEN o.payment_status = 'refunded' OR o.status IN ('refunded','refund_completed') THEN 'refunded'
           WHEN o.payment_status = 'refund_pending'
             OR EXISTS (SELECT 1 FROM refunds f WHERE f.order_id = o.id AND f.status IN ('initiated','processing')) THEN 'refund_pending'
           WHEN o.status = 'return_requested' THEN 'requested'
           ELSE 'accepted'
         END,
         CASE WHEN o.status IN ('refund_initiated','refund_completed','refunded')
              THEN 'Migrated legacy return; verify physical receipt before any further refund'
              ELSE NULL END,
         CASE WHEN o.status IN ('refund_initiated','refund_completed','refunded') THEN o.updated_at ELSE NULL END,
         COALESCE(o.return_requested_at, o.updated_at), o.updated_at
    FROM orders o
   WHERE o.status = 'return_requested' OR o.return_reason IS NOT NULL
  ON CONFLICT (order_id) DO NOTHING
  RETURNING id, status, created_at
)
INSERT INTO return_events (return_id, from_status, to_status, note, actor_user_id, created_at)
SELECT id, NULL, status, 'Migrated existing order return state', NULL::uuid, created_at
  FROM migrated;

-- Apply the same least-privilege backend-only RLS policy as the rest of the application schema.
SELECT enable_backend_rls('order_returns'::regclass);
SELECT enable_backend_rls('return_evidence'::regclass);
SELECT enable_backend_rls('return_events'::regclass);

COMMIT;
