# Test Results — Sri Anantha Cart, Phase 1 completion

Run date: 2026-11-04, on branch `feature/phase1-completion` at the final code commit `1873391` (audit-log viewer).

Environment: Windows 11, Node 24.13, pnpm 10.34.9, local **PostgreSQL 18.1** disposable clusters, Playwright Chromium 1243.
CI uses PostgreSQL 16 and Node 22. CI has **not** run on this branch, because nothing was pushed (see "Not covered").

## Summary

| Gate | Command | Result |
| --- | --- | --- |
| TypeScript, all 9 packages | `pnpm typecheck` | ✅ 9/9 |
| Migration rules (order, RLS on new tables, seed isolation) | `pnpm verify:migrations` | ✅ 37 ordered migrations |
| Deployment contract (render.yaml, env templates, secrets) | `pnpm verify:deployment` | ✅ |
| API unit + PostgreSQL integration, owner role | `pnpm --filter @sac/api test` | ✅ **196/196** (0 failed, 0 skipped) |
| Same suite as restricted runtime role, migrations as non-superuser (36 applied; dev seed skipped) | `tests/security/run-supabase-emulation.sh` | ✅ **196/196** |
| Database privilege checks (anon/authenticated/service_role/runtime) | same script, `db-permissions.mjs` | ✅ **29/29** |
| Razorpay/Google CSP tests | `node --test tests/security/razorpay-csp.test.mjs` | ✅ 3/3 |
| Browser E2E (storefront, admin, partner PWA, filters) | `pnpm test:e2e` | ✅ **12/12** |
| Responsive audit, storefront (13 pages × 10 widths) | `node tests/responsive/audit.cjs storefront` | ✅ 0/130 page loads with layout defects |
| Responsive audit, admin (12 pages × 10 widths) | `node tests/responsive/audit.cjs admin` | ✅ 0/120 page loads with layout defects |
| Production builds (API, worker, storefront, admin) | `pnpm build` | ✅ 4/4 |
| Android JS bundle | `npx expo export --platform android` | ✅ 4.77 MB Hermes bundle |
| Production dependency audit | `pnpm audit --prod --audit-level high` | ✅ exit 0 (1 low, 5 moderate; no high/critical) |
| Acceptance data script | `seed:acceptance` on a fresh database | ✅ 6 orders in 6 states; admin forced to change password; 0 live sessions left |

## Coverage by area (API integration tests)

| Area | Test files | Notable cases |
| --- | --- | --- |
| Authentication and sessions | `auth-session`, `api-security`, `google-link`, `google-token`, `staff-google`, `staff-password`, `otp-challenges` | Staff roles not grantable over HTTP; customers never signed in as staff; temporary-password gate; Google sign-in only for provisioned staff |
| Role isolation | `api-security`, `delivery-workflow` | Customer/admin → partner routes 403; partner → admin routes 403; operator → refunds 403 |
| Catalogue, search, filters | `search`, `catalogue-performance`, `admin-catalogue` | Facets agree with listings; discount filter variant-aware; injection strings inert |
| Cart, checkout, inventory | `commerce`, `inventory-reservations`, `inventory-restock`, `checkout-session` | Idempotent checkout; **last unit sold exactly once under concurrent checkouts**; price-change guard; zone minimum |
| Order lifecycle | `commerce`, `delivery-workflow`, `admin-lists` | Skipped stages refused; admin cannot bypass partner hand-over; deep pagination results |
| Audit trail | `admin-lists` | Admin-only viewer; order-reference, prefix, actor filters; full delivery trail recorded |
| Delivery partner | `delivery-partner`, `delivery-workflow` (14) | Pickup only when packed and paid; reject; reassignment lock and exception; OTP policy; COD; cancellation invalidates code |
| Customer delivery code | `delivery-workflow` | Owner-only, out-for-delivery only, `no-store`; never in partner/admin payloads; resend |
| Returns | `commerce` | Evidence privacy; receipt before refund; cancellation; partial items; duplicate return |
| Refunds | `refund-lifecycle` (4), `refund-state`, `commerce` | Idempotent replay; key reuse refused; caps; failed → retry; final states |
| Razorpay (test mode) | `razorpay`, `config`, `payment-reconciliation-helpers` | Signature checks; live refused outside approved production; mode/key mismatch refused |
| SMS Gateway Hub | `otp-sender` (5) | Form POST, key not in URL, DLT validation, provider errors, message ID, delivery template separation |
| Jobs/worker | `jobs` | Queue leasing, retries |
| Shiprocket | — | **No Shiprocket code exists** (out of Phase 1 scope by decision); schema only |

## Browser E2E (12)

