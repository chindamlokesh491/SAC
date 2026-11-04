# Phase 1 Integration Audit — `integration/submission-phase-1`

Audit date: 2026-11-03 · Baseline: `main` = `origin/main` = `1717b86` (unchanged) · Integration head: see `git log main..integration/submission-phase-1`

This document has two parts:
- **Part B (below):** what was implemented after the audit was approved, with decisions, commits, test evidence and remaining risks.
- **Part A (from §0):** the original read-only audit, kept as written so its findings can be traced. Finding IDs (S-1, M-1, …) are shared by both parts.

Nothing was pushed, merged into `main`, or deployed. No live infrastructure was changed. Staging was queried read only for migration history and a bounded schema catalog snapshot (B.6); production was not queried.

---

# Part B — Implementation log (2026-11-03)

## B.1 Owner decisions applied

| # | Decision | Where it is implemented |
| --- | --- | --- |
| 1 | No separate implementations folder. Preserve all branches and history. | No branch was deleted or rewritten. Branches were merged with `--no-ff`; obsolete branches were not merged (§2). |
| 2 | Delivery-partner web/PWA in Phase 1; no native partner app | `/partner` on the admin app (B.3, step 5) |
| 3 | Keep item prices and the full cart breakdown | `main`'s cart kept. The phase2 count-only cart was not ported. |
| 4 | Keep the per-zone minimum order | `main`'s check kept. It only applies when a zone has `minimum_order_paise > 0`, so a zone with no configured minimum is not restricted. No values were invented. |
| 5 | Customer delivery OTP: 10-min expiry, resend, one-time, hashed, rate- and attempt-limited, customer-only view, audited | `apps/api/src/delivery/workflow.ts`, `routes/customer-delivery-otp.ts`, migration 035 |
| 6 | Shiprocket stays out of Phase 1 | No Shiprocket code was added. Schema 023/029 and docs are unchanged. |
| 7 | Read-only staging migration reconciliation | **Completed** against the independently verified staging project; no writes. See B.6. |

## B.2 Commits on `integration/submission-phase-1` (oldest first; branch-internal commits omitted)

| Step | Commit | Summary |
| --- | --- | --- |
| 1 | `180f98d` | `.gitattributes` (LF). `git add --renormalize .` changed no committed bytes; migration blobs are identical to `main`. |
| 2 | `88b6abf` | Live Razorpay refused outside approved production (S-2) |
| 3 | `d74c6ee` | Merge `feature/advanced-catalog-filters-web-mobile` (clean) |
| 3 | `a952eb6` | Tests: `discount_only`, category facets, browser filter test |
| 4 | `ecbf09e` | Merge `feat/delivery-partner-portal` as delivered. Only conflict: the add/add in `staff-google-auth.ts` (branch version is a superset). |
| 4 | `1bdb75c` | Branch did not compile: missing brace in two admin pages |
| 4 | `2f22780` | Staff Google sign-in registered safely, emails compared case-insensitively (S-5), 6 tests |
| 4 | `f34f6d4` | Duplicate-return error code. Full returns keep the order-total refund cap (see R-9). |
| 4 | `5ef2863` | Delivery state machine, payment re-checks, audit, COD reconciliation, OTP policy, branch SQL fixes, migration 035 (S-1, R-2, R-3, R-4, S-3, M-3) |
| 4 | `b728425` | Admin CSP blocked Google sign-in. It is now enabled only when configured. |
| 5 | `acf831b` | Partners with a temporary password were locked out of the portal (found by browser E2E) |
| 5 | `9859155` | Customer delivery-code API (view and resend) plus partner/customer API client |
| 5 | `032fc24` | Delivery-partner PWA and customer delivery-code screens (web and mobile), browser E2E, CI provisioning |
| 6–7 | (this commit) | Read-only migration check script, emulation-script output fix, this report |

Not merged, intentionally: `implementation/phase-1-auth-onboarding-location`, `archive-export-2026-11-02`, `feature/staging-development-otp`, `phase2/database-function-hardening` (all superseded; merging them would revert `main`), and `feat/phase2-customer-delivery-returns-vercel` (older than `main`; see B.7). The five branches already on `main` needed no action.

## B.3 What changed, by area

**Payments (S-2): fixed.** Live Razorpay now requires `NODE_ENV=production`, an explicit `DEPLOYMENT_ENV=production` and `RAZORPAY_LIVE_APPROVED=true`. If live mode or an `rzp_live_` key is configured without all three, the API and worker refuse to start. `render.yaml` pins `RAZORPAY_MODE=test` and `RAZORPAY_LIVE_APPROVED=false`, and `verify:deployment` asserts both. Live payments, live refunds and Shiprocket remain disabled.

**Catalogue filters:** merged. Facet counts are now checked against the filtered listings; previously only the facets endpoint was tested.

**Delivery-partner portal (API).** The merged branch had build and SQL defects, and none of its order transitions were audited. Fixed:
- **S-1:** pickup requires an accepted assignment and an order the store has packed (or dispatched). Payment is re-checked at pickup and again before prepaid delivery completes. Every partner transition writes `admin_audit_logs`.
- **Branch defects that would have failed at runtime:** untyped `jsonb_build_object($n)` parameters caused 500s on issue report, wrong OTP, COD collection and first assignment. `LIMIT ${n}` instead of `$n` broke the admin issue queue. Two admin pages did not compile.
- **Reject:** partners can now reject before pickup (reason required). The store is notified, and reassignment clears the exception.
- **R-4:** every COD self-delivery, whether the partner records it or an admin overrides, produces exactly one `order_cod_collections` row, and `payments.collected_by` is set.
- **R-2:** an exact amount is required, and a retry is idempotent and reports the real state.
- **S-3:** partner sign-in codes are hashed under their own subject, and delivery codes are bound to their order.
- **Temporary passwords:** partners provisioned the normal way (they get a temporary password) were locked out of the portal. Routes open only to partners are now exempt from the password-change gate; admin and operator routes are not.

**Customer delivery OTP (decision 5; R-3):**

