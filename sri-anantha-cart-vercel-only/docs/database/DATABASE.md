# Database

PostgreSQL (Supabase in production; any PostgreSQL 16+ locally). The schema is defined only by the numbered files in `database/migrations/`, which run in order through `pnpm --filter @sac/api migrate`. Each file is recorded with a SHA-256 checksum and the runner refuses edited files. All money is integer **paise** (INR); order lines keep immutable price and name snapshots.

## Requested tables mapped to the schema

Existing tables were kept and extended rather than duplicated.

| Requested | In this schema | Notes |
| --- | --- | --- |
| users | `users` | Customers and staff; `role` = customer / operator / admin |
| customer_profiles | `users` (name, email, phone) + `customer_account_events` | One profile per user, so no separate table |
| admin_users | `users.role` in (`admin`, `operator`) + password columns (017) + `staff_removed_at` (019) | |
| addresses | `addresses` | |
| categories, subcategories | `categories` (`parent_category_id`) | Two levels, enforced by the API |
| products | `products`, `product_variants` | |
| product_images | `product_images` + `media_assets` (storage, bucket, public URL; 025) | |
| inventory | `inventory`, `inventory_movements`, `order_inventory_reservations` | Reservations expire; stock never goes negative |
| carts, cart_items | `carts`, `cart_items` | Guest carts live on the device and are merged at sign-in |
| orders, order_items | `orders`, `order_items`, `order_status_history` | Amounts and lines immutable (021) |
| payments | `payments`, `payment_events`, `payment_reconciliation_jobs` | Razorpay for online gateway payments; COD is separate |
| refunds | `refunds` | Idempotency key per refund; return refunds are gated on physical receipt |
| returns, return evidence, return history | `order_returns`, `return_evidence`, `return_events` (028) | Private image evidence; owner/staff access checked by the API; return and refund states tracked separately |
| delivery_shipments, shipment_events | `delivery_shipments`, `shipment_events` (023) | Unused until a delivery partner is enabled |
| notifications | `notifications` (023) | SMS log: provider reference, status, retries. Never OTP codes. |
| audit_logs | `admin_audit_logs` | Append-only (021) |
| product_sales_summary | `product_sales_summary`, `product_sales_daily` (022) | See below |
| jobs | `jobs`, `job_attempts` (023) | Worker queue |
| outbox_events | `outbox_events` (023) | |
| idempotency_keys | `orders (user_id, idempotency_key)` unique, `refunds.idempotency_key` | Kept per table, where the guarantee is enforced |
| webhook_events | `webhook_events` (023) | Unique (provider, event_id) |
| (also) | `auth_sessions`, `otp_challenges`, `delivery_zones`, `delivery_time_slots`, `store_settings`, `wishlist_items`, `newsletter_subscribers`, `schema_migrations` | |

## Migrations added in Stage 2

| File | What |
| --- | --- |
| `021_database_hardening.sql` (amended before any deployment) | The database-level `REVOKE … FROM PUBLIC` is skipped on Supabase, where Auth, Storage, the Data API and the pooler connect through PUBLIC |
| `022_catalogue_performance.sql` | Sales summary tables and triggers; indexes on `order_items(order_id/product_id/variant_id)`, `cart_items(product_id)`, `wishlist_items(product_id)`, `order_inventory_reservations(product_id)`, `refunds(payment_id)`, `customer_account_events(customer_id)`, `inventory_movements(variant_id)` |
| `023_jobs_outbox_integrations.sql` | `jobs`, `job_attempts`, `outbox_events`, `webhook_events`, `notifications`, `delivery_shipments`, `shipment_events` |
| `024_access_control.sql` | Row Level Security on every table, the `sac_backend` group role, no privileges for Supabase API roles |
| `025_media_storage.sql` | `media_assets.storage/bucket/public_url`; Supabase Storage buckets (only when run on Supabase) |
| `028_return_management.sql` | Separate return state, private evidence metadata, auditable return events, and backfill of existing return requests |

All are additive: no table, column or row is deleted. Rollback is by restoring a backup and reverting the application code in a coordinated release. Do not drop tables that are used by the active application.

## Product sales summary (022)

- **Counted as sales:** orders in `placed`, `accepted`, `packed`, `dispatched`, `delivered`, `return_requested`.
- **Not counted:** `pending_payment` (not confirmed), `cancelled`, `refund_initiated`, `refund_completed`, `refunded` (the sale was reversed).
- Triggers on order status changes and on order-line inserts apply exact ± deltas to `product_sales_daily` (per product per IST day) and `product_sales_summary` (lifetime and 90-day totals) in the same transaction. Repeating a status never double-counts, and moving between two counted states changes nothing.
- The worker runs `refresh_product_sales_summary()` every 15 minutes, so sales older than 90 days drop out of the "popular" ranking. It runs `rebuild_product_sales()` nightly, a full recomputation from order history that corrects any drift. The test suite checks that the incremental figures equal a rebuild.

## Access control (021, 024, `database/roles/app_runtime_role.sql`)

- **Owner** (Supabase `postgres`): runs migrations only.
- **`sac_backend`** (no login): SELECT, INSERT, UPDATE and DELETE on application tables, plus execute on its functions. It has no TRUNCATE, no DDL, no access to `schema_migrations`, and no BYPASSRLS. The API and worker log in as **`sac_app_runtime`**, a member of it, with a 15 s statement timeout and a 30 s idle-in-transaction timeout.
- **`anon`, `authenticated`, `service_role`** (Supabase Data API): no privileges on any table, sequence or function. RLS is enabled on every table with a single policy for `sac_backend`, so a mistaken grant still returns zero rows. Default privileges are revoked, so future tables are not exposed either. `scripts/verify-migrations.mjs` fails CI if a later migration creates a table without `enable_backend_rls()`.
- Proven by `tests/security/run-supabase-emulation.sh`: 29 privilege checks, plus the full API suite running as the runtime role on a cluster that reproduces Supabase's role model. Results are in `tests/security/db-permissions-result.txt`.

## Connections

- The API and worker use `pg` with small pools (API `DATABASE_POOL_SIZE=5`, worker `WORKER_CONCURRENCY+1`), through Supabase's **transaction pooler**. The code uses no session-level features: advisory locks are transaction-scoped and there are no named prepared statements.
- TLS: `DATABASE_SSL=true` plus `DATABASE_SSL_CA` (Supabase's CA certificate), so the certificate is verified. Production refuses `DATABASE_SSL_REJECT_UNAUTHORIZED=false`.
- Supabase's direct database host is IPv6-only; Vercel API functions use the Supabase pooler hostname.
