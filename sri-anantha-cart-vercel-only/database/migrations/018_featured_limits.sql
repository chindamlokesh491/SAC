-- Featured categories, and a hard limit of 8 featured products and 8 featured categories.
-- The limit lives in the database so no client, script or race can exceed it.
BEGIN;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS is_featured BOOLEAN NOT NULL DEFAULT FALSE;

CREATE OR REPLACE FUNCTION enforce_featured_limit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  featured_count integer;
BEGIN
  IF NOT NEW.is_featured OR (TG_OP = 'UPDATE' AND OLD.is_featured) THEN
    RETURN NEW;
  END IF;
  -- Serialise concurrent "feature this" changes per table so two cannot both take the 8th place.
  PERFORM pg_advisory_xact_lock(hashtextextended('featured-limit:' || TG_TABLE_NAME, 0));
  EXECUTE format('SELECT COUNT(*) FROM %I WHERE is_featured AND id <> $1', TG_TABLE_NAME) INTO featured_count USING NEW.id;
  IF featured_count >= 8 THEN
    RAISE EXCEPTION 'At most 8 % can be featured', CASE TG_TABLE_NAME WHEN 'products' THEN 'products' ELSE 'categories' END
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_featured_limit';
  END IF;
  RETURN NEW;
END;
$$;

-- Existing data may already exceed the limit: keep the 8 most recently updated.
UPDATE products SET is_featured = FALSE
 WHERE is_featured AND id NOT IN (SELECT id FROM products WHERE is_featured ORDER BY updated_at DESC, id LIMIT 8);

DROP TRIGGER IF EXISTS products_featured_limit ON products;
CREATE TRIGGER products_featured_limit BEFORE INSERT OR UPDATE OF is_featured ON products
  FOR EACH ROW EXECUTE FUNCTION enforce_featured_limit();
DROP TRIGGER IF EXISTS categories_featured_limit ON categories;
CREATE TRIGGER categories_featured_limit BEFORE INSERT OR UPDATE OF is_featured ON categories
  FOR EACH ROW EXECUTE FUNCTION enforce_featured_limit();
COMMIT;