| Requirement | How it is met |
| --- | --- |
| 10-minute expiry | `expires_at = now() + 10 min` on every send |
| Resend invalidates the previous code | Each send replaces the hash. The partner and the customer can both request a new code. 60 s cooldown; at most 4 sends per order. |
| One-time use | `verified_at` is set and the encrypted copy is erased. Cancelling the order also expires and erases it. |
| Rate and attempt limits | 5 wrong attempts per code, plus route rate limits |
| Stored securely | SHA-256 hash with server secret, bound to order and phone. An AES-256-GCM copy exists only so the customer screen can show the code. |
| Verified server-side | `verifyDeliveryOtp` inside the locked transaction |
| Shown only to the owning customer while out for delivery | `GET /orders/:id/delivery-otp` is owner-only and `no-store`. It returns 404 for other customers, staff and the partner. Partner and admin order details never contain the code (tested). |
| Recorded in the audit trail | `order.delivery_otp_verified`, `order.delivery_otp_resent`, plus assignment events `otp_sent` / `otp_verified` / `otp_failed` |

**Delivery-partner PWA** lives at `/partner` on the admin app, so it needs no new deployment target. It covers:
- SMS-code sign-in for provisioned partners.
- Dashboard: availability, today's counts, New / In progress / Done tabs.
- Order screen: progress tracker, customer name, address, call and map links, items, payment.
- Actions: accept or return to the store; pick up once packed; customer code with expiry, attempts left and resend; exact COD amount; report a problem.
- Installable: scoped manifest, brand icons, offline page. The service worker never caches API responses.

**Customer screens:** the storefront and mobile order pages show the code while the order is out for delivery, with a countdown and "Get a new code" after expiry.

**Returns:** a second return request now gets `RETURN_ALREADY_EXISTS`. Partial-return refunds stay capped at the selected items.

**Admin Google sign-in:** the admin CSP blocked Google's script, so staff Google sign-in could never work. The script and CSP entries are now enabled only when `NEXT_PUBLIC_GOOGLE_CLIENT_ID` is set.

**Migrations:** 032–034 are byte-identical to the branch. **035** (append-only) pins `search_path` on the 032 functions (M-3) and adds OTP send tracking, rejection fields and event types.

## B.4 Test evidence (local, 2026-11-03)

| Gate | Result | Environment |
| --- | --- | --- |
| `pnpm typecheck` (9 packages) | ✅ 9/9 | Node 24.13 |
| `verify:migrations` | ✅ 35 ordered migrations | |
| `verify:deployment` | ✅ (now also on Windows) | |
| API unit + PostgreSQL integration (`pnpm --filter @sac/api test`) | ✅ **181/181** (baseline on `main`: 151) | PostgreSQL **18.1**, owner role |
| Same suite as restricted runtime role on a Supabase-like cluster | ✅ **181/181** | PostgreSQL 18.1, `sac_app_runtime` |
| Database privilege checks (`db-permissions.mjs`) | ✅ 29/29 | Supabase-like cluster (`supabase_admin` bootstrap) |
| Migrations 032–035 on an existing 031-state database, then a second run | ✅ applied 4, then 0 | Existing partner backfilled with code `SAC-DP-0001` |
| Browser E2E (`pnpm test:e2e`, 3 files in parallel) | ✅ **12/12** | Local replica of the CI stack (API, worker, storefront, admin) |
| Razorpay/Google CSP tests | ✅ 3/3 | |
| Production builds (API, worker, storefront, admin) | ✅ 4/4 | |
| Android JS bundle (`expo export --platform android`) | ✅ (4.77 MB Hermes bundle) | |
| `pnpm audit --prod --audit-level high` | ✅ no high/critical (1 low, 5 moderate) | No dependency changes in this integration |

New tests: `delivery-workflow.integration.test.ts` (12 integration cases plus 1 encryption unit test), `staff-google.integration.test.ts` (6), 3 catalogue filter cases, Razorpay/config guards (2), 1 CSP case, and two browser files: `catalogue-filters.e2e.cjs` (3) and `delivery-partner.e2e.cjs` (full partner delivery).

**Tests that still need PostgreSQL 16:** every database-backed suite above ran on PostgreSQL 18.1, while CI pins `postgres:16`. These need a PostgreSQL 16 run (CI or a local 16 cluster) before the results count as CI-equivalent:
- the API integration suite;
- `test:security` (emulation and runtime role);
- the browser E2E stack, which migrates and seeds a real database.

**Superseded by B.6:** these PG18-era statements describe the evidence available when Part B.4 was first written. Disposable PostgreSQL 16.15 validation has since been run; see B.6 for exact commands, results, and the remaining browser E2E failure.

No PostgreSQL-18-only features are used.

**Not run:** `tests/load/*` (latency and LCP benchmarks), `tests/responsive/*` audits (phone-width checks are covered by the E2E), and the mobile app on a device or emulator. Only the Android JS bundle was built; mobile screens were not exercised interactively.

## B.5 Finding status

| ID | Status | Notes |
| --- | --- | --- |
| S-1 state machine / payment / audit | ✅ Fixed, tested | |
| S-2 live Razorpay outside production | ✅ Fixed, tested | |
| S-3 shared OTP hash subject | ✅ Fixed, tested | Partner login and delivery codes are separated. Customer login codes still use the original subject (unchanged). |
| S-4 DLT template for delivery codes | ⚠️ **Open** | Delivery codes still go through the login-OTP sender. A delivery-code DLT template must be registered before live SMS. The customer can also read the code in-app. |
| S-5 Google email case | ✅ Fixed, tested | |
| R-1 CRLF | ✅ Fixed | |
| R-2 COD amount / idempotency | ✅ Fixed, tested | |
| R-3 OTP brute force / resend | ✅ Fixed, tested | |
| R-4 COD source of truth | ✅ Fixed, tested | Only for collections from now on. Historic admin-delivered COD orders have no collection row; a reporting backfill would be a separate, reviewed data migration. |
| M-1 staging tracking unknown | ✅ **Reconciled read-only** (B.6) | 029–031 recorded; 032–035 pending. |
| M-2 CRLF checksums | ✅ Fixed | |
| M-3 `search_path` on 032 functions | ✅ Fixed in 035, tested | |
| M-5 migrations README | ✅ Updated | Entries for 029–035 added. |
| M-6 deploy order | ⚠️ Ops note | Apply 032–035 **before** deploying this API; readiness requires the 032 schema. |
| G-1 partner UI | ✅ Web PWA | Native partner app out of scope (decision 2) |
| G-2 customer OTP view | ✅ Web and mobile | |
| G-3 partner lifecycle tests | ✅ | |
| G-4 mobile per-account tour and auto PIN detection | ⚠️ **Not done** | Not in the approved sequence; see B.7 |
| G-5 `discount_only` tests | ✅ | |
| G-6 Shiprocket | ➖ Out of scope (decision 6) | |
| G-8 notification outbox consumer | ⚠️ Open | `delivery_notifications_outbox` rows (rejections, issues) are written, but nothing sends them. Admins see issues in the dashboard; rejections need a dashboard surface or a worker. |

