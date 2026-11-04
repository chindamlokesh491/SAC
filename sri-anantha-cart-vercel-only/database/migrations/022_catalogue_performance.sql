-- Catalogue performance: a maintained product sales summary instead of re-adding every order line
-- for every product on every catalogue request, plus indexes for hot paths and cascading deletes.
--
-- Which orders count as sales (sale_status_counts):
--   placed, accepted, packed, dispatched, delivered, return_requested
-- Not counted: pending_payment (not paid / not confirmed), cancelled, refund_initiated,
-- refund_completed, refunded (the sale was reversed).
--
-- How it stays correct:
--   * product_sales_daily holds units and revenue per product per IST day. Triggers apply exact +/- deltas
--     inside the same transaction whenever an order enters or leaves a counted status, or a line is added
--     to a counted order. Deltas are derived from the transition itself, so replays of the same status do
--     nothing (idempotent) and concurrent orders serialise on the summary row.
--   * product_sales_summary holds lifetime and rolling 90-day totals per product. The triggers keep both
--     current; refresh_product_sales_summary() recomputes the 90-day window from the daily table (sales
--     age out of the window even when nothing happens), and rebuild_product_sales() recomputes everything
--     from order_items for reconciliation. The worker runs both on a schedule.
BEGIN;

CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items (order_id);
CREATE INDEX IF NOT EXISTS order_items_product_idx ON order_items (product_id) WHERE product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS order_items_variant_idx ON order_items (variant_id) WHERE variant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS cart_items_product_idx ON cart_items (product_id);
CREATE INDEX IF NOT EXISTS wishlist_items_product_idx ON wishlist_items (product_id);
CREATE INDEX IF NOT EXISTS order_inventory_reservations_product_idx ON order_inventory_reservations (product_id);
CREATE INDEX IF NOT EXISTS refunds_payment_idx ON refunds (payment_id);
CREATE INDEX IF NOT EXISTS customer_account_events_customer_idx ON customer_account_events (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS inventory_movements_variant_idx ON inventory_movements (variant_id) WHERE variant_id IS NOT NULL;

CREATE OR REPLACE FUNCTION sale_status_counts(status text) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT status IN ('placed','accepted','packed','dispatched','delivered','return_requested') $$;

CREATE TABLE IF NOT EXISTS product_sales_daily (
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sales_date date NOT NULL,
  units integer NOT NULL DEFAULT 0,
  revenue_paise bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, sales_date)
);
CREATE INDEX IF NOT EXISTS product_sales_daily_date_idx ON product_sales_daily (sales_date);

CREATE TABLE IF NOT EXISTS product_sales_summary (
  product_id uuid PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  units_total bigint NOT NULL DEFAULT 0,
  units_90d integer NOT NULL DEFAULT 0,
  revenue_total_paise bigint NOT NULL DEFAULT 0,
  last_sold_on date,
  refreshed_at timestamptz NOT NULL DEFAULT now()
);

-- Applies one order's lines to the sales tables with the given sign (+1 entering a counted status, -1 leaving it).
CREATE OR REPLACE FUNCTION apply_order_sales(p_order_id uuid, p_sign integer) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  sale_day date;
BEGIN
  SELECT (created_at AT TIME ZONE 'Asia/Kolkata')::date INTO sale_day FROM orders WHERE id = p_order_id;
  IF sale_day IS NULL THEN RETURN; END IF;

  INSERT INTO product_sales_daily AS d (product_id, sales_date, units, revenue_paise)
  SELECT oi.product_id, sale_day, p_sign * SUM(oi.quantity), p_sign * SUM(oi.line_total_paise)
    FROM order_items oi
   WHERE oi.order_id = p_order_id AND oi.product_id IS NOT NULL
   GROUP BY oi.product_id
  ON CONFLICT (product_id, sales_date) DO UPDATE
    SET units = d.units + EXCLUDED.units, revenue_paise = d.revenue_paise + EXCLUDED.revenue_paise;

  INSERT INTO product_sales_summary AS s (product_id, units_total, units_90d, revenue_total_paise, last_sold_on)
  SELECT oi.product_id, p_sign * SUM(oi.quantity),
         CASE WHEN sale_day > (now() AT TIME ZONE 'Asia/Kolkata')::date - 90 THEN p_sign * SUM(oi.quantity) ELSE 0 END,
         p_sign * SUM(oi.line_total_paise),
         CASE WHEN p_sign > 0 THEN sale_day END
    FROM order_items oi
   WHERE oi.order_id = p_order_id AND oi.product_id IS NOT NULL
   GROUP BY oi.product_id
  ON CONFLICT (product_id) DO UPDATE
    SET units_total = s.units_total + EXCLUDED.units_total,
        units_90d = s.units_90d + EXCLUDED.units_90d,
        revenue_total_paise = s.revenue_total_paise + EXCLUDED.revenue_total_paise,
        last_sold_on = GREATEST(s.last_sold_on, EXCLUDED.last_sold_on);
