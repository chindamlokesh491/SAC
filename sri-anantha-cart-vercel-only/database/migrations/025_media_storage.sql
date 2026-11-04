-- Image storage metadata, and the Supabase Storage buckets.
--
-- media_assets records where each upload lives: 'local' (API disk, development) or 'supabase'
-- (bucket + public URL). Products, categories and order snapshots keep storing the image URL.
--
-- Buckets (created only when this runs on Supabase, i.e. the storage schema exists):
--   product-images, category-images, banners, public-assets
--     public read (catalogue images anyone may see); WebP only, 5 MB per file
--   private-files
--     NOT public; downloads only through short-lived signed URLs issued by the API
-- No storage.objects policies are created for anon/authenticated: Supabase enables RLS on
-- storage.objects, so without policies those roles can neither upload, change, delete nor list.
-- Uploads and deletes come only from the API/worker with the server-side service-role key, after the
-- API has checked that the caller is an admin.
BEGIN;

ALTER TABLE media_assets
  ADD COLUMN IF NOT EXISTS storage text NOT NULL DEFAULT 'local',
  ADD COLUMN IF NOT EXISTS bucket text,
  ADD COLUMN IF NOT EXISTS public_url text;
ALTER TABLE media_assets DROP CONSTRAINT IF EXISTS media_assets_storage_check;
ALTER TABLE media_assets ADD CONSTRAINT media_assets_storage_check CHECK (
  (storage = 'local' AND bucket IS NULL)
  OR (storage = 'supabase' AND bucket IN ('product-images','category-images','banners','public-assets','private-files')));
ALTER TABLE media_assets DROP CONSTRAINT IF EXISTS media_assets_public_url_check;
ALTER TABLE media_assets ADD CONSTRAINT media_assets_public_url_check CHECK (
  public_url IS NULL OR public_url ~ '^/media/[0-9a-f-]{36}\.webp$' OR public_url ~ '^https://[a-z0-9-]+\.supabase\.co/storage/v1/object/public/');
UPDATE media_assets SET public_url = '/media/' || file_name WHERE public_url IS NULL AND storage = 'local';
CREATE INDEX IF NOT EXISTS media_assets_created_idx ON media_assets (created_at);

DO $$ BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types) VALUES
      ('product-images', 'product-images', true, 5242880, ARRAY['image/webp']),
      ('category-images', 'category-images', true, 5242880, ARRAY['image/webp']),
      ('banners', 'banners', true, 5242880, ARRAY['image/webp']),
      ('public-assets', 'public-assets', true, 5242880, ARRAY['image/webp', 'image/png', 'application/pdf']),
      ('private-files', 'private-files', false, 20971520, NULL)
    ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public, file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;
  END IF;
END $$;

COMMIT;