## B.6 Step 6: staging migration-tracking reconciliation (read-only, 2026-11-03)

The owner independently verified the target as **`sri-anantha-cart-staging` (`gtafzzkiyitfzadqusad`, `ap-south-1`, PostgreSQL 17.11)**. Read-only Supabase inspection confirms migrations 029, 030 and 031 are recorded; 032–035 are not. The Supabase ledger has no checksum column. No migration was applied and no staging setting or data was changed.

The staging ledger also contains **`027_create_runtime_login`**, which is absent from this branch's migration directory. The local branch has `027_application_function_search_path`; retain both recorded Supabase history and do not attempt to replay or rename either entry. The Supabase history uses `supabase_migrations.schema_migrations` (`version`, `statements`, `name`, `created_by`, `idempotency_key`, `rollback`). It is distinct from `apps/api/scripts/migrate.mjs`, which looks for an unqualified `schema_migrations(migration_name, checksum_sha256, applied_at)`. **Do not point that local runner at staging:** it does not recognize the Supabase ledger and could attempt to reapply 001–031. Use the Supabase migration mechanism for any approved writes.

`docs/deployment/STAGING_STATUS.md` is stale: it says the schema has not been applied and instructs operators to apply 001–026, while the live staging history includes the migrations through 031 plus the additional `027_create_runtime_login` entry. Refresh that deployment document before the staging runbook is used.

Catalog snapshot (public schema): the 032-created tables `delivery_assignment_events`, `delivery_issues`, and `delivery_notifications_outbox` are absent; 034's `order_return_items` is absent; the two 032 functions are absent; and the 032/035-only columns and 035 constraints are absent. Existing prerequisite tables from 028–031 are present with RLS enabled. The `order_returns_status_check` and `return_events_to_status_check` constraints still have their pre-033 definitions without `cancelled`. No pre-existing 032–035 objects or schema drift were found in the inspected object set. This is a bounded catalog comparison, not a full-schema diff.

### Migration review and order

- **032 → 033 → 034 → 035**, in numeric order. Dependencies: 032 needs the `users`, `orders`, and `delivery_assignments` objects from 001/031 plus `enable_backend_rls`; 033 needs `order_returns` and `return_events` from 028; 034 needs 028's returns and `order_items`; 035 needs 030's `order_delivery_verifications` and 032's functions, assignments, and event table. Apply all four before deploying code that requires the new schema. Never reapply 029–031.
- **032:** columns and most tables/indexes use `IF NOT EXISTS`; functions are replaced, the trigger is dropped/recreated, and partner codes are backfilled only when null. The constraint guard checks `conname` without relation/schema scope, so an unrelated same-named constraint could skip the intended constraint; no such collision was found in the current catalog. A pre-existing manually assigned `SAC-DP-0001` could collide with the sequence backfill and fail the unique index; target catalog shows the relevant columns do not yet exist. Re-run is largely safe, but trigger recreation and sequence advancement are side effects.
- **033:** dropping and recreating both status checks is transactional and repeatable; the current checks guarantee existing values are in the allowed old set, and adding `cancelled` is widening. Rollback after commit requires a new migration and must first handle cancelled rows/events. The partial index is idempotent.
- **034:** `CREATE TABLE` and `CREATE INDEX` omit `IF NOT EXISTS`, so the migration is not rerunnable by SQL. Supabase's migration ledger must be the sole replay guard. It contains no backfill. `order_items` deletion is restricted; deleting an `order_returns` row cascades its item rows, so return deletion policy must preserve the required evidence/history.
- **035:** adds bounded send tracking, rejection data and accepted event values; its data update only fills null `last_sent_at`. Constraint guards again test names without relation/schema scope. Replacing the event check will fail if undocumented event values exist; none of the target table exists yet. It pins both 032 functions to `search_path = public, pg_temp` via the migration's current schema. The functions are default `SECURITY INVOKER`, not `SECURITY DEFINER`; pinning `public` before `pg_temp` prevents temporary-object shadowing. The integration test explicitly asserts both function configs, but was skipped here because no test database was configured.

### Test evidence and release gate

- `node scripts/verify-migrations.mjs`: **passed**, 35 ordered migrations; development seed isolation and RLS checks passed.
- Disposable test server: PostgreSQL **16.15**, local port 5434; no production or staging database was used.
- Fresh database `sac_pg16_fresh`: `node apps/api/scripts/migrate.mjs` applied migrations 001 and 003–035 (migration 002 development seed intentionally skipped); all succeeded.
- Existing-state database `sac_pg16_031`: migrations 001 and 003–031 were prepared locally; **032 → 033 → 034 → 035** were then run in order with `psql -v ON_ERROR_STOP=1 -f <migration-file>`, all succeeded. Catalog assertions confirmed both functions have `proconfig={"search_path=public, pg_temp"}`, all three 032 tables and `order_return_items` have RLS enabled, and expected 035 constraints exist.
- API suite command: `$env:TEST_DATABASE_URL='postgres://postgres@127.0.0.1:5434/sac_pg16_fresh'; pnpm --filter @sac/api test` — **181 passed, 0 failed, 0 skipped** (78.5 s); includes both 035 function `search_path` assertions.
- Security command: `$env:PATH='C:/Program Files/PostgreSQL/16/bin;' + $env:PATH; $env:EMUL_HOST='127.0.0.1'; $env:EMUL_PORT='5434'; pnpm test:security` — **passed**; restricted-runtime API suite 181/181, database privilege checks 29/29, security/CSP checks 3/3.
- Partner browser command: `node --test tests/e2e/delivery-partner.e2e.cjs` — **2 passed, 0 failed** on PostgreSQL 16, including customer-code delivery.
- Full browser command: `pnpm test:e2e` — **5 passed, 1 failed** across three browser files. Catalogue filters (3/3) and partner PWA (2/2) passed. Storefront/admin failed in `storefront-admin.e2e.cjs`: after the first cart add, adding the selected 250 g organic haldi variant returned HTTP 404; later dependent assertions cascaded. Product and variant are present and in stock in the local fixture. This remains an unresolved E2E release gate; no implementation change was made without isolating its cause.
- Migration 002 was intentionally skipped because it is development seed data. No tests were skipped in the API integration suite; in the full E2E run, tests after the failed setup produced dependent failures/cascades rather than independent evidence.
- No migration SQL correction is indicated by the bounded staging catalog inspection. **Do not approve staging writes until the full browser E2E failure is resolved and CI-equivalent gates pass.** After approval, apply 032–035 using the Supabase migration mechanism and verify the resulting ledger and catalog.

