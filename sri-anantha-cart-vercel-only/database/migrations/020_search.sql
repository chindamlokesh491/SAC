-- Typo-tolerant product search ("diyaa" finds "Brass Diya"). pg_trgm is a trusted extension, so the
-- database owner can enable it without superuser rights. Installed in public so every schema sees it.
CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA public;
CREATE INDEX IF NOT EXISTS products_name_trgm_idx ON products USING gin (lower(name) public.gin_trgm_ops);
