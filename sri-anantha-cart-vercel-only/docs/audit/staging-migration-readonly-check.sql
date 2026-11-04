-- Read-only migration-tracking investigation for 027–035 (Phase 1 integration, step 6).
--
-- SELECT statements only: no INSERT/UPDATE/DELETE/DDL and no migration execution. The queries read catalog
-- metadata and migration-tracking tables only; no customer, order or payment rows are read.
-- Each section runs in its own read-only transaction, so an accidental write fails and a missing
-- tracking table (error) does not hide the other sections.
--
-- Expected checksums (sha256 of the LF file bytes, as computed by apps/api/scripts/migrate.mjs):
--   027_application_function_search_path.sql   71ffbca834a96c0ddd52a775e2e46e485ee95ad6f1dffed342b1b572f989f234
--   028_return_management.sql                  266b40b9f942ea0dbb2c6c6b61a007f11ba55adb04d6f319971585b76495fc47
--   029_shiprocket_request_safety.sql          2f6d4619e1bd294dec43e72d2a225d9e477a2227ae2e1ad09b71b5d494e5f9ac
--   030_self_delivery_otp.sql                  dc9d38d3fb87b9db370925058454283b0a5cba3e39f5687f6e5de8c5563b9f3e
--   031_delivery_partner_auto_assignment.sql   502da521353bbc2181d9bab00c89b6f5bac5acae34fa8b87535b889ec512b459
--   032_delivery_partner_portal.sql            63d44a5e491d1f6c848f49313b6393f5f43e8bf6dea93bbf49df3ba23e433cd5
--   033_return_cancellation.sql                a95a939d9765e698ba78f18368d0d01c21e47c1f9a4c55ec3b1d2d288aed8e31
--   034_partial_return_items.sql               756ee90d1bbdcc5f9600dbf7f17215256a82206dbf4e490fa25d06039540a86c
--   035_delivery_workflow_hardening.sql        fd51999d3e060999b3478f87c517cace3fd347a868d5e7ef3acbb906fa32313f

-- 0. Which tracking tables exist (this repo's runner and Supabase's own).
BEGIN TRANSACTION READ ONLY;
SELECT to_regclass('public.schema_migrations') AS app_tracking,
       to_regclass('supabase_migrations.schema_migrations') AS supabase_tracking;
ROLLBACK;

-- 1. This repo's runner (apps/api/scripts/migrate.mjs). Skip if app_tracking is NULL.
BEGIN TRANSACTION READ ONLY;
SELECT migration_name, checksum_sha256, applied_at
  FROM public.schema_migrations
 WHERE migration_name >= '027' ORDER BY migration_name;
ROLLBACK;

-- 2. Supabase CLI / MCP apply_migration history. Skip if supabase_tracking is NULL.
BEGIN TRANSACTION READ ONLY;
SELECT version, name FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 30;
ROLLBACK;

-- 3. Schema fingerprints: did each migration's objects reach this database?
BEGIN TRANSACTION READ ONLY;
SELECT '027 search_path pinned (count of pinned app functions)' AS check_name,
       (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname IN ('apply_order_sales','protect_audit_log','protect_order_amounts')
           AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%'))::text AS result
UNION ALL SELECT '028 order_returns', (to_regclass('public.order_returns') IS NOT NULL)::text
UNION ALL SELECT '029 delivery_shipments.request_state', EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='delivery_shipments' AND column_name='request_state')::text
UNION ALL SELECT '029 shiprocket unique index', (to_regclass('public.delivery_shipments_shiprocket_order_uidx') IS NOT NULL)::text
UNION ALL SELECT '030 orders.fulfilment_provider', EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='fulfilment_provider')::text
UNION ALL SELECT '030 order_delivery_verifications', (to_regclass('public.order_delivery_verifications') IS NOT NULL)::text
UNION ALL SELECT '031 delivery_assignments', (to_regclass('public.delivery_assignments') IS NOT NULL)::text
UNION ALL SELECT '031 order_cod_collections', (to_regclass('public.order_cod_collections') IS NOT NULL)::text
UNION ALL SELECT '031 role check allows delivery_partner', COALESCE((SELECT pg_get_constraintdef(oid) LIKE '%delivery_partner%' FROM pg_constraint WHERE conname='users_role_check' LIMIT 1), false)::text
UNION ALL SELECT '031 verification expires_at nullable', COALESCE((SELECT is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='order_delivery_verifications' AND column_name='expires_at'), 'n/a')
UNION ALL SELECT '032 users.delivery_partner_code', EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='delivery_partner_code')::text
UNION ALL SELECT '032 delivery_issues', (to_regclass('public.delivery_issues') IS NOT NULL)::text
UNION ALL SELECT '033 order_returns allows cancelled', COALESCE((SELECT pg_get_constraintdef(oid) LIKE '%cancelled%' FROM pg_constraint WHERE conname='order_returns_status_check' LIMIT 1), false)::text
UNION ALL SELECT '034 order_return_items', (to_regclass('public.order_return_items') IS NOT NULL)::text
UNION ALL SELECT '035 verification send_count', EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='order_delivery_verifications' AND column_name='send_count')::text;

ROLLBACK;
