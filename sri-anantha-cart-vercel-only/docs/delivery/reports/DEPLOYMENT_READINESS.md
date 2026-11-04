# Deployment Readiness

Date: 2026-11-04. Nothing has been deployed. This report separates **staging readiness** (for client acceptance) from **production launch readiness**.

## 1. Staging readiness

| Area | Status | Notes |
| --- | --- | --- |
| Source builds | ✅ | API, worker, storefront and admin build. The Android JS bundle builds. |
| Automated tests | ✅ local / ⏳ CI | Local evidence in `TEST_RESULTS.md`. CI (PG16/Node 22) runs after push. |
| Deployment contract | ✅ | `pnpm verify:deployment`: secrets are dashboard-only, Razorpay pinned to test, live not approved, dev settings absent from the blueprint |
| Environment variables | ✅ documented | `../guides/ENVIRONMENT_VARIABLES.md` |
| Database migrations | ⛔ **Blocked: ledger** | Staging has 001–031 recorded in the Supabase ledger. 032–037 are pending. Resolve `REMAINING_BLOCKERS.md` A1 before the first Render deploy. |
| Database connectivity and TLS | ✅ designed | Verified TLS (`DATABASE_SSL_CA`); runtime role for the app, owner role only for migrations |
| CORS | ✅ not required | The web apps proxy `/api` same-origin; mobile uses bearer tokens; no cross-origin browser access is allowed |
| Authentication callbacks | ⚠️ config | Google sign-in needs the staging origins added to the OAuth client (`docs/integrations/GOOGLE_AUTH_SETUP.md`). There are no other callbacks (Razorpay webhook only when online payments are on). |
| Health checks | ✅ | API `/health` (liveness) and `/ready` (schema check: refuses traffic until 032 tables/columns exist); Render `healthCheckPath: /ready` |
| Logging | ✅ | Structured JSON logs (pino) with redaction of authorization, cookie, password, OTP, token, phone and ID token fields |
| Monitoring / error reporting | ⚠️ basic | Platform logs and health checks only. No external error tracker is configured. Recommended before production. |
| Storage | ✅ designed | Supabase Storage (`MEDIA_STORAGE=supabase`); private bucket for return evidence |
| Staging restrictions | ✅ enforced in code | Razorpay test-only (startup refuses live). Real refunds off (`RAZORPAY_REFUNDS_ENABLED=false`). Real SMS off (dev outbox, triple-gated). COD on for testing. |
| Demo data | ✅ | `seed:demo` (catalogue, Tirupati zone) + `seed:acceptance` (accounts, orders in every state) |

**Staging verdict:** ready to deploy for client acceptance once A1 (migration ledger), A2 (push/PR approval) and A3 (dashboard configuration) are done. No code changes are outstanding for staging.

### Staging deployment checklist

1. Approve the push and PR; let CI pass (PG16, Node 22, E2E).
2. Run the read-only ledger check on staging; reconcile per A1 (with approval).
3. Apply migrations 032 → 037. Verify RLS and function `search_path`; run Supabase advisors (read-only).
4. Configure Render (API, worker) and the web apps with staging values (dev OTP, test-mode Razorpay or none, COD on).
5. Deploy. Confirm `/ready` returns `ready`.
6. Run `seed:demo` (if the catalogue is empty) and `seed:acceptance` against staging (`ACCEPTANCE_SEED_CONFIRM=yes`).
7. Smoke-test: store browse, checkout (COD), admin accept/pack/assign, partner PWA delivery with the customer code, return and refund.
8. Hand over `../guides/CLIENT_ACCEPTANCE_TESTING.md` to the client.

## 2. Production launch readiness (separate; not started)

| Requirement | Status |
| --- | --- |
| Client-owned production accounts (Supabase, Render/Vercel, domain, Google, Razorpay, SMS Gateway Hub) | ⛔ not provided |
| Approved DLT templates (sign-in, delivery code) | ⛔ not provided |
| Razorpay live keys + `RAZORPAY_LIVE_APPROVED=true` (separate approval) | ⛔ not approved |
| Shiprocket | ➖ out of scope |
| Backups and restore drill (PITR) | ⛔ not set up |
| Monitoring and alerting (error tracker, uptime, DB metrics) | ⛔ not set up |
| Penetration test / security review | ⛔ not done |
| Real catalogue, prices, GST, zones | ⛔ client data |
| Launch approval | ⛔ |

See `../guides/PRODUCTION_ACTIVATION_CHECKLIST.md`.
