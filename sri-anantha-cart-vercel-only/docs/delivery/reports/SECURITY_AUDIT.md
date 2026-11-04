# Security Audit — Sri Anantha Cart

Date: 2026-11-04. Scope: authentication and sessions, authorisation by role, payments, OTP and SMS, the delivery workflow, data access, configuration and secrets, and the browser security policy.
Method: code review, plus the automated evidence in `TEST_RESULTS.md`. No penetration test or third-party scan was performed.

## 1. Controls verified by tests

| Control | Evidence |
| --- | --- |
| Staff roles cannot be granted over HTTP; only `staff:grant` (shell) or an admin with password re-confirmation | `api-security` route allowlist test |
| Password sign-in is admin/operator only; partners use an SMS code; customers use SMS code or Google | `staff-auth.ts`, tests |
| Temporary passwords must be changed before any admin/operator API call | `PASSWORD_CHANGE_REQUIRED` tests |
| Role isolation: customer ↔ admin ↔ partner | `api-security`, `delivery-workflow` |
| Partners act only on their own active assignment (404 otherwise) | `delivery-workflow` |
| Customer delivery code: owner-only, out-for-delivery-only, `no-store`, never in partner/admin payloads; hashed and order-bound; one-time; 5 attempts; 4 sends; 60 s cooldown | `delivery-workflow` |
| Partner and customer sign-in codes cannot be cross-used | `delivery-workflow` |
| Self-delivery cannot be dispatched or delivered from the admin panel; reassignment locked after pickup except the exception workflow | `delivery-workflow` (new) |
| Refunds admin-only, idempotent, capped; failed refunds final | `refund-lifecycle` |
| **Live Razorpay refused** unless `NODE_ENV=production`, explicit `DEPLOYMENT_ENV=production` and `RAZORPAY_LIVE_APPROVED=true`; mode/key-prefix mismatch refused; the blueprint pins test mode | `razorpay`, `config`, `verify:deployment` |
| Dev OTP outbox only with `DEPLOYMENT_ENV=staging` + `ALLOW_DEV_OTP=true` + `OTP_PROVIDER=dev-outbox` | `config` |
| SMS Gateway Hub: API key in the POST body (not URL/logs); DLT IDs/text validated at startup; delivery codes never on the sign-in template | `otp-sender` |
| Database: Supabase API roles have no access; RLS on every table; runtime role cannot alter schema or audit log | `db-permissions` 29/29 |
| CSP: admin loads no third-party script unless staff Google sign-in is configured; Razorpay only on the storefront | CSP tests |
| Secret hygiene: no secret literals in `render.yaml`; no secrets in `NEXT_PUBLIC_*`/`EXPO_PUBLIC_*`; tracked-secret-file check in CI | `verify:deployment`, CI step |

## 2. Findings fixed in Phase 1 integration (cumulative)

| ID | Severity | Finding | Fix |
| --- | --- | --- | --- |
| S-1 | High | Partner could dispatch unpacked or unpaid orders; no audit of partner actions | State machine + payment re-check + audit (2026-11-03) |
| S-2 | High | Live Razorpay possible in staging | Fail-closed startup guard (2026-11-03) |
| S-6 | High | **Admin could mark self-delivery delivered without the customer code** | Blocked (`DELIVERY_PARTNER_ACTION_REQUIRED`), 2026-11-04 |
| S-7 | Medium | **Reassignment possible after the partner had the goods** | Locked unless `reassignment_required` exception, 2026-11-04 |
| S-8 | Medium | Partners received passwords (unused secret that could be phished) | OTP-only partner provisioning; password login admin/operator only (ported) |
| S-3 | Low | Shared OTP hash subject | Separate subjects for partner login and delivery codes |
| S-4 | Low/compliance | Delivery codes on the login DLT template | Separate delivery template; never falls back |
| S-5 | Low | Google email case mismatch | Lower-cased comparison |
| P-1 | Medium (availability) | Admin order list 3.1 s at deep offsets (cheap request, expensive query) | Paged-first queries |

## 3. Open risks

| ID | Severity | Risk | Recommendation |
| --- | --- | --- | --- |
| O-1 | Medium | The partner PWA and admin share one origin and session cookie. Signing in as one role on the same browser signs out the other. | Partners use their own devices. A separate partner subdomain would need an infrastructure change. |
| O-2 | Medium | Delivery-code hashes and the customer-display encryption are keyed from `SESSION_SECRET` (as are sign-in OTP hashes). Rotating it invalidates every outstanding code and signs everyone out. | Rotate `SESSION_SECRET` outside delivery hours. Partners send a new code for any order still out for delivery. Record this in the runbook. |
| O-3 | Medium | No automated notification for partner rejections/issues (outbox rows are not sent) | Admin dashboard counts issues. Add a worker task when SMS/email templates exist. |
| O-4 | Low | Supabase security/performance advisors not run against staging after 032–037 | Run after applying migrations (read-only) |
| O-5 | Low | `pnpm audit`: 1 low, 5 moderate (no high/critical) | Review before launch |
| O-6 | Low | No rate limit per order on the customer delivery-code view beyond 30/10 min per IP | Acceptable: owner-only; reveals only the owner's own code |
| O-7 | Info | No penetration test, DAST or dependency licence review performed | Recommended before production launch |
