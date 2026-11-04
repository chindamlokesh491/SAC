BEGIN;

-- Phase 1 completion: Google sign-in identity, address labels, wishlist, product
-- merchandising, variant stock, tax-inclusive order lines, COD payments, delivery
-- scheduling, order timeline and store settings.

-- Accounts -------------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;
CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_unique ON users(google_sub) WHERE google_sub IS NOT NULL;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_format;
ALTER TABLE users ADD CONSTRAINT users_email_format
  CHECK (email IS NULL OR (length(email) <= 254 AND email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'));
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_display_name_length;
ALTER TABLE users ADD CONSTRAINT users_display_name_length CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 100);
-- A user must be reachable by at least one verified identity.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_identity_present;
ALTER TABLE users ADD CONSTRAINT users_identity_present CHECK (phone_e164 IS NOT NULL OR google_sub IS NOT NULL);

-- Hourly OTP cap per phone needs an index on recent challenges (already indexed by phone, created_at).

-- Addresses ------------------------------------------------------------------
ALTER TABLE addresses ADD COLUMN IF NOT EXISTS label TEXT;
ALTER TABLE addresses ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE addresses ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE addresses DROP CONSTRAINT IF EXISTS addresses_label_length;
ALTER TABLE addresses ADD CONSTRAINT addresses_label_length CHECK (label IS NULL OR length(label) BETWEEN 1 AND 40);
CREATE UNIQUE INDEX IF NOT EXISTS addresses_one_default_per_user ON addresses(user_id) WHERE is_default;

-- Catalogue ------------------------------------------------------------------
ALTER TABLE products ADD COLUMN IF NOT EXISTS highlights TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE products ADD COLUMN IF NOT EXISTS short_description TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_featured BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_highlights_limit;
ALTER TABLE products ADD CONSTRAINT products_highlights_limit CHECK (cardinality(highlights) <= 6);
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_short_description_length;
ALTER TABLE products ADD CONSTRAINT products_short_description_length CHECK (short_description IS NULL OR length(short_description) <= 120);
CREATE INDEX IF NOT EXISTS products_featured_idx ON products(is_featured) WHERE is_active AND archived_at IS NULL;
CREATE INDEX IF NOT EXISTS products_subcategory_idx ON products(subcategory_id);
CREATE INDEX IF NOT EXISTS products_created_idx ON products(created_at DESC);

-- Uploaded media is served by the API under /media/. Allow those relative URLs.
ALTER TABLE product_images DROP CONSTRAINT IF EXISTS product_images_image_url_check;
ALTER TABLE product_images ADD CONSTRAINT product_images_image_url_check CHECK (image_url ~ '^(https://|/media/)');
ALTER TABLE product_images DROP CONSTRAINT IF EXISTS product_images_product_id_sort_order_key;
CREATE TABLE IF NOT EXISTS media_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name TEXT NOT NULL UNIQUE CHECK (file_name ~ '^[0-9a-f-]{36}(-[a-z0-9]+)?\.webp$'),
  content_type TEXT NOT NULL CHECK (content_type = 'image/webp'),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Variants carry their own price and stock.
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS quantity INTEGER NOT NULL DEFAULT 0;
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE product_variants DROP CONSTRAINT IF EXISTS product_variants_quantity_nonnegative;
ALTER TABLE product_variants ADD CONSTRAINT product_variants_quantity_nonnegative CHECK (quantity >= 0);

-- Cart lines may reference a variant; a product/variant pair appears once per cart.
ALTER TABLE cart_items ADD COLUMN IF NOT EXISTS id UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE cart_items ADD COLUMN IF NOT EXISTS variant_id UUID REFERENCES product_variants(id) ON DELETE CASCADE;
ALTER TABLE cart_items DROP CONSTRAINT IF EXISTS cart_items_pkey;
ALTER TABLE cart_items ADD PRIMARY KEY (id);
CREATE UNIQUE INDEX IF NOT EXISTS cart_items_line_unique
  ON cart_items(cart_id, product_id, COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE IF NOT EXISTS wishlist_items (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, product_id)
);

-- Inventory movements and reservations understand variants.
ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS variant_id UUID REFERENCES product_variants(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS inventory_movements_product_created_idx ON inventory_movements(product_id, created_at DESC);
ALTER TABLE order_inventory_reservations ADD COLUMN IF NOT EXISTS variant_id UUID REFERENCES product_variants(id);
ALTER TABLE order_inventory_reservations DROP CONSTRAINT IF EXISTS order_inventory_reservations_order_id_product_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS order_inventory_reservations_line_unique
  ON order_inventory_reservations(order_id, product_id, COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- Orders -----------------------------------------------------------------------
-- Retail prices are GST-inclusive (MRP rules). tax_paise records the GST already
-- contained in the item subtotal, so it is not added again to the total.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_total_paise_check;
ALTER TABLE orders ADD CONSTRAINT orders_total_paise_check
  CHECK (total_paise = subtotal_paise + delivery_fee_paise - discount_paise AND tax_paise <= subtotal_paise) NOT VALID;
ALTER TABLE orders VALIDATE CONSTRAINT orders_total_paise_check;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_mode TEXT CHECK (delivery_mode IN ('express', 'scheduled'));
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_slot_id UUID REFERENCES delivery_time_slots(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_zone_id UUID REFERENCES delivery_zones(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS estimated_delivery_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS mrp_total_paise INTEGER CHECK (mrp_total_paise IS NULL OR mrp_total_paise >= 0);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS orders_created_idx ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS orders_payment_method_idx ON orders(payment_method, created_at DESC);

ALTER TABLE order_items ADD COLUMN IF NOT EXISTS variant_id UUID REFERENCES product_variants(id) ON DELETE SET NULL;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS variant_label_snapshot TEXT;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS image_url_snapshot TEXT;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS mrp_paise INTEGER CHECK (mrp_paise IS NULL OR mrp_paise >= 0);
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS gst_rate_basis_points INTEGER NOT NULL DEFAULT 0 CHECK (gst_rate_basis_points IN (0, 500, 1200, 1800, 2800));
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS tax_paise INTEGER NOT NULL DEFAULT 0 CHECK (tax_paise >= 0);
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS hsn_code_snapshot TEXT;
ALTER TABLE order_items DROP CONSTRAINT IF EXISTS order_items_tax_within_line;
ALTER TABLE order_items ADD CONSTRAINT order_items_tax_within_line CHECK (tax_paise <= line_total_paise);

-- Every status change is captured by the database itself, whichever code path made it.
CREATE TABLE IF NOT EXISTS order_status_history (
  id BIGSERIAL PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  payment_status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_status_history_order_idx ON order_status_history(order_id, created_at);

CREATE OR REPLACE FUNCTION record_order_status_history() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status OR NEW.payment_status IS DISTINCT FROM OLD.payment_status THEN
    INSERT INTO order_status_history(order_id, status, payment_status) VALUES (NEW.id, NEW.status, NEW.payment_status);
  END IF;
  IF NEW.status = 'delivered' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'delivered') THEN
    NEW.delivered_at := COALESCE(NEW.delivered_at, now());
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- BEFORE trigger so delivered_at can be set; the history insert references NEW.id,
-- which already exists for UPDATE. For INSERT we use a separate AFTER trigger.
DROP TRIGGER IF EXISTS orders_status_history_update ON orders;
CREATE TRIGGER orders_status_history_update BEFORE UPDATE OF status, payment_status ON orders
  FOR EACH ROW EXECUTE FUNCTION record_order_status_history();

CREATE OR REPLACE FUNCTION record_order_status_history_insert() RETURNS trigger AS $$
BEGIN
  INSERT INTO order_status_history(order_id, status, payment_status) VALUES (NEW.id, NEW.status, NEW.payment_status);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS orders_status_history_insert ON orders;
CREATE TRIGGER orders_status_history_insert AFTER INSERT ON orders
  FOR EACH ROW EXECUTE FUNCTION record_order_status_history_insert();

INSERT INTO order_status_history(order_id, status, payment_status, created_at)
SELECT o.id, o.status, o.payment_status, o.updated_at FROM orders o
 WHERE NOT EXISTS (SELECT 1 FROM order_status_history h WHERE h.order_id = o.id);

-- Payments -------------------------------------------------------------------
-- Cash on delivery is recorded as its own provider so it can never be mistaken
-- for a gateway transaction.
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_provider_check;
ALTER TABLE payments ADD CONSTRAINT payments_provider_check CHECK (provider IN ('payu', 'cod'));
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_cod_has_no_gateway_reference;
ALTER TABLE payments ADD CONSTRAINT payments_cod_has_no_gateway_reference
  CHECK (provider <> 'cod' OR provider_transaction_id IS NULL);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS collected_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS method TEXT NOT NULL DEFAULT 'gateway' CHECK (method IN ('gateway', 'manual'));

-- Delivery slots: order-level slot data is validated in the API; keep slot names tidy.
ALTER TABLE delivery_time_slots ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

-- Newsletter -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS newsletter_subscribers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL CHECK (length(email) <= 254 AND email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  unsubscribed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS newsletter_subscribers_email_unique ON newsletter_subscribers(lower(email));

-- Store settings defaults (only inserted when absent; edited from Admin > Settings).
INSERT INTO store_settings(key, value) VALUES
  ('store', '{"name":"Sri Anantha Cart","tagline":"Your Pooja Essentials","support_phone":"","support_email":"","whatsapp":"","gstin":"","legal_name":"","address":"Tirupati, Andhra Pradesh","state_code":"37","instagram_url":"","facebook_url":"","youtube_url":""}'),
  ('payments', '{"upi":true,"card":true,"net_banking":true,"wallet":false,"cod":true,"cod_limit_paise":200000}'),
  ('delivery', '{"free_delivery_threshold_paise":49900,"express_enabled":true,"scheduled_days_ahead":2,"scheduled_lead_minutes":60}'),
  ('tax', '{"show_breakup_on_invoice":true}')
ON CONFLICT (key) DO NOTHING;

COMMIT;
