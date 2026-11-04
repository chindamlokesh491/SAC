# Technical Audit — Sri Anantha Cart

Date: 2026-11-04. Reviewed against the seven-step completion plan.

## 1. Architecture (unchanged by Phase 1)

| Component | Technology | Location |
| --- | --- | --- |
| API | Fastify (TypeScript), PostgreSQL via `pg` | `apps/api` |
| Worker | Durable `jobs` table (payment reconciliation, reservation expiry, cache revalidation) | `apps/worker` |
| Storefront | Next.js 15 (App Router), same-origin `/api` rewrite | `apps/storefront` |
| Admin + delivery-partner PWA | Next.js 15; admin at `/admin`, partner at `/partner` | `apps/admin` |
| Mobile | Expo / React Native (Android) | `apps/mobile` |
| Shared | contracts (types), api-client, shared helpers, web UI kit, security headers | `packages/*` |
| Database | PostgreSQL (Supabase in staging), 36 migrations | `database/` |
| Hosting (planned) | Render (API, worker), Vercel or Render for the web apps, Supabase | `render.yaml`, `docs/deployment/*` |

The web apps never call the API cross-origin: Next.js rewrites `/api/*` to `API_SERVER_ORIGIN`, so session cookies stay first-party and no CORS layer is needed. Mobile uses bearer tokens.

## 2. Feature inventory against the plan

| Area | Implemented | Partial | Missing / blocked |
| --- | --- | --- | --- |
| Authentication | Customer SMS OTP + Google; staff password (+ optional Google); partner SMS OTP; session revocation on role or password change | — | Live SMS needs DLT credentials |
| Catalogue | Categories, subcategories, variants, search (pg_trgm), advanced filters + live facets (web + mobile) | — | — |
| Cart and checkout | Guest cart merge, server-priced quotes, idempotent checkout, reservations, zone minimum, express/scheduled slots, COD | Online payment (Razorpay) built, off by default | Razorpay test keys for acceptance |
| Orders | Lifecycle with audited transitions; cancellation with restock; invoices (COD after cash) | — | — |
| Self-delivery | Assignment, partner PWA, pickup, customer code, COD, issues, reassignment exception, audit | — | Notifications to admin/partner are queued, not sent |
| Shipping (Shiprocket) | Schema (023/029) | — | Out of Phase 1 by decision; no client code |
| Returns | Request, evidence, review, drop-off/courier, receipt, cancellation, partial items | — | — |
| Refunds | Manual refunds with idempotency, caps, statuses; Razorpay gateway path (disabled) | — | Gateway refunds need approval + test keys |
| Customer notifications | In-app status and timelines | — | SMS notifications need DLT templates |
| Admin | Dashboard, products, categories, inventory, customers, orders, payments and refunds, returns, delivery zones/slots/partner assignment, staff and partner management, settings, reports, **audit log viewer (new)** | Shipping management (no Shiprocket) | — |
| Mobile | Browse, filters, cart, checkout, orders, returns, delivery code | Not device-tested this phase | Per-account onboarding tour and automatic PIN detection (phase2 branch; not ported) |
| Acceptance tooling | `seed:demo`, `seed:acceptance`, `staff:grant` | — | — |

## 3. Branch reconciliation (2026-11-04)

| Branch | Disposition |
| --- | --- |
| `integration/submission-phase-1` | Base of `feature/phase1-completion` |
| `origin/main` (`07248f5`) | Merged (history only; content identical) |
| `origin/feature/advanced-catalog-filters-web-mobile` (`bac3b75`) | Merged (variant-aware discount fixes) |
| `origin/feat/delivery-partner-portal-main` | **Not merged.** Its SMS adapter, OTP-only partners and reassignment lock were ported. Its `/admin/delivery-partner` UI duplicates `/partner` and its migration 033 collides with the reviewed 033, so neither was taken. |
| Older branches (audit Part A §2) | Unchanged; superseded |

## 4. Engineering findings

| ID | Finding | Status |
| --- | --- | --- |
| T-1 | Two partner portals and two migration-033s across branches | Resolved on this branch (single implementation; 036) |
| T-2 | Admin lists did work proportional to OFFSET or to all orders | Fixed (`a63ea07`) |
| T-3 | Responsive audit used a renamed localStorage key and reported false defects | Fixed |
| T-4 | Local Next.js fetch cache can serve another database's products after restart (stale-while-revalidate) | Environment only; CI and fresh deploys unaffected. Clear `.next/cache/fetch-cache` when switching databases locally. |
| T-5 | `render.yaml` pre-deploy migration step is incompatible with the staging Supabase ledger | Open (see `DATABASE_AUDIT.md` DB-1) |
| T-6 | Node 24 test reporter output was hidden by the emulation script | Fixed (2026-11-03) |
| T-7 | E2E files raced on one partner's OTP when run in parallel | E2E runs sequentially |
| T-8 | Audit trail was recorded but not viewable in the app | Admin audit-log viewer + API + index (migration 037), `1873391` |
