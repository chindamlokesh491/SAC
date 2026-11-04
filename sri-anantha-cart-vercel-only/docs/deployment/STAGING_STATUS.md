# Sri Anantha Cart — staging environment

Last reconciled: 2026-11-03 (Supabase migration history and schema catalog, read only)

## Resources created

| Service | Resource | Identifier / region | Status |
| --- | --- | --- | --- |
| Supabase | `sri-anantha-cart-staging` | `gtafzzkiyitfzadqusad` · Mumbai (`ap-south-1`) | Active; PostgreSQL 17.11; migrations through 031 recorded; 032–035 pending |
| Vercel | `sri-anantha-cart-storefront-staging` | `prj_uYXgNVPZKf5oRgS6EeGFsoTQAaUS` | Created; no Git connection or deployment yet |
| Vercel | `sri-anantha-cart-admin-staging` | `prj_Pdr6OS4BsvIiLX87BXFRzh5yi0Gp` | Created; no Git connection or deployment yet |
| Render | API / worker staging | — | Not created; source repository has no pushed commit yet |

## Safety controls

- The existing client demo service remains untouched and continues to point at the original repository and `client-walkthrough-demo` branch.
- No production domain or DNS records were changed.
- No Razorpay, SMS, Google OAuth, database-owner, or Supabase service-role credentials are stored in this repository.
- `CHECKOUT_ENABLED`, `ONLINE_PAYMENTS_ENABLED`, and `RAZORPAY_REFUNDS_ENABLED` remain disabled in deployment defaults.
- Vercel preview protection is enabled. The staging projects have no custom domain attached.
- Render's existing client demo is not reused for staging.

## Database migration state

- Supabase migration history records migrations 029, 030 and 031. Do not reapply them.
- Supabase history also has `027_create_runtime_login`, which is not present as a migration file in this repository. Preserve that history entry; it is separate from the repository's `027_application_function_search_path.sql`.
- The Supabase migration ledger has no checksum column. Do not use `apps/api/scripts/migrate.mjs` against staging: that local runner expects a different, checksum-based `schema_migrations` table and does not understand the Supabase history.
- The public schema inspection found the prerequisites from migrations 028–031 and no objects from 032, 034 or 035. Return status checks still have the pre-033 definitions. This was a bounded read-only catalog check, not a full-schema diff.
- Proposed staging migration order after PG16 validation and explicit release approval: **032 → 033 → 034 → 035**, using Supabase's migration mechanism. Apply the migrations before deploying code that requires them. No staging migration has been run.
- Delivery OTP SMS is not cleared for live use by schema validation. Before sending live codes, the provider-side delivery-code DLT template must be approved, linked to the client's sender/header, and configured according to `docs/integrations/SMS_DLT.md`. No live SMS was sent.

## Remaining staging setup

1. Complete PostgreSQL 16 API, runtime-role/security, E2E, and migration tests on a disposable local database.
2. Review the validated local changes and obtain release approval. No push or deployment is included in this staging reconciliation.
3. After separate approval, apply only migrations `032` through `035` in order with the Supabase migration mechanism; verify the ledger, RLS, function search paths, and resulting schema.
4. Push and connect the reviewed source only after the owner approves that release step.
5. Configure the staging API with staging database credentials, verified TLS CA, Supabase Storage credentials, and non-production SMS settings.
6. Configure Vercel preview environments with the API URL and public Supabase values; keep secret keys server-side.
7. Run API, storefront, admin, and end-to-end smoke tests before enabling checkout or online payments.

The Render Blueprint in `render.yaml` describes always-on paid services and must not be applied to the free staging environment without a separate cost review. The existing client demo is not part of this staging setup.
