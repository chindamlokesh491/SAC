# Architecture

A modular monolith (one API holding all business rules) with a separate background worker. There are no microservices.

```
 Customers (browser) ──► Storefront  (apps/storefront, Next.js) ──┐  /api, /media rewrites
 Staff (browser)     ──► Admin panel (apps/admin, Next.js)      ──┤  (same-origin cookies)
 Android app (apps/mobile, Expo) ── HTTPS + bearer token ─────────┤
 Payment / SMS / courier webhooks (when enabled) ─────────────────┤
                                                                  ▼
                                      Fastify API (apps/api)  ── /api/v1 REST, validation, auth,
                                       │      │                  pricing, checkout, admin, webhooks
                         outbox_events │      │ pg (runtime role, RLS policy, TLS)
                                       ▼      ▼
             Worker (apps/worker) ──► PostgreSQL (Supabase)  ◄── migrations (owner role, CI/deploy only)
               jobs: payments, reservations, sales summary, storefront revalidation, media cleanup, ...
             API + worker ──► Supabase Storage (service key, server-side only): product/category images
```

## Repository

| Path | What |
| --- | --- |
| `apps/storefront` | Customer website: SSR catalogue, guest cart, checkout, account. Port 3000. |
| `apps/admin` | Staff panel: orders, products, stock, payments, delivery, reports, settings, staff. Port 3001. Stricter CSP; never indexed. |
| `apps/mobile` | Android app (Expo, React Native) |
| `apps/api` | Fastify API: all business rules and security. Also exports `@sac/api/jobs` for the worker. |
| `apps/worker` | Background worker process (durable PostgreSQL job queue) |
| `packages/contracts` | Request and response types shared by every client |
| `packages/api-client` | Typed REST client: cookies on the web, bearer tokens on Android |
| `packages/shared` | Formatting and validation helpers (rupees, dates, phones, PIN codes, safe redirects) |
| `packages/ui-web` | Web components and styles shared by the storefront and admin (Modal, InvoiceView, tokens, fonts) |
| `packages/config` | TypeScript presets, security headers and API rewrites for both Next.js apps |
| `database/migrations` | The only source of schema changes (see `docs/database/DATABASE.md`) |
| `database/roles` | Least-privilege runtime login |
| `database/performance` | Benchmark dataset and recorded results |
| `database/seed` | Demo catalogue images (development only) |
| `tests/e2e` | Browser end-to-end tests: storefront and admin |
| `tests/security` | Supabase role emulation and privilege checks |
| `tests/load` | API latency and mobile LCP scripts |
| `tests/responsive` | Viewport audits (storefront, admin, Android web build) |

API unit and integration tests stay next to the code in `apps/api/test`, because they import internal modules. `packages/test-utils` was not created: there is no shared test code yet, and an empty package would only add structure.

Turborepo runs `build`, `typecheck`, `lint` and `dev` across the workspace (`turbo.json`).

## Key rules

- **The API is the only way to the data.** Browsers and the app never talk to the database or to Supabase directly. Supabase's Data API roles have no privileges on any table (see the database document).
- **Money:** integer paise, GST-inclusive prices, server-side quotes, `409 PRICE_CHANGED` if the client's total differs, idempotent checkout, transactional stock reservations, immutable order lines.
- **Sessions:** HttpOnly SameSite cookies plus a CSRF header on the web; bearer tokens in SecureStore on Android; only hashes are stored. Staff sign in with a password (scrypt) and lockout; customers with an SMS OTP.
- **Caching:** the public catalogue is cached on the storefront with the `catalog` tag and refreshed through the outbox and worker. Nothing personal is cached.
- **Background work:** the API never runs timers or detached promises. Durable jobs live in the `jobs` table:
  - claimed with `FOR UPDATE SKIP LOCKED` and a lease, so each job is held by one worker at a time;
  - retried with exponential backoff, with dead-letter status and attempt history;
  - recurring work is scheduled by dedupe key, so several workers are safe;
  - on SIGTERM the worker finishes its current jobs before exiting.
- **Images:** Sharp re-encodes uploads to WebP at 1200, 720 and 400 px. They are stored on local disk in development and in Supabase Storage in production, in public read-only buckets written only by the API with the service key.

## Worker jobs

| Kind | Schedule | Effect |
| --- | --- | --- |
| `inventory.expire_reservations` | every 60 s | Releases stock held by unpaid, expired checkouts |
| `payments.reconcile` | every 30 s | Confirms or fails pending online payments with the provider |
| `catalog.refresh_sales` | every 15 min | Moves the 90-day sales window |
| `catalog.rebuild_sales` | 03:10 IST | Recomputes sales from order history |
| `media.cleanup_orphans` | 03:40 IST | Deletes uploads that nothing uses after 24 h (never images in past orders) |
| `jobs.prune` | 04:10 IST | Removes finished jobs and published events older than 14 days |
| `storefront.revalidate` | on `catalog.changed` | Refreshes the storefront cache after admin changes |

Payment webhooks, SMS notifications and shipment tracking become worker jobs as those integrations are added (see `docs/integrations/`).