| File | Cases |
| --- | --- |
| `catalogue-filters.e2e.cjs` | Live facet counts and the On sale filter; inverted price range refused; phone filter panel |
| `delivery-partner.e2e.cjs` | Full COD delivery: partner signs in on a phone-size screen, accepts, picks up; the customer reads the code on their order page; a wrong code and a wrong cash amount are refused; delivered. Plus "no script errors". |
| `storefront-admin.e2e.cjs` | First-visit tour; guest cart and wishlist; COD order; order privacy; admin fulfilment up to partner hand-over (completed by the partner); phone width; no script errors |

## Performance (measured)

Dataset: `database/performance/generate-dataset.sql` on a disposable `sac_bench` database. It has **462 products**, 100,000 orders, 300,000 order lines and 2,000 customers (107 MB). The API ran on the same machine as the database. Results are machine-dependent; compare runs only on the same environment.

**Storefront**: `tests/load/catalogue-latency.mjs`, 300 requests per endpoint, concurrency 10:

| Endpoint | p50 ms | p95 ms | p99 ms | req/s | errors |
| --- | --- | --- | --- | --- | --- |
| `/home` | 31 | 59 | 121 | 291 | 0 |
| `/categories` | 11 | 26 | 31 | 807 | 0 |
| `/products?limit=12` | 15 | 26 | 32 | 619 | 0 |
| `/products?sort=newest` | 14 | 23 | 31 | 672 | 0 |
| `/products/brass-diya` | 20 | 30 | 36 | 468 | 0 |
| `/products?q=diya` (search) | 79 | 100 | 120 | 126 | 0 |
| `/search/suggest?q=kum` | 38 | 50 | 60 | 262 | 0 |
| `/products/filters` (facets) | 30 | 46 | 58 | 321 | 0 |
| `/products?discount_only&in_stock` | 68 | 90 | 103 | 142 | 0 |
| `/products?offset=432` (last page) | 84 | 105 | 113 | 117 | 0 |
| `/products?min/max price, sort price` | 65 | 81 | 92 | 151 | 0 |

**Admin**: 60 requests per endpoint, concurrency 4, **after** the fixes in `a63ea07`:

| Endpoint | p50 before | p50 after | p95 after |
| --- | --- | --- | --- |
| Orders page 1 | 66 | 23 | 70 |
| Orders at offset 99,000 | **3,139** | **73** | 82 |
| Search by order reference | 372 | 13 | 15 |
| Search by customer name | 400 | 101 | 115 |
| Orders filtered by status | 124 | 55 | 152 |
| Dashboard | 132 | 74 | 162 |
| Reports summary | 142 | 73 | 166 |
| Customers list | **497** | **4** | 8 |

API process memory (Windows working set): 92 MB idle, 133 MB under storefront load, 115 MB after the admin runs.

Checkout consistency under concurrency is covered by the integration test "sells the last unit exactly once under concurrent checkouts". A sustained checkout load test was **not** run.

## Failures found during testing, and their fixes

| Failure | Root cause | Fix | Re-run |
| --- | --- | --- | --- |
| Admin pages could not mark self-delivery dispatched/delivered after the hand-over rule | Intended behaviour change | E2E and API tests now complete delivery through the real partner workflow (`h.fulfil`) | 195/195 and 12/12 at that point (final: 196/196) |
| Storefront E2E 404 `PRODUCT_NOT_FOUND` in one full run | A stale Next.js fetch-cache entry from another local database, served stale-while-revalidate. CI starts clean. | Local runs clear `.next/cache/fetch-cache` before building | 12/12 on a clean run |
| Responsive audit reported 120/130 "covered" | The audit set the old tour flag key, so the tour modal covered pages | Audit sets both keys | 0/130 |
| Admin order list 3.1 s at deep offset; customers list 0.5 s | Select-list subquery evaluated for OFFSET rows; GROUP BY before LIMIT | Page first, aggregate after (`a63ea07`) | Measured above; `admin-lists` tests |
| `seed:acceptance` refused by the zone minimum | The rule worked; the script's basket was too small | Script fills baskets to the minimum; lock-down moved into `finally` | Clean run |

## Not covered (be explicit)

- **PostgreSQL 16 / Node 22 (the CI matrix):** not run. Every database-backed result above is on PostgreSQL 18.1. Push the branch, or run a local PG16 cluster, before relying on these as CI-equivalent.
- **Supabase staging:** no test touched staging or any live database.
- **Mobile app on a device or emulator:** only the JS bundle was built.
- **Live SMS, Razorpay (even test keys), Shiprocket:** no external calls were made. Razorpay test-mode acceptance (`docs/payments/RAZORPAY_TEST_ACCEPTANCE.md`) needs test keys.
- **Sustained load and soak**, cold-start and network-latency effects (API and DB on one machine).
