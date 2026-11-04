-- Development-only sample data. Do not run in production without explicit approval.
BEGIN;
INSERT INTO categories (name, slug, description, sort_order) VALUES
  ('Puja Essentials', 'puja-essentials', 'Everyday essentials for puja and worship.', 1),
  ('Incense & Camphor', 'incense-camphor', 'Incense sticks, dhoop and camphor.', 2),
  ('Kumkum & Turmeric', 'kumkum-turmeric', 'Traditional kumkum and turmeric products.', 3)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO products (category_id, sku, slug, name, description, price_paise, is_active)
SELECT c.id, x.sku, x.slug, x.name, x.description, x.price_paise, TRUE
FROM (VALUES
  ('SAMPLE-DIYA-001','sample-clay-diya','Sample Clay Diya','DEVELOPMENT SAMPLE — Clay Diya. Placeholder only; replace with approved catalog data.', 2500, 'puja-essentials'),
  ('SAMPLE-INCENSE-001','sample-incense-sticks','Sample Incense Sticks','DEVELOPMENT SAMPLE — Incense Sticks. Placeholder only; replace with approved catalog data.', 3500, 'incense-camphor'),
  ('SAMPLE-KUMKUM-001','sample-kumkum','Sample Kumkum','DEVELOPMENT SAMPLE — Kumkum. Placeholder only; replace with approved catalog data.', 2000, 'kumkum-turmeric')
) AS x(sku, slug, name, description, price_paise, category_slug)
JOIN categories c ON c.slug = x.category_slug
ON CONFLICT (sku) DO NOTHING;

INSERT INTO inventory (product_id, quantity)
SELECT id, 0 FROM products WHERE sku LIKE 'SAMPLE-%'
ON CONFLICT (product_id) DO NOTHING;
COMMIT;
