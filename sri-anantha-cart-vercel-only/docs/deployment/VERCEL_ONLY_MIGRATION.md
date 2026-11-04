# Vercel-only deployment migration

## Implemented in this repository

- `apps/storefront` and `apps/admin` remain separate Next.js Vercel projects.
- `apps/api/src/index.ts` exports the existing Fastify application as the default Vercel Node.js Function. Do not run `app.listen()` in this entrypoint; Vercel owns the HTTP server.
- The Vercel API entrypoint uses the existing `buildApp`, authentication, CSRF, rate limits, raw-body Razorpay webhook verification, media routes, database readiness checks and Supabase media store.
- `apps/api/vercel.json` pins API functions to `bom1`, sets a 60-second maximum duration and schedules `/api/internal/worker` every minute.
- The worker endpoint validates Vercel's `CRON_SECRET` bearer token in constant time, obtains a PostgreSQL advisory lock, and runs one bounded durable-queue cycle.
- The PostgreSQL job queue retains leases, deduplication, retry/backoff, expired-lease recovery and idempotent handlers.
- The API's serverless PostgreSQL pool defaults to three connections per warm instance and uses the existing verified TLS helper.
- `scripts/verify-deployment-config.mjs` validates the Vercel-only deployment contract.
- `render.yaml` has been removed. The local `apps/worker` package remains for local development and integration testing; it is not a production deployment service.

## Vercel projects

Create three Vercel projects from the same repository, with **Include files outside the Root Directory** enabled:

1. Storefront: root `apps/storefront`, Next.js build `pnpm --filter @sac/storefront build`.
2. Admin: root `apps/admin`, Next.js build `pnpm --filter @sac/admin build`.
3. API: root `apps/api`, Fastify zero-configuration deployment, no custom build or output directory. Vercel detects `src/index.ts`.

All projects use Node.js 22. The API region is Mumbai (`bom1`). Full setup, environment variables, domains and migrations are documented in `docs/deployment/DEPLOYMENT.md`.

## Required plan and operational constraints

- Use Vercel Pro for commercial production and the per-minute worker schedule. Hobby Cron is once per day and is not suitable for order reservation expiry or payment reconciliation.
- Vercel Cron runs only for production deployments and does not retry failed invocations. The database queue retries jobs; monitor Cron logs and queue lag.
- Each worker invocation is bounded. A 60-second function can be terminated; jobs must remain idempotent and recover through their database leases.
- Use Supabase's transaction pooler and a least-privilege runtime role. Keep migration owner credentials separate from runtime.
- Keep `CHECKOUT_ENABLED=false` and `ONLINE_PAYMENTS_ENABLED=false` until SMS, payment, webhook, refund, delivery and end-to-end acceptance tests are complete.

## Verification still required after import

The archive can be prepared for Vercel, but no deployment can be declared production-ready until Vercel project settings/secrets are entered and the following pass against a staging deployment:

- API `/health` and `/ready`.
- Auth, cookies, CSRF and CORS from both web projects.
- Product reads, admin writes, uploads and Supabase Storage.
- Cache revalidation from admin changes.
- Cron authorization, advisory lock, queue processing, retries and lease recovery.
- Payment test mode, Razorpay webhook signature, duplicate delivery, reconciliation and refund acceptance.
- Checkout, inventory reservation/expiry, COD and delivery workflows.
- Load tests and database pooler connection counts.

The original local server entrypoint `apps/api/src/server.ts` remains available for local development and E2E tests. The Vercel entrypoint is `apps/api/src/index.ts`.