## B.7 Remaining risks and pre-deployment decisions

1. **Browser E2E gate.** Diagnose why the local storefront cart request for the in-stock 250 g organic haldi variant returns 404; rerun all browser tests on PostgreSQL 16 and require green results before release.
2. **Staging migrations.** The approved plan is 032 → 033 → 034 → 035 through Supabase's migration mechanism only, after the remaining browser E2E gate is resolved and separate explicit authorization for database writes. See B.6.
3. **Delivery OTP DLT template (S-4).** Before live delivery codes, the account owner must use the existing Airtel DLT entity and SMS Gateway Hub account to approve the exact delivery-code text and variable format, link the template to the approved header, provide the PE ID/header/template ID/category and provider API details to the implementer, and configure the API key as a server-side secret. No live SMS has been sent; see `docs/integrations/SMS_DLT.md`.
4. **Delivery outbox (G-8).** Current outbox rows are written transactionally, but there is no consumer. The two event types are admin-only; issue state is already visible from the authoritative `delivery_issues` table and admin dashboard, while assignment rejection has no inbox surface. A safe next design is an in-app admin inbox: claim rows with `FOR UPDATE SKIP LOCKED`, insert with a unique source-outbox ID, mark processed in the same transaction, and keep provider/SMS dispatch as a separate opt-in adapter with bounded retries and no OTP values. No consumer is added now because there is no durable inbox table/UI; this needs its own migration, UI and DB tests, and must not mark an event processed before the idempotent inbox insert commits.
5. **Partner/admin session isolation.** Both surfaces share the same origin and HttpOnly cookie, so signing in to one replaces the other's session. A same-origin fix that adds no infrastructure dependency is role-specific HttpOnly cookie names, selected by API route namespace (`/api/v1/admin/*` versus `/api/v1/delivery/*`), with distinct logout handling and tests proving one session cannot authenticate the other namespace. This is a proposal only. A separate partner origin is another option but needs approved domain/deployment work.
6. **Admin delivery override retained.** Review found it is limited to `admin`/`operator` roles, checks the legal order transition, payment eligibility and assignment, writes the COD collection when applicable, and records `admin_override` plus whether the customer OTP was verified. No concrete security defect was found; keep the audited override.
7. **CI is still a release gate.** CI uses PostgreSQL 16 and Node 22. Do not treat a local pass as CI evidence; run the workflow on the validated branch before release.
8. **Phase2 mobile items not ported:** per-account mobile onboarding tour and automatic PIN detection on mobile first launch. The storefront already has both.
9. **Partner-proxy limitation.** Admin `/partner` routes rely on API role checks rather than a Next.js middleware gate. Unauthenticated users see the sign-in page; data remains API-authorized.
10. **New environment variables:**
   - `RAZORPAY_LIVE_APPROVED`: API and worker. Must stay `false` until a separately approved live release.
   - `NEXT_PUBLIC_GOOGLE_CLIENT_ID`: admin build. Optional; leave unset to keep Google off the admin app.
   - CI e2e: `E2E_OPERATOR_PHONE` / `E2E_OPERATOR_PASSWORD`, provisioned by the workflow.

---

# Part A — Original audit (read-only, 2026-11-03)

## 0. Summary

| Fact | Result |
| --- | --- |
| Remote branches besides `main` | 12 (plus a stray local branch literally named `origin`, which points at `main`) |
| Branches with work that is **not yet on `main`** | **2 to integrate**: `feat/delivery-partner-portal` and `feature/advanced-catalog-filters-web-mobile`. **1 to pick from selectively**: `feat/phase2-customer-delivery-returns-vercel` |
| Branches already squash-merged or superseded | 9 (details in §2) |
| "Merged implementations folder" | **Not found** on any branch (`git ls-tree` on all 13 refs). See open question Q1. |
| Migrations on `main` | 001–031, contiguous, `verify:migrations` passes |
| Migrations pending (portal branch) | 032, 033, 034 (no numbering clash with `main`) |
| Typecheck (all 9 workspace packages) | ✅ pass |
| API unit tests that need no database (11 files) | ✅ 40/40 pass |
| Razorpay CSP security test | ✅ 2/2 pass |
| API PostgreSQL integration, e2e, browser, Android bundle | ⚠️ **Not run locally.** Local Postgres 18 is installed but not running, and test credentials are unknown. |
| `verify:deployment` on Windows checkout | ❌ fails because of CRLF line endings only. It passes on an LF export of the same commit (§6, R-1). |

The safe path is not "merge all branches". `main` is newer than most branches, and merging the older ones would **revert** delivery assignment, the Razorpay test-mode guard and migrations 029–031.

---

## 1. Existing feature inventory (`main` @ `1717b86`)

Legend: ✅ implemented with automated tests · 🟡 implemented, partial or untested · ❌ missing

