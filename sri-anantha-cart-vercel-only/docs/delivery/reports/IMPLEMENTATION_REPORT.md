# Implementation Report — Sri Anantha Cart, Phase 1 completion

Date: 2026-11-04 · Branch: `feature/phase1-completion` (from `integration/submission-phase-1`; contains `origin/main` @ `07248f5`)
Nothing has been pushed, merged into `main` or deployed. No live service, credential or production database was used.

## 1. Starting point and approach

Work continued on the existing code. Nothing was rebuilt. Two lines of development existed:

- `integration/submission-phase-1`, with the reviewed migration order 032–035 that staging expects, the delivery-partner PWA and the customer delivery code.
- `origin/feat/delivery-partner-portal-main`, the team's branch from 2026-11-04, with a second partner UI at `/admin/delivery-partner`, the SMS Gateway Hub adapter, and an `033_otp_provider_message_reference` migration that collided with the reviewed 033.

To avoid **two implementations of one feature**, `feature/phase1-completion` keeps the integration line. It **ports** only what the integration line lacked from the team branch:

- the SMS Gateway Hub adapter, with its migration renumbered to **036**;
- OTP-only partner provisioning, with password sign-in reserved for admin and operator;
- the "no reassignment after pickup" rule.

The team branch's second partner UI was not ported. That branch is still on GitHub, unmodified.

## 2. Plan step 1 — current implementation

| Item | Status | Evidence |
| --- | --- | --- |
| **A. Delivery-partner portal** | | |
| Dedicated partner authentication (SMS code, no password) | ✅ Done | `delivery-partner-auth.ts`; partners are provisioned without a password (Staff screen and `staff:grant`). Password login is admin/operator only. |
| Partners cannot reach admin/customer functions | ✅ Tested | `delivery-workflow` tests: partner → admin routes 403; customer/admin → partner routes 403 |
| Assigned / active / completed deliveries | ✅ | PWA tabs New / In progress / Done; API `tab=assigned\|in_progress\|completed` |
| Accept / reject assignment | ✅ Tested | Reject only before pickup, reason required, admin notified via outbox |
| Pickup → out for delivery | ✅ Tested | Requires accepted assignment, store-packed order, payment re-check |
| Customer delivery OTP | ✅ Tested | 10-min expiry, resend invalidates, cooldown, send cap, 5 attempts, one-time, hashed and order-bound |
| COD collection | ✅ Tested | Exact amount, one collection row, idempotent retry |
| Issue reporting | ✅ Tested | Idempotent per client request ID; admin review queue |
| Unauthorised order access prevented | ✅ Tested | Only the assigned partner (404 otherwise) |
| No reassignment after pickup/dispatch (except the exception workflow) | ✅ **New**, tested | `DELIVERY_ALREADY_PICKED_UP`; allowed only when an issue is marked `reassignment_required` |
| Admin cannot bypass the hand-over | ✅ **New**, tested | `DELIVERY_PARTNER_ACTION_REQUIRED` for admin dispatched/delivered on self-delivery |
| All assignment/status changes recorded | ✅ Tested | `delivery_assignment_events` + `admin_audit_logs` for every transition |
| **B. Returns and refunds** | | |
| Eligibility (delivered, paid, 48 h window, one per order) | ✅ Tested | `returns.ts`; duplicate → `RETURN_ALREADY_EXISTS` |
| Request with reason; photo evidence (private storage, 5-photo limit) | ✅ Tested | Existing; private reads owner/admin only |
| Admin approve/reject (reason required to reject) | ✅ Tested | |
| Self drop-off / courier hand-over, receipt and inspection | ✅ Tested | |
| Customer cancellation before pickup; partial-item returns | ✅ Tested | Migrations 033/034 |
| Refund initiation, status, failure, retry | ✅ **New tests** | `refund-lifecycle.integration.test.ts` |
| Duplicate refund prevention | ✅ Tested | Idempotency key, replay, `IDEMPOTENCY_KEY_REUSED`, caps |
| Real refunds disabled in staging | ✅ | `RAZORPAY_REFUNDS_ENABLED=false`; Razorpay live is refused outside approved production |
| Customer notifications for returns/refunds | ⚠️ **In-app only** | Status and timeline on the order page. SMS updates need DLT templates per message (see blockers). |
| Audit logs and permissions | ✅ Tested | Admin-only refunds (operator 403) |
| **C. SMS Gateway Hub** | | |
| Provider adapter, request/response handling, timeouts, errors | ✅ Ported, tested | `otp-sender.ts`, `otp-sender.test.ts` (5 cases) |
| DLT sender ID, entity ID, template ID and text validation | ✅ | Validated at startup |
| Separate delivery-code DLT template | ✅ **New** | `SMSGH_DELIVERY_TEMPLATE_ID/TEXT`; never falls back to the sign-in template |
| Provider message references stored | ✅ | `otp_challenges.provider_message_id` (migration 036) |
| Dev OTP for staging | ✅ Kept | Triple-gated (`DEPLOYMENT_ENV=staging`, `ALLOW_DEV_OTP`, `dev-outbox`) |
| Live SMS | ⛔ Not activated | Needs client DLT details (see `REMAINING_BLOCKERS.md`) |
| **D. Application audit** | ✅ | `TECHNICAL_AUDIT.md`, `SECURITY_AUDIT.md`. Found and added the missing **admin audit-log viewer** (API, page, migration 037). |

