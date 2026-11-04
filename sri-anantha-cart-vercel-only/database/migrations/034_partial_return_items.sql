BEGIN;

CREATE TABLE order_return_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id UUID NOT NULL REFERENCES order_returns(id) ON DELETE CASCADE,
  order_item_id UUID NOT NULL REFERENCES order_items(id) ON DELETE RESTRICT,
  product_name_snapshot TEXT NOT NULL,
  variant_label_snapshot TEXT,
  sku_snapshot TEXT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_paise INTEGER NOT NULL CHECK (unit_price_paise >= 0),
  refund_amount_paise INTEGER NOT NULL CHECK (refund_amount_paise >= 0),
  tax_amount_paise INTEGER NOT NULL DEFAULT 0 CHECK (tax_amount_paise >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (return_id, order_item_id)
);

CREATE INDEX order_return_items_return_idx ON order_return_items(return_id);

SELECT enable_backend_rls('order_return_items'::regclass);

COMMIT;