| Area | Status | Evidence / notes |
| --- | --- | --- |
| Customer SMS OTP sign-in | ✅ | `routes/auth.ts`, `otp-challenges.test.ts`. Staging-only dev OTP outbox is gated by `DEPLOYMENT_ENV=staging` + `ALLOW_DEV_OTP` + `OTP_PROVIDER=dev-outbox` (`config.ts:96-97`). |
| Customer Google sign-in + account linking | ✅ | `routes/auth.ts:160-200`, `google-link.integration.test.ts`, `google-token.test.ts`. Staff are blocked from customer flows (`STAFF_USE_PASSWORD`). |
| Staff password sign-in | ✅ | `staff-auth.ts`, `staff-password.integration.test.ts` |
| Staff Google sign-in (provisioned staff only) | 🟡 | `staff-google-auth.ts` (commit `1717b86`). **No linking endpoint on `main`**: the `/auth/staff/google/link` endpoint and the admin UI to link an account exist only on the portal branch. |
| Customer onboarding tour (web) | ✅ | Per-account and guest tours in `FirstVisit.tsx` |
| Customer onboarding tour (mobile) | 🟡 | One global `tour-done` flag. Per-account tours exist only on the phase2 branch. |
| Location detection (web) | ✅ | Auto-detect on load in `Header.tsx` `DeliveryPin`, and manual detection in `LocationTools.tsx`. Reverse geocoding goes through `/api/v1/geo/reverse`. |
| Location detection (mobile) | 🟡 | Manual only (`src/location.ts`). Automatic first-launch PIN detection exists only on the phase2 branch. |
| Catalogue filters | 🟡 | Price, featured, in-stock and sort exist. There are no live facet counts, no discount filter and no mobile filter sheet; those are on the catalog branch. |
| Search | ✅ | pg_trgm (020), `search.integration.test.ts` |
| Cart and checkout (COD + Razorpay) | ✅ | Idempotent checkout, reservations, price-change guard. The cart shows a price breakdown (`43d4554`); the phase2 branch removes it (product conflict, see §3). |
| Minimum order per zone | ✅ | `pricing.ts:210`. The phase2 branch removes this (product decision). |
| Order lifecycle (admin) | ✅ | `placed→accepted→packed→dispatched→delivered` state machine, plus cancellation with restock and refund flag (`admin/orders.ts`) |
| COD invoice only after cash collection | ✅ | `buildInvoice` filter, with a test (`f7abb37`) |
| Returns (request, photo evidence, review, pickup, receipt) | ✅ | Migration 028, `routes/returns.ts`, `admin/returns.ts`, admin returns page |
| Customer return cancellation | ❌ | Portal branch (033) |
| Partial-item returns + refund ceiling | ❌ | Portal branch (034) |
| Refunds (Razorpay, receipt-gated for returns, idempotent) | ✅ | `admin/refunds.ts`, `refund-state.test.ts`. `RAZORPAY_REFUNDS_ENABLED=false` by default. |
| Manual self-delivery partner assignment (admin) | ✅ | `admin/delivery.ts`, `DeliveryAssignmentPanel.tsx`. Dispatch is blocked until a partner is assigned (`admin/orders.ts:152`). |
| Delivery-partner role and accounts | ✅ | Migration 031, `grant-role.mjs`, StaffManager |
| Delivery-partner portal API (OTP login, accept, pickup, customer OTP, COD, issues) | ❌ | Portal branch only. **No partner-facing UI exists on any branch** (web or mobile). |
| Customer-side delivery OTP display | ❌ | `order_delivery_verifications.otp_ciphertext` is designed for this (030), but no endpoint or screen reads it on any branch. |
| Shiprocket | 🟡 schema only | Tables from 023 and 029, plus a `fulfilment_provider` column (030). **No Shiprocket client, webhook or worker code exists in any app or branch.** The docs mark it "not integrated and disabled". |
| Razorpay test-mode protection | 🟡 | Key-prefix and mode must match (`razorpay.ts:36-40`), CSP is scoped to the storefront, and `CHECKOUT_ENABLED=false` by default. **Live mode is not blocked in staging** (§6, S-2). |

---

## 2. Branch-by-branch change inventory

"Ahead/behind" counts are relative to `main`. "Unique" means content that is not on `main`, determined per file by comparing the branch tip with `main`. A 3-way `git merge-tree` simulation was also run for every branch.