## 3. Plan step 2 — database and backend

See `DATABASE_AUDIT.md`. Summary:
- 37 ordered migrations. Every table created after 024 has backend-only RLS.
- Functions have a pinned `search_path` (027, 035).
- Migrations were applied as a non-superuser on a Supabase-like cluster, with 29/29 privilege checks.
- The full API suite passes as the restricted runtime role (196/196).

## 4. Plan step 3 — frontends

| App | Status |
| --- | --- |
| Storefront (web) | Browser E2E: browse, filters, cart, checkout, order tracking, delivery code, phone width. Responsive audit: **0/130** page loads with layout defects. |
| Admin | Browser E2E: sign-in, temporary-password change, order fulfilment up to partner hand-over, all admin pages (incl. the new Audit Log) load. Responsive audit: **0/120** (run before the audit page existed). Order page shows "waiting for delivery partner" for self-delivery. |
| Delivery-partner PWA (`/partner`) | Browser E2E at 390×844: sign-in, accept, pickup, code, cash, history; no horizontal scroll |
| Mobile (Expo) | Android JS bundle builds (4.77 MB Hermes). Delivery-code card added. **Not run on a device or emulator.** |

## 5. Plan step 4 — testing and performance

See `TEST_RESULTS.md`. Performance was measured on 462 products, 100,000 orders and 300,000 order lines. It found and fixed three slow admin queries: a deep page went from 3.1 s to 73 ms, the customer list from 497 ms to 4 ms, and order-number search from 372 ms to 13 ms.

## 6. Plan steps 5–7 — staging, acceptance, production

- `DEPLOYMENT_READINESS.md` and `../guides/STAGING_DEPLOYMENT.md` cover staging. Nothing was deployed.
- `pnpm --filter @sac/api seed:acceptance` creates demo accounts and orders in every state, through the real workflow. See `../guides/CLIENT_ACCEPTANCE_TESTING.md`.
- `../guides/PRODUCTION_ACTIVATION_CHECKLIST.md` is kept separate from staging readiness.

## 7. Commits on `feature/phase1-completion` (this session)

| Commit | Summary |
| --- | --- |
| `0ad58b4` | SMS Gateway Hub adapter ported; delivery-code template; OTP-only partners; migration 036 |
| `ac4569a` | Partner hand-over required for self-delivery; reassignment locked after pickup; tests on the real workflow |
| `4682622` | Merge catalogue branch (variant-aware discount fixes) |
| `a0e4bde` | Merge `origin/main` (history only; content identical) |
| `284b430` | Refund lifecycle tests |
| `a63ea07` | Admin list performance fixes + `admin-lists` tests + `tests/load/admin-latency.mjs` |
| `bb9b7b7` | `seed:acceptance` |
| `b486153` | Responsive audit key fix + refreshed results |
| `1873391` | Admin audit-log viewer (API, page, migration 037, tests) |

The documentation commit (these reports and guides) follows these. Earlier integration work (the Razorpay live guard, partner portal hardening, PWA and customer delivery code) is recorded in `docs/audit/PHASE1_INTEGRATION_AUDIT.md`, Part B.
