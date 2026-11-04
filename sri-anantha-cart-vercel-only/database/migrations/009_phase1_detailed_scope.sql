BEGIN;

-- Product merchandising, GST and catalogue hierarchy from the Phase 1 detailed scope.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMPTZ;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS parent_category_id UUID REFERENCES categories(id) ON DELETE SET NULL;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS categories_parent_sort_idx ON categories(parent_category_id, sort_order, name);

ALTER TABLE products ADD COLUMN IF NOT EXISTS mrp_paise INTEGER;
ALTER TABLE products ADD COLUMN IF NOT EXISTS gst_rate_basis_points INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS hsn_code TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS minimum_stock_level INTEGER NOT NULL DEFAULT 5;
ALTER TABLE products ADD COLUMN IF NOT EXISTS weight_grams INTEGER;
ALTER TABLE products ADD COLUMN IF NOT EXISTS subcategory_id UUID REFERENCES categories(id) ON DELETE SET NULL;
ALTER TABLE products ADD CONSTRAINT products_mrp_nonnegative CHECK (mrp_paise IS NULL OR mrp_paise >= price_paise) NOT VALID;
ALTER TABLE products ADD CONSTRAINT products_gst_rate_valid CHECK (gst_rate_basis_points IN (0, 500, 1200, 1800, 2800)) NOT VALID;
ALTER TABLE products ADD CONSTRAINT products_min_stock_nonnegative CHECK (minimum_stock_level >= 0) NOT VALID;
ALTER TABLE products ADD CONSTRAINT products_weight_positive CHECK (weight_grams IS NULL OR weight_grams > 0) NOT VALID;
UPDATE products SET mrp_paise = price_paise WHERE mrp_paise IS NULL;
ALTER TABLE products VALIDATE CONSTRAINT products_mrp_nonnegative;
ALTER TABLE products VALIDATE CONSTRAINT products_gst_rate_valid;
ALTER TABLE products VALIDATE CONSTRAINT products_min_stock_nonnegative;
ALTER TABLE products VALIDATE CONSTRAINT products_weight_positive;

CREATE TABLE IF NOT EXISTS product_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL CHECK (image_url ~ '^https://'),
  alt_text TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(product_id, sort_order)
);
CREATE INDEX IF NOT EXISTS product_images_product_sort_idx ON product_images(product_id, sort_order);

CREATE TABLE IF NOT EXISTS product_variants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  price_paise INTEGER NOT NULL CHECK (price_paise >= 0),
  mrp_paise INTEGER NOT NULL CHECK (mrp_paise >= price_paise),
  weight_grams INTEGER CHECK (weight_grams IS NULL OR weight_grams > 0),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS product_variants_product_idx ON product_variants(product_id, is_active);

-- Order financial breakdown and delivery/payment metadata.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tax_paise INTEGER NOT NULL DEFAULT 0 CHECK (tax_paise >= 0);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_paise INTEGER NOT NULL DEFAULT 0 CHECK (discount_paise >= 0);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method TEXT CHECK (payment_method IN ('upi','card','net_banking','wallet','cod'));
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_slot_start TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_slot_end TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS return_reason TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS return_requested_at TIMESTAMPTZ;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (status IN ('pending_payment','placed','accepted','packed','dispatched','delivered','cancelled','return_requested','refund_initiated','refund_completed','refunded')) NOT VALID;
ALTER TABLE orders VALIDATE CONSTRAINT orders_status_check;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_total_paise_check;
ALTER TABLE orders ADD CONSTRAINT orders_total_paise_check CHECK (total_paise = subtotal_paise + delivery_fee_paise + tax_paise - discount_paise) NOT VALID;
ALTER TABLE orders VALIDATE CONSTRAINT orders_total_paise_check;

ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_amount_paise INTEGER CHECK (refund_amount_paise IS NULL OR refund_amount_paise >= 0);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_transaction_id TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_status TEXT CHECK (refund_status IN ('initiated','processing','completed','failed'));
ALTER TABLE payments ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS payment_method TEXT CHECK (payment_method IN ('upi','card','net_banking','wallet','cod'));

CREATE TABLE IF NOT EXISTS delivery_time_slots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  zone_id UUID REFERENCES delivery_zones(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  starts_at TIME NOT NULL,
  ends_at TIME NOT NULL,
  is_scheduled BOOLEAN NOT NULL DEFAULT TRUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS delivery_slots_zone_idx ON delivery_time_slots(zone_id, is_active);

CREATE TABLE IF NOT EXISTS store_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id),
  payment_id UUID REFERENCES payments(id),
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'initiated' CHECK (status IN ('initiated','processing','completed','failed')),
  provider_transaction_id TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS refunds_order_created_idx ON refunds(order_id, created_at DESC);

CREATE TABLE IF NOT EXISTS customer_account_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (action IN ('blocked','unblocked')),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