| # | Branch | Base | Ahead / behind | Merge-tree vs `main` | State | Unique content | Recommendation |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `integration/consolidated-staging-release` | `1717b86` | 0 / 0 | clean | **Identical to `main`** | none | No action |
| 2 | `feat/manual-delivery-assignment` | `660255c` | 33 / 2 | clean, no-op | Squash-merged (`4278ad2`) | none | No action |
| 3 | `fix/google-link-verification` | `a4f558a` | 16 / 6 | clean, no-op | Squash-merged (`c20b730`) | none | No action |
| 4 | `integration/razorpay-test-mode-guard` | `91fdc8a` | 8 / 4 | clean, no-op | Squash-merged (`660255c`) | none | No action |
| 5 | `integration/staging-migration-source-reconciliation` | `91fdc8a` | 3 / 4 | clean, no-op | Merged (`059bdb1`) | none | No action |
| 6 | `feature/staging-development-otp` | `f28ce9b` | 15 / 8 | conflicts: `refunds.ts`, `package.json` | Squash-merged (`1b197a3`), **superseded** | none. Its diff would remove return routes, the Razorpay mode default and the multipart limit. | **Do not merge** |
| 7 | `phase2/database-function-hardening` | `1b197a3` | 16 / 7 | conflict: migrations README | Squash-merged (`a4f558a`), **superseded** | none. Its diff would drop the delivery-partner E2E setup and the CSP security test. | **Do not merge** |
| 8 | `implementation/phase-1-auth-onboarding-location` | `c20b730` | 94 / 5 | conflicts: commerce test, cart (web and mobile) | Squash-merged (`91fdc8a`), **superseded** | none. Its diff would revert 564 lines: delivery assignment, staff Google sign-in, migrations 029–031, the Razorpay guard and the CSP test. | **Do not merge** |
| 9 | `archive-export-2026-11-02` | `c20b730` | 96 / 5 | same as #8 | Snapshot of #8 plus an archive workflow that was added and then removed | none | **Do not merge**; archive only |
| 10 | `feat/phase2-customer-delivery-returns-vercel` | `c20b730` | 20 / 5 | conflicts in 7 files | **Older than `main`; mixed** | Unique: mobile automatic PIN detection on first launch, mobile per-account tour, header cart-total badge, removal of the zone minimum order. **Regressions:** re-adds the legacy `POST /orders/:id/return-request` (it bypasses migration 028's return workflow), sets `issued_at` to `created_at` for COD invoices, and removes the cart price breakdown and the minimum-order check. | **Do not merge.** Port the 3 mobile/UX items by hand with tests. The minimum-order and cart-pricing changes need a product decision (Q3, Q4). |
| 11 | `feature/advanced-catalog-filters-web-mobile` | `1717b86` (current `main`) | 19 / 0 | **clean** | **Unmerged, current** | `GET /api/v1/products/filters` (facet counts and price bounds, optionally scoped by search or category), `discount_only` filter, web `ListingControls` redesign, mobile filter sheet, contracts and api-client updates, 1 new integration test block | **Integrate** (step 3) |
| 12 | `feat/delivery-partner-portal` | `4278ad2` | 70 / 1 | 1 add/add conflict: `staff-google-auth.ts` (the branch only adds the `/link` endpoint; trivial to resolve) | **Unmerged** | Migrations 032–034; partner OTP auth, profile and availability; partner order workflow (accept, pickup, customer OTP, verify, COD, issue); admin issue review and assignment timeline; staff Google linking; return hardening (settled payment required, duplicate and stale-transition guards, reject reason); customer return cancellation; partial-item returns with a refund ceiling (web, mobile, admin); readiness check requires the 032 schema | **Integrate** in two parts (steps 4–5), with fixes from §6 |

---

## 3. Conflict and dependency matrix

### 3.1 Textual conflicts against `main` (from `git merge-tree`)

| Branch | Conflicting files | Nature |
| --- | --- | --- |
| delivery-partner-portal | `apps/api/src/routes/staff-google-auth.ts` | add/add: both sides add the file; the branch also adds `/link`. Take `main` and add the link handler. |
| advanced-catalog-filters | — | clean |
| portal + catalog together | `packages/contracts`, `packages/api-client` | Both touch these; they auto-merge cleanly. |
| phase2-customer-delivery-returns-vercel | `orders.ts`, cart (web, mobile), `FirstVisit`, `Footer`, `Header`, `OrderSummary` | Stale branch. Semantic regressions as listed in §2. |
| implementation/phase-1, archive-export | commerce test, `CartScreen`, cart page | Stale; would revert later work. |
| staging-development-otp | `admin/refunds.ts`, `package.json` | Stale |
| database-function-hardening | `database/migrations/README.md` | Stale |

### 3.2 Semantic (product or behaviour) conflicts — need a decision, not a merge

| ID | Topic | `main` | Other branch | Decision needed |
| --- | --- | --- | --- | --- |
| C-1 | Cart pricing display | Item prices plus breakdown (`43d4554`, deliberately restored after phase2) | phase2: count-only cart, prices shown at checkout | Q3 (recommend keeping `main`) |
| C-2 | Zone minimum order | Enforced (`MINIMUM_ORDER_NOT_MET`) | phase2: removed ("allow smaller orders with zone delivery fee") | Q4 |
| C-3 | Customer delivery-OTP lifetime | 031 sets `expires_at` NULL ("valid until consumed") | portal: 10-minute expiry, partner-triggered resend | Q5 |
| C-4 | COD collection source of truth | Admin "mark delivered" sets `payment_status=paid` with no `order_cod_collections` row | portal: partner path writes `order_cod_collections` | Must unify (§6, R-4) |
| C-5 | Return request endpoint | Dedicated `/returns` workflow (028) | phase2: legacy `/orders/:id/return-request` | Keep `main`; never port the legacy route |

### 3.3 Dependency order

```
main (001–031)
 ├─► [S1] repo hygiene: .gitattributes (LF), docs refresh          (no deps)
 ├─► [S2] advanced-catalog-filters                                  (contracts, api-client)
 ├─► [S3] portal part A: migration 033/034 + return hardening       (needs 028)
 │        + partial returns + return cancellation
 ├─► [S4] portal part B: migration 032 + partner API + staff Google link
 │        (needs 031 delivery_assignments, 030 verifications, S3 for shared contracts)
 └─► [S5] mobile onboarding and auto-PIN port from phase2           (independent of S2–S4)
```

Splitting the portal branch is optional. It keeps returns, which are customer-facing and lower risk, separate from the partner workflow, which touches the order state machine. If splitting is too costly because the commits interleave, merge the whole branch at once, but review and test it in those two halves.

---

## 4. Database migration reconciliation

| Range | Location | Status |
| --- | --- | --- |
| 001–028 | `main` | Contiguous, verified by `verify:migrations`. The staging status doc (`docs/deployment/STAGING_STATUS.md`, last updated 2026-10-30) still says "Apply migrations 001 through 026" and that staging schema is "not yet applied". **The doc is stale.** |
| 029–031 | `main` (`059bdb1`) | Applied to staging **before** they were committed ("Do not reapply migrations 029–031 to current staging"). |
| 032 `delivery_partner_portal` | portal branch | Pending. Additive (`IF NOT EXISTS`); RLS is enabled on all 3 new tables. |
| 033 `return_cancellation` | portal branch | Pending. Adds `cancelled` to `order_returns` and `return_events` status checks. |
| 034 `partial_return_items` | portal branch | Pending. New table with RLS. Not idempotent (`CREATE TABLE` without `IF NOT EXISTS`); acceptable because the runner tracks it. |

No numbering conflicts: no other branch adds a migration numbered 029 or higher, and stale branches only lack 027–031 rather than redefining them.

Issues to resolve before applying 032–034 anywhere:

| ID | Issue | Severity |
| --- | --- | --- |
| M-1 | **Staging tracking state is unknown.** Migrations 029–031 were applied out-of-band. If `schema_migrations` has no rows for them, `pnpm --filter @sac/api migrate` will try to re-apply them. They are mostly `IF NOT EXISTS`, but 031 re-runs `UPDATE order_delivery_verifications SET expires_at=NULL`, which would wipe expiries set by the portal's 10-minute logic. If rows exist with checksums computed from different bytes, the runner aborts. **Needs a read-only check** of `SELECT migration_name, checksum_sha256 FROM schema_migrations ORDER BY 1` on staging, compared with `sha256` of the LF files. | High |
| M-2 | **CRLF checksum hazard.** `migrate.mjs` hashes the raw file bytes. The repo has no `.gitattributes`, and `core.autocrlf=true` here gives 342 CRLF files in this checkout. Running `migrate` from this Windows checkout against a database migrated from Linux or CI produces a checksum mismatch (it fails closed, but it blocks deploys). Fix: add `.gitattributes` with `*.sql text eol=lf` (and `* text=auto eol=lf`), or normalise `\r\n` before hashing. | High |
| M-3 | 032 creates `sac_next_delivery_partner_code()` and `sac_assign_delivery_partner_code()` **without `SET search_path`**, which regresses the hardening in 027. Supabase's advisor will flag them as `function_search_path_mutable`. Fix inside 032 before it is applied anywhere (it has not been applied to staging, so editing it is still safe), or add a 035 that runs `ALTER FUNCTION … SET search_path = <schema>, pg_temp`. Verify with the integration harness, which runs in an isolated schema. | Medium |
| M-4 | 032's code trigger fires on `UPDATE OF role`. Demoting a partner keeps the stale `delivery_partner_code`, which is harmless, but document it. | Low |
| M-5 | `database/migrations/README.md` stops at 028; 029–034 need entries. | Low |
| M-6 | The portal's `readiness.ts` requires the 032 schema. **Deploy order:** apply 032–034, *then* deploy the API. Otherwise readiness fails and traffic is held. | Ops note |

---

## 5. Missing implementation list

Ordered by Phase 1 impact.

| # | Item | Where it partly exists | Notes |
| --- | --- | --- | --- |
| G-1 | **Delivery-partner user interface** (web route or mobile mode) | API only, on the portal branch | Without it, partners can only be exercised through the API. Confirm whether Phase 1 requires a UI (Q2). |
| G-2 | **Customer view of the delivery OTP** (order detail, web and mobile) | Ciphertext stored (030/032); SMS sent | Today the only channel is SMS through the login-OTP sender (see S-4). |
| G-3 | Partner lifecycle tests: accept → pickup → verify → COD → delivered; issue → admin resolve → reassignment | Portal adds 1 test file (75 lines, about 4 tests) | The coverage is thin for a payment-affecting workflow. |
| G-4 | Mobile per-account onboarding and automatic PIN detection | phase2 branch | Port by hand. |
| G-5 | Tests for the `discount_only` filter | catalog branch | The facets endpoint is tested; the discount filter is not. |
| G-6 | Shiprocket client, webhook and reconciliation | Schema and docs only | Docs say "not integrated, disabled, needs client approval". **Recommend keeping it out of Phase 1** (Q6). |
| G-7 | Staff Google link endpoint and UI on `main` | portal branch | Comes in with step S4. |
| G-8 | Notification delivery for `delivery_notifications_outbox` | Table only | No worker consumes it, so admin alerts are counted in the dashboard only. |
| G-9 | Up-to-date staging status, migration README and an `.env` reference for new variables | — | Documentation |

---

## 6. Security and reliability findings

Ranked from most to least severe. "Branch" means the issue arrives only if that branch is merged as-is.

| ID | Sev | Where | Finding | Recommended fix |
| --- | --- | --- | --- | --- |
| S-1 | **High** | portal `delivery-partner-orders.ts` `pickup` | The partner pickup sets `orders.status='dispatched'` from **any** status except delivered or cancelled. Assignment is allowed at `placed` and `accepted`, so a partner can jump `placed → dispatched`, skipping the admin `accepted` and `packed` steps, the `NEXT_STATUS` state machine and `paymentAllowsFulfilment` (which is checked only at assignment time). The partner `verify-otp` and `cod-collection` steps also set `delivered` directly. **None of the partner transitions write `audit_logs`.** | Require `status='packed'` for pickup and re-check payment inside the transaction. Route transitions through a shared helper with `admin/orders.ts`. Add `audit()` calls. Add tests for each illegal transition. |
| S-2 | **High** | `main` `razorpay.ts:36-40`, `config.ts` | "Test mode" is protected only by key prefix. `RAZORPAY_MODE=live` with an `rzp_live_` key works in **any** environment, including `DEPLOYMENT_ENV=staging` and development. `render.yaml` does not pin `RAZORPAY_MODE`. | Fail closed: refuse `live` unless `DEPLOYMENT_ENV=production` **and** an explicit `RAZORPAY_LIVE_APPROVED=true`. Pin `RAZORPAY_MODE=test` in `render.yaml` and have `verify:deployment` assert it. Add unit tests. |
| R-1 | **High** (ops) | repo | Windows CRLF checkout breaks `verify:deployment` (verified: it fails on CRLF and passes on LF for the same commit) and causes the migration checksum hazard M-2. | Add `.gitattributes` and renormalise. |
| R-2 | Medium | portal `cod-collection` | The COD amount is compared with `total_paise` only; a partially refunded or adjusted order is not considered. The `exists` branch returns `delivered:true` without checking that the order really is delivered. | Compare against the outstanding COD amount. Return the actual state. |
| R-3 | Medium | portal `resend-otp` | It resets `failed_attempts=0`, which allows 5 guesses per resend and up to 3 resends per 10 minutes per IP rate limit. Brute force is still impractical (1e6 space), but the lockout is not durable, and each resend sends an SMS to the customer (cost and annoyance). | Keep a lifetime attempt cap per order. Rate-limit per order, not just per IP. |
| R-4 | Medium | `main` + portal | Two COD paths: admin "mark delivered" sets `paid` without an `order_cod_collections` row, while the partner path writes one. Reports and reconciliation will disagree. | Make the admin path insert a collection row (`collected_by` = admin), or forbid admin delivery when an active partner assignment exists. |
| S-3 | Low | portal `delivery-partner-auth.ts` | Partner and customer OTPs share `otp_challenges` with the same `hashOtp(phone, code)`. A code requested through the customer flow for a partner's phone can be redeemed at the partner endpoint, and vice versa. Possession of the phone is still required, so impact is low, but the purposes are not separated. | Add a `purpose` column or include the purpose in the hash input. |
| S-4 | Low/compliance | portal | The customer delivery OTP is sent through `deps.sendOtp`, which uses the **login** OTP SMS template. Under India DLT rules, the template text must match the message purpose (`docs/integrations/SMS_DLT.md`). | Register a separate DLT template or sender for delivery codes before go-live. |
| S-5 | Low | portal `staff-google-auth.ts` `/link` | It compares `lower(email)=$3` with `identity.email` without lower-casing the latter. A mixed-case Google email leaves `email_verified` false. | Use `$3 = lower(identity.email)`. |
| S-6 | Low | portal 032 | Functions without `search_path` (= M-3). | as M-3 |
| R-5 | Low | phase2 branch | The legacy `/orders/:id/return-request` route would bypass the 028 return workflow, evidence and settled-payment guards. | Never port it. |
| R-6 | Info | `main` | Razorpay CSP is scoped to the storefront, and the admin CSP excludes Razorpay (tested). Webhook HMAC uses raw bytes. ID formats are validated with regexes. | ✅ No action |
| R-7 | Info | `main` | Dev OTP outbox is triple-gated, and production config validation rejects unsafe settings. | ✅ No action |
| R-8 | Info | Shiprocket | The integration boundary is respected: no outbound calls exist anywhere. 029 adds ambiguous-request states and a unique index for future idempotency. | ✅ Keep it disabled |

---

## 7. Recommended implementation sequence

Each step is one commit series on `integration/submission-phase-1`. **Gate:** each step must pass typecheck, `verify:migrations`, `verify:deployment`, the API unit and integration tests (Postgres 16), `pnpm build`, and the Android bundle export before the next step starts. Nothing is pushed until you approve.

| Step | Work | Method | Exit criteria |
| --- | --- | --- | --- |
| S0 | Prerequisites: run Postgres 16 locally (or provide `TEST_DATABASE_URL`). Read-only check of staging `schema_migrations` (M-1). | — | Baseline: the full test suite is green on `main`. |
| S1 | `.gitattributes` (LF), renormalise. Refresh the migrations README (029–031) and STAGING_STATUS. | new commit | `verify:deployment` passes on Windows; no content diff apart from EOL. |
| S2 | Razorpay live-mode fail-closed guard (S-2) with tests | new commit | New `razorpay.test.ts` cases; `verify:deployment` asserts `RAZORPAY_MODE=test`. |
| S3 | Merge `feature/advanced-catalog-filters-web-mobile` | `git merge --no-ff` (clean) | Add a `discount_only` test (G-5). Facets test passes. Web and mobile filter sheet checked manually or with Playwright. |
| S4 | Merge `feat/delivery-partner-portal` | `git merge --no-ff`; resolve the `staff-google-auth.ts` add/add conflict by keeping both handlers | Then fix in follow-up commits: M-3 (edit 032 before it is applied anywhere), S-1, R-2, R-3, R-4, S-3, S-5. Add the partner lifecycle and illegal-transition tests (G-3). Run the return, partial-return and cancellation tests. |
| S5 | Port from phase2 by hand: mobile per-account tour and mobile automatic PIN detection (plus the header cart badge if wanted) | new commits; **no merge** of the phase2 branch | Mobile typecheck and Android export; tests on the onboarding flag logic. C-1 and C-2 are applied only if you decide to (Q3, Q4). |
| S6 | Customer delivery-OTP display (G-2); partner UI (G-1) if in scope | new work | API tests (owner-only access, never exposed to staff APIs); browser test. |
| S7 | Full regression: e2e (`tests/e2e`), security emulation (`test:security`), responsive audit | — | All green; report updated. |

---

## 8. Test and acceptance criteria

**Automated (must pass on the integration branch):**
1. `pnpm verify:migrations` and `pnpm verify:deployment`, on Windows and in CI.
2. `pnpm typecheck` and `pnpm build`, all packages.
3. `pnpm --filter @sac/api test` against Postgres 16, run both as the owner and as the runtime role (`test:security`).
4. `pnpm test:e2e` (Playwright: storefront and admin, including assign-partner-before-dispatch).
5. `npx expo export --platform android` from `apps/mobile`.

**Feature acceptance (each needs at least one automated test):**

| Feature | Acceptance |
| --- | --- |
| Catalogue filters | Facet counts match the listing totals for search, category and none. `discount_only` returns only discounted products. Invalid input returns 400. Injection strings are inert. |
| Partial returns | A customer selects items and quantities. The refund is capped at the selected value (incl. tax) and cannot exceed it even after retries. Admin sees the items and the remaining cap. |
| Return cancellation | Allowed only before `pickup_scheduled`. Event recorded. Evidence retained. |
| Return hardening | No return before payment is settled. No duplicate active return. Stale transitions are rejected. Rejection requires a reason. |
| Partner auth | OTP is issued only to active partners (generic 202 for everyone else). Lockout after 5 attempts. Logout revokes the session. A customer token cannot reach `/delivery/*`. |
| Partner workflow | Only the assigned partner can act. Pickup requires `packed`. Each step writes an audit log and an event. Delivery requires the customer OTP. COD requires the exact outstanding amount and produces one collection row. Issue → admin review → resolve or reassign. |
| Staff Google | Unprovisioned Google accounts are rejected. Linking requires a signed-in staff user. A second Google identity cannot be linked (409). |
| Razorpay | `live` is rejected unless production and explicitly approved. Mode/key prefix mismatch is rejected. Admin CSP has no Razorpay. |
| Mobile onboarding | Guest tour shown once. Each new account sees the tour once. Automatic PIN detection runs at most once, never blocks browsing, and sets only serviceable PINs. |
| Migrations | 032–034 apply on a fresh database and on a 031-state database. A second run is a no-op. Supabase advisors report no new `search_path` warnings. |

---

## 9. Verification actually performed during this audit

| Check | Result |
| --- | --- |
| Branch ancestry, ahead/behind, per-file tip comparison, `git merge-tree` against `main` for all 12 branches | Done (§2, §3) |
| `node scripts/verify-migrations.mjs` | ✅ 31 ordered migrations |
| `node scripts/verify-deployment-config.mjs` | ❌ on the CRLF checkout; ✅ on an LF export of `HEAD` |
| `pnpm install --frozen-lockfile` | ✅ |
| `pnpm typecheck` | ✅ 9/9 |
| API non-DB unit tests (11 files) | ✅ 40/40 |
| `tests/security/razorpay-csp.test.mjs` | ✅ 2/2 |
| API integration tests, e2e, `test:security`, Android export | **Not run** (no running Postgres or credentials; nothing is merged yet) |
| Branch code was **read**, not executed | Portal and catalog behaviour claims are from code review and are unverified until S3/S4. |

---

## 10. Historical open questions (as of the original read-only audit)

Questions Q1–Q6 were resolved by the owner decisions recorded in B.1. Q7 (read-only staging query) is resolved by B.6. They are retained below to preserve the original audit trail; none is a current blocker.

- **Q1.** The brief mentions a "merged implementations folder". No such folder exists on any local or remote branch. Is it outside this clone (another repo, a zip, a Drive folder)?
- **Q2.** Is a delivery-partner **UI** in Phase 1 scope, or is API plus admin enough for submission?
- **Q3.** Cart: keep the item prices and breakdown (`main`) or switch to count-only (phase2)? Recommendation: keep `main`.
- **Q4.** Zone minimum order: keep enforcing it (`main`) or remove it (phase2)?
- **Q5.** Customer delivery OTP: valid until used (031) or 10-minute expiry with resend (portal)?
- **Q6.** Confirm Shiprocket stays out of Phase 1 (schema only, disabled).
- **Q7.** May I run a **read-only** `SELECT` on the staging `schema_migrations` table (M-1)? Nothing will be written.