END;
$$;

CREATE OR REPLACE FUNCTION track_order_sales() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF sale_status_counts(NEW.status) THEN PERFORM apply_order_sales(NEW.id, 1); END IF;
  ELSIF sale_status_counts(NEW.status) IS DISTINCT FROM sale_status_counts(OLD.status) THEN
    PERFORM apply_order_sales(NEW.id, CASE WHEN sale_status_counts(NEW.status) THEN 1 ELSE -1 END);
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS orders_track_sales ON orders;
CREATE TRIGGER orders_track_sales AFTER INSERT OR UPDATE OF status ON orders
  FOR EACH ROW EXECUTE FUNCTION track_order_sales();

-- Lines are normally inserted after their order row, in the same transaction.
CREATE OR REPLACE FUNCTION track_order_item_sales() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  sale_day date;
BEGIN
  IF NEW.product_id IS NULL THEN RETURN NULL; END IF;
  SELECT (created_at AT TIME ZONE 'Asia/Kolkata')::date INTO sale_day FROM orders WHERE id = NEW.order_id AND sale_status_counts(status);
  IF sale_day IS NULL THEN RETURN NULL; END IF;
  INSERT INTO product_sales_daily AS d (product_id, sales_date, units, revenue_paise)
  VALUES (NEW.product_id, sale_day, NEW.quantity, NEW.line_total_paise)
  ON CONFLICT (product_id, sales_date) DO UPDATE SET units = d.units + EXCLUDED.units, revenue_paise = d.revenue_paise + EXCLUDED.revenue_paise;
  INSERT INTO product_sales_summary AS s (product_id, units_total, units_90d, revenue_total_paise, last_sold_on)
  VALUES (NEW.product_id, NEW.quantity, CASE WHEN sale_day > (now() AT TIME ZONE 'Asia/Kolkata')::date - 90 THEN NEW.quantity ELSE 0 END, NEW.line_total_paise, sale_day)
  ON CONFLICT (product_id) DO UPDATE
    SET units_total = s.units_total + EXCLUDED.units_total, units_90d = s.units_90d + EXCLUDED.units_90d,
        revenue_total_paise = s.revenue_total_paise + EXCLUDED.revenue_total_paise, last_sold_on = GREATEST(s.last_sold_on, EXCLUDED.last_sold_on);
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS order_items_track_sales ON order_items;
CREATE TRIGGER order_items_track_sales AFTER INSERT ON order_items
  FOR EACH ROW EXECUTE FUNCTION track_order_item_sales();

-- Rolling window: sales older than 90 IST days drop out. Cheap (reads the daily table only).
CREATE OR REPLACE FUNCTION refresh_product_sales_summary() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  changed integer;
BEGIN
  WITH recent AS (
    SELECT product_id, SUM(units)::integer AS units
      FROM product_sales_daily
     WHERE sales_date > (now() AT TIME ZONE 'Asia/Kolkata')::date - 90
     GROUP BY product_id
  )
  UPDATE product_sales_summary s
     SET units_90d = x.units, refreshed_at = now()
    FROM (SELECT s2.product_id, COALESCE(r.units, 0) AS units
            FROM product_sales_summary s2 LEFT JOIN recent r ON r.product_id = s2.product_id) x
   WHERE x.product_id = s.product_id AND s.units_90d <> x.units;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END;
$$;

-- Full reconciliation from order history. Locks the summary tables briefly; safe to run at any time.
CREATE OR REPLACE FUNCTION rebuild_product_sales() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  LOCK TABLE product_sales_daily, product_sales_summary IN EXCLUSIVE MODE;
  DELETE FROM product_sales_daily;
  INSERT INTO product_sales_daily (product_id, sales_date, units, revenue_paise)
  SELECT oi.product_id, (o.created_at AT TIME ZONE 'Asia/Kolkata')::date, SUM(oi.quantity), SUM(oi.line_total_paise)
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
   WHERE oi.product_id IS NOT NULL AND sale_status_counts(o.status)
   GROUP BY 1, 2;
  DELETE FROM product_sales_summary;
  INSERT INTO product_sales_summary (product_id, units_total, units_90d, revenue_total_paise, last_sold_on)
  SELECT product_id, SUM(units),
         COALESCE(SUM(units) FILTER (WHERE sales_date > (now() AT TIME ZONE 'Asia/Kolkata')::date - 90), 0),
         SUM(revenue_paise), MAX(sales_date)
    FROM product_sales_daily GROUP BY product_id;
END;
$$;

SELECT rebuild_product_sales();
COMMIT;
