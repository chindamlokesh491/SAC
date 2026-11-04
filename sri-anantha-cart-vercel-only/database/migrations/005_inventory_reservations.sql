BEGIN;

-- Inventory quantity represents sellable units. Reserving stock decrements it once;
-- releasing a reservation restores it once. Consumed reservations are never restored.
CREATE TABLE IF NOT EXISTS order_inventory_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'consumed', 'released')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (order_id, product_id)
);
CREATE INDEX IF NOT EXISTS order_inventory_reservations_expiry_idx
  ON order_inventory_reservations(expires_at) WHERE status = 'reserved';
CREATE INDEX IF NOT EXISTS order_inventory_reservations_order_idx
  ON order_inventory_reservations(order_id, status);

COMMIT;
