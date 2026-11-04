# Remaining Blockers and Open Decisions

Date: 2026-11-04. Each item says what is missing, who supplies it, and what happens once it is supplied.
Everything listed under "code" is done and tested. These items are external inputs, approvals or decisions.

## A. Blocks staging deployment

| # | Blocker | Owner | Exact requirement | Then |
| --- | --- | --- | --- | --- |
| A1 | **Staging migration ledger vs Render pre-deploy step** | Project owner (approval) + engineer | Staging records migrations in Supabase's ledger. `render.yaml` runs `migrate.mjs`, which uses its own `schema_migrations` table and would try to re-run 001. Choose one: **(a)** after a read-only check (`docs/audit/staging-migration-readonly-check.sql`), insert `schema_migrations` rows for 001–031 with the expected checksums, then let the runner apply 032–037; or **(b)** apply 032–037 through the Supabase migration mechanism and change the pre-deploy command. | Apply 032 → 037 in order. Never re-run 029–031. |
| A2 | Release approval to push the branch and open a PR | Project owner | Approve pushing `feature/phase1-completion` and opening a PR into `main` | CI runs on PostgreSQL 16 / Node 22 (not yet run on this branch) |
| A3 | Staging service configuration | Engineer (with owner's access) | Render dashboard values: `DATABASE_URL` (runtime role), `MIGRATION_DATABASE_URL`, `DATABASE_SSL_CA`, `SESSION_SECRET` (generated), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `PUBLIC_WEB_URL`, `PUBLIC_API_URL`, `DEPLOYMENT_ENV=staging`, `ALLOW_DEV_OTP=true`, `OTP_PROVIDER=dev-outbox` (until DLT is approved), `CHECKOUT_ENABLED=true` for acceptance. Web apps: `API_SERVER_ORIGIN`, `NEXT_PUBLIC_SITE_URL`, `INTERNAL_API_TOKEN`, `REVALIDATE_TOKEN`. | See `../guides/STAGING_DEPLOYMENT.md` |

## B. Missing client credentials and details (do not block staging with dev OTP and COD)

| # | Item | Owner | Exactly what is needed |
| --- | --- | --- | --- |
| B1 | **SMS Gateway Hub / DLT (sign-in OTP)** | Client | SMS Gateway Hub API key; approved 6-character sender ID (header); DLT Principal Entity ID; the **approved sign-in OTP template ID and its exact text** with one `{#var#}` placeholder; whether the account uses channel `2` or `OTP` and any route. Set as `SMSGH_*` and `OTP_PROVIDER=smsgatewayhub`. |
| B2 | **DLT template for delivery codes** | Client | A second approved template for the customer delivery code (purpose: delivery confirmation, one `{#var#}`) → `SMSGH_DELIVERY_TEMPLATE_ID/TEXT`. Without it, delivery codes appear in the customer's order screen only. |
| B3 | DLT templates for customer notifications (optional) | Client | Templates for order status, return decision and refund status if SMS notifications are wanted. In-app status works today; sending them needs these templates plus a worker task (not built). |
| B4 | **Razorpay test keys** | Client | `rzp_test_` key ID and secret and a webhook secret, for test-mode acceptance (`docs/payments/RAZORPAY_TEST_ACCEPTANCE.md`). Live keys only for production after separate approval (`RAZORPAY_LIVE_APPROVED`). |
| B5 | Google OAuth client IDs | Client/engineer | Web and Android client IDs for customer Google sign-in; optionally the admin web client ID (`NEXT_PUBLIC_GOOGLE_CLIENT_ID`) for staff Google sign-in |
| B6 | Shiprocket | Client | Out of Phase 1 by decision. When approved: a dedicated API user, pickup location, service type, COD terms and package defaults (`docs/integrations/SHIPROCKET.md`). No client code exists yet. |
| B7 | Store details | Client | Support phone/email (shown to partners and customers), GSTIN and invoice details, real catalogue and stock, confirmed per-zone minimum orders and delivery fees (the demo zone uses ₹99 minimum and ₹30 fee) |
| B8 | Domains and DNS | Client | Store, admin and API domains; DNS access (`docs/deployment/DOMAIN.md`) |

## C. Open decisions

| # | Decision | Current behaviour |
| --- | --- | --- |
| C1 | Is the delivery fee refundable on a full return? | Yes: a full return is capped at the order total; a partial return at the item value |
| C2 | Branch strategy: `feature/phase1-completion` vs `origin/feat/delivery-partner-portal-main` | This branch is the single implementation. Do **not** merge the other branch's `/admin/delivery-partner` UI or its migration `033_otp_provider_message_reference.sql` (now 036 here). |
| C3 | Partners on shared browsers | Partner PWA and admin share an origin and session cookie. Partners should use their own devices, or a separate partner subdomain can be added later. |
| C4 | Admin dispatch/delivery override | Removed for self-delivery (partner hand-over and customer code required). If an emergency override is wanted, it should be a separate, audited admin action with a reason. |

## D. Not done in this phase (known gaps)

| # | Gap | Notes |
| --- | --- | --- |
| D1 | CI run on PostgreSQL 16 / Node 22 | Needs push (A2) |
| D2 | Mobile app on a device or emulator | JS bundle builds; needs a device run and an APK/AAB build with EAS credentials |
| D3 | Mobile per-account onboarding tour and automatic PIN detection | Exist on `feat/phase2-customer-delivery-returns-vercel`; not ported |
| D4 | Notification sending for `delivery_notifications_outbox` | Rows are written (rejections, issues); no sender |
| D5 | Penetration test / DAST | Recommended before production |
| D6 | Sustained load / soak test | Latency benchmarks done; no long-running test |
