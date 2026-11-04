# Database migrations

Apply numbered SQL migrations in order using the database's migration-capable tool. Review each migration before applying it to a shared database. Preserve append-only history and keep the target's migration ledger authoritative. Never run development seed data in production.

**Sri Anantha Cart staging (verified 2026-11-03):** project `sri-anantha-cart-staging` (`gtafzzkiyitfzadqusad`, `ap-south-1`, PostgreSQL 17.11) has 029–031 recorded and 032–037 pending. Its Supabase history also contains `027_create_runtime_login`, which is not a file in this repository and must be preserved. The Supabase ledger has no checksum column. Do not run `apps/api/scripts/migrate.mjs` against staging: it expects a separate checksum-based `schema_migrations` table and does not reconcile the Supabase ledger. The reviewed future order is **032 → 033 → 034 → 035 → 036 → 037**, using the Supabase migration mechanism after the local PostgreSQL 16 validation and explicit release approval. Never reapply 029–031.

## Current migrations

- `001_initial_schema.sql`: core schema, constraints, indexes, order/payment state fields, audit logs.
- `002_development_seed.sql`: clearly labelled fake catalog data for local development only. Do not use as real inventory or production product data.
- `003_otp_challenges.sql`: short-lived OTP challenges and attempt tracking.
- `004_checkout_idempotency.sql`: checkout idempotency and payment expiry fields.
- `005_inventory_reservations.sql`: per-order stock reservations with idempotent release/consume states.
- `006_payment_reconciliation_queue.sql`: durable payment reconciliation jobs, retry scheduling, and operator-review states.
- `007_checkout_email.sql`: stores the original checkout email so idempotent retries cannot silently change the online payment identity.
- `008_payment_reconciliation_lease_tokens.sql`: adds fencing tokens so a stale reconciliation worker cannot apply results after another worker has reclaimed the job.
- `009_phase1_detailed_scope.sql`: product GST/HSN/weight fields, category hierarchy, variants/images, order financial metadata, refunds, delivery slots, and customer account events.
- `010_delivery_payment_settings.sql`: delivery and payment settings foundations.
- `011_refund_idempotency.sql`: makes admin refund creation safe to retry after request timeouts.
- `012_inventory_restock_state.sql`: adds a `restocked` reservation state so paid orders cancelled before dispatch can restore stock exactly once.
- `013`–`020`: phone format fixes, legacy refund tracking, Phase 1 completion (media assets, settings), staff passwords, featured limits, staff management, search (pg_trgm).
- `021_database_hardening.sql`: append-only audit log, immutable order amounts and lines, PUBLIC revokes (skipped on Supabase).
- `022_catalogue_performance.sql`: product sales summary with triggers, hot-path indexes.
- `023_jobs_outbox_integrations.sql`: worker queue, outbox, webhook events, notifications, shipments.
- `024_access_control.sql`: RLS on every table, `sac_backend` role, no privileges for Supabase API roles.
- `025_media_storage.sql`: storage metadata and Supabase Storage buckets.
- `026_razorpay_payments.sql`: replaces the legacy PayU provider constraints with Razorpay and adds provider refund identifiers; refuses to proceed while PayU records remain.
- `027_application_function_search_path.sql`: pins `search_path` for application-owned database functions; extension-owned functions are excluded.
- `028_return_management.sql`: separate return records, private evidence metadata, courier tracking, auditable return events, legacy-return backfill, and backend-only RLS.
- `029_shiprocket_request_safety.sql`: makes shipment requests safe under ambiguous provider responses and adds a uniqueness guard for future idempotency. It does not enable or call Shiprocket.
- `030_self_delivery_otp.sql`: adds the self-delivery provider choice, encrypted/hash delivery OTP storage, delivery assignments, COD collections, and backend-only RLS.
- `031_delivery_partner_auto_assignment.sql`: adds the delivery-partner role, preserves Shiprocket fulfillment choices, makes the delivery code valid until consumed at baseline, and adds assignment/COD tables.
- `032_delivery_partner_portal.sql`: adds partner codes and workflow timestamps, assignment events, delivery issues, and a delivery notification outbox, with backend-only RLS.
- `033_return_cancellation.sql`: permits return cancellation in return and event status checks and adds a cancelled-return index.
- `034_partial_return_items.sql`: stores per-item return quantities and immutable product/price snapshots; deletion of an order item is restricted.
- `035_delivery_workflow_hardening.sql`: pins the 032 partner-code functions' `search_path`, bounds delivery-code sends, records partner rejections, and extends assignment event types.
- `036_otp_provider_message_reference.sql`: stores the SMS provider message ID for sign-in OTP challenges (SMS Gateway Hub `MessageId`, at most 128 characters). Drafted as 033 on `feat/delivery-partner-portal-main`; renumbered because 033 is the reviewed return-cancellation migration.
- `037_audit_log_resource_index.sql`: indexes `admin_audit_logs(resource_id, created_at DESC)` for the admin audit-log viewer. Index only; the table stays append-only.

See `docs/database/DATABASE.md` for the schema map, the sales rules and the access model.

Migrations run as the owner; the API and worker use `database/roles/app_runtime_role.sql`. From 025 on, every new table must call `SELECT enable_backend_rls('<table>')` (CI enforces this). Enable and test backups before production.

Migration 034 uses plain `CREATE TABLE` and `CREATE INDEX`, so do not replay it based on SQL idempotency. Confirm the authoritative migration ledger before applying any migration. The local checksum runner is for environments using its own `schema_migrations(migration_name, checksum_sha256, applied_at)` ledger; it is not the staging Supabase migration runner.
