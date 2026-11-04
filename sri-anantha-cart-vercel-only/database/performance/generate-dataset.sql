-- Synthetic scale data for local benchmarks ONLY. Never run against a real database.
-- Starts from the demo catalogue (pnpm --filter @sac/api seed:demo) and adds:
--   20 copies of every product (about 460 products), 100,000 orders over 180 days, 300,000 order lines.
-- Run: psql "$BENCH_DATABASE_URL" -v ON_ERROR_STOP=1 -f database/performance/generate-dataset.sql
DO $$ BEGIN
  IF current_database() !~ 'bench' THEN RAISE EXCEPTION 'Refusing to load synthetic data into %, which is not a *bench* database', current_database(); END IF;
END $$;
SET session_replication_role = replica; -- skip FK checks and triggers; synthetic users do not exist
INSERT INTO products (id, sku, slug, name, short_description, description, price_paise, mrp_paise, category_id, subcategory_id, is_active, is_featured, minimum_stock_level, gst_rate_basis_points, hsn_code, image_url)
SELECT gen_random_uuid(), p.sku || '-X' || g, p.slug || '-x' || g, p.name || ' ' || g, p.short_description, p.description, p.price_paise, p.mrp_paise,
       p.category_id, p.subcategory_id, true, false, p.minimum_stock_level, p.gst_rate_basis_points, p.hsn_code, p.image_url
  FROM products p CROSS JOIN generate_series(1, 20) g WHERE p.sku NOT LIKE '%-X%';
INSERT INTO inventory (product_id, quantity) SELECT id, 50 FROM products ON CONFLICT DO NOTHING;
INSERT INTO orders (user_id, status, payment_status, subtotal_paise, delivery_fee_paise, total_paise, delivery_address_snapshot, created_at, payment_method)
SELECT gen_random_uuid(), (ARRAY['delivered','delivered','delivered','placed','cancelled'])[1 + (g % 5)], 'paid', 10000, 0, 10000, '{}'::jsonb,
       now() - (g % 180) * interval '1 day', 'cod'
  FROM generate_series(1, 100000) g;
CREATE TEMP TABLE bench_products AS SELECT row_number() OVER () - 1 AS rn, id, name, sku FROM products;
INSERT INTO order_items (order_id, product_id, product_name_snapshot, sku_snapshot, unit_price_paise, quantity, line_total_paise)
SELECT o.id, bp.id, bp.name, bp.sku, 5000, 1 + (o.order_number % 3)::int, 5000 * (1 + (o.order_number % 3)::int)
  FROM orders o CROSS JOIN generate_series(0, 2) k
  JOIN bench_products bp ON bp.rn = ((o.order_number * 7 + k * 131) % (SELECT count(*) FROM bench_products));
SET session_replication_role = origin;
-- Synthetic rows bypassed the sales triggers; rebuild the summary if migration 022 is applied.
DO $$ BEGIN IF to_regproc('rebuild_product_sales') IS NOT NULL THEN PERFORM rebuild_product_sales(); END IF; END $$;
ANALYZE;
