# Vercel-only deployment guide

Sri Anantha Cart runs its complete application tier on Vercel. Supabase remains the managed PostgreSQL database and object storage.

## Production topology

| Component | Deployment | Project root / location |
|---|---|---|
| Customer storefront | Vercel | `apps/storefront` |
| Admin dashboard | Vercel | `apps/admin` |
| Fastify REST API | Vercel Node.js Function (Fluid compute) | `apps/api` |
| Background jobs | Vercel Cron → protected Fastify route → PostgreSQL durable queue | API project |
| PostgreSQL | Supabase Mumbai (`ap-south-1`) | Existing project |
| Images | Supabase Storage | Existing buckets |

There is no Render service in this deployment. The existing worker package remains in the repository for local development and integration tests; production job execution is performed by the API project's Vercel Cron route.

## Vercel account and plan

Use Vercel Pro for the commercial storefront and admin. The API's worker cron is scheduled every minute, which requires a plan that supports per-minute Cron scheduling. Hobby cron schedules are limited to once per day and are not sufficient for reservation expiry, payment reconciliation and queued notifications.

Vercel Cron invokes production deployments only. It does not automatically retry a failed invocation. The PostgreSQL queue remains durable and retries jobs using its own attempts, backoff and lease recovery.

## Create three Vercel projects

Connect the same Git repository three times. Enable **Include files outside the Root Directory** for every project because the apps import shared workspace packages.

### 1. Customer storefront

- Project name: `sri-anantha-cart-storefront`
- Root Directory: `apps/storefront`
- Framework: Next.js
- Install Command: `pnpm install --frozen-lockfile`
- Build Command: `pnpm --filter @sac/storefront build`
- Output Directory: leave default
- Node.js: 22.x
- Production branch: the approved production branch
- Region: `bom1` for any server-side functions

### 2. Admin dashboard

- Project name: `sri-anantha-cart-admin`
- Root Directory: `apps/admin`
- Framework: Next.js
- Install Command: `pnpm install --frozen-lockfile`
- Build Command: `pnpm --filter @sac/admin build`
- Output Directory: leave default
- Node.js: 22.x
- Production branch: the approved production branch
- Region: `bom1` for any server-side functions

The admin app redirects `/` to `/admin`. The storefront redirects `/admin/*` to the separate admin domain when `ADMIN_APP_URL` is configured.

### 3. Fastify API and scheduled worker

- Project name: `sri-anantha-cart-api`
- Root Directory: `apps/api`
- Framework: Vercel detects the Fastify application from `src/index.ts`
- Install Command: `pnpm install --frozen-lockfile`
- Build Command: leave blank / use Vercel's Fastify zero-configuration build
- Output Directory: leave blank
- Node.js: 22.x
- Region: `bom1` (Mumbai)

`src/index.ts` exports the Fastify app as the default export. Do not run `app.listen()` in this entrypoint; Vercel owns the HTTP server. The API's existing `src/server.ts` and `dist/server.js` remain the local persistent-server entrypoint for development and tests.

The API project's `vercel.json` registers `/api/internal/worker` every minute and limits function execution to 60 seconds. The worker route requires the Vercel `CRON_SECRET` bearer token and obtains a PostgreSQL advisory lock to prevent overlapping invocations. Each invocation executes one bounded queue cycle. Job leases, idempotency, retry/backoff and dead-letter handling remain in PostgreSQL.

## Domains

Assign these domains after each project has a successful preview deployment:

| Vercel project | Domain |
|---|---|
| Storefront | `sriananthacart.in` and optionally `www.sriananthacart.in` |
| Admin | `admin.sriananthacart.in` |
| API | `api.sriananthacart.in` |

Set `PUBLIC_WEB_URL` on the API to the canonical storefront URL. Set `PUBLIC_API_URL` to the API domain. Configure Google OAuth allowed origins and redirect URIs for the actual production domains.

## Environment variables

Never commit real secrets. Add values in each Vercel project's Settings → Environment Variables, scoped to Production and Preview separately. Use fresh, independently generated secrets for each environment.

### API project

Required baseline:

| Variable | Value / handling |
|---|---|
| `NODE_ENV` | `production` |
| `DEPLOYMENT_ENV` | `production` |
| `DATABASE_URL` | Supabase transaction pooler URL, runtime role `sac_app_runtime`, port `6543` |
| `DATABASE_SSL` | `true` |
| `DATABASE_SSL_CA` | Supabase database CA certificate PEM |
| `DATABASE_POOL_SIZE` | `3` initially; maximum supported by this entrypoint is `5` |
| `SESSION_SECRET` | Random secret, at least 32 characters |
| `COOKIE_SECURE` | `true` |
| `TRUST_PROXY` | `1` |
| `MEDIA_STORAGE` | `supabase` |
| `SUPABASE_URL` | `https://frtsnjvofvksckonltts.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only Supabase service-role/secret key |
| `CRON_SECRET` | Random secret of at least 32 characters; Vercel sends it as `Authorization: Bearer ...` to Cron invocations |
| `INTERNAL_API_TOKEN` | Random server-only token shared with web apps that need internal API reads |
| `PUBLIC_WEB_URL` | `https://sriananthacart.in` |
| `PUBLIC_API_URL` | `https://api.sriananthacart.in` |
| `STOREFRONT_REVALIDATE_URL` | `https://sriananthacart.in/internal/revalidate` |
| `REVALIDATE_TOKEN` | Random secret of at least 32 characters; same value in storefront project |
| `GEOCODER_CONTACT` | Contact email/address required for Nominatim use |

OTP variables depend on the configured provider. For SMS Gateway Hub, set `OTP_PROVIDER=smsgatewayhub` and the approved DLT variables documented in `docs/integrations/SMS_DLT.md`. Do not use development OTP in production.

Razorpay remains safely disabled by default. Set test credentials and test the full checkout, webhook, reconciliation and refund paths before enabling online payments. Do not set `RAZORPAY_LIVE_APPROVED=true` or use live credentials until formal acceptance is complete.

### Storefront project

| Variable | Value / handling |
|---|---|
| `API_SERVER_ORIGIN` | `https://api.sriananthacart.in` |
| `INTERNAL_API_TOKEN` | Same secret as API |
| `NEXT_PUBLIC_SITE_URL` | `https://sriananthacart.in` |
| `ADMIN_APP_URL` | `https://admin.sriananthacart.in` |
| `MEDIA_PUBLIC_ORIGIN` | `https://frtsnjvofvksckonltts.supabase.co` |
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | Web OAuth client ID, only if Google sign-in is enabled |
| `REVALIDATE_TOKEN` | Same secret as API |

### Admin project

| Variable | Value / handling |
|---|---|
| `API_SERVER_ORIGIN` | `https://api.sriananthacart.in` |
| `NEXT_PUBLIC_STOREFRONT_URL` | `https://sriananthacart.in` |
| `MEDIA_PUBLIC_ORIGIN` | `https://frtsnjvofvksckonltts.supabase.co` |
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | Only if staff Google sign-in is enabled |

Only variables intentionally prefixed with `NEXT_PUBLIC_` are exposed to browser bundles. Never put database URLs, Supabase service keys, Razorpay secrets, session secrets, CRON_SECRET or internal tokens in public variables.

## Database migrations

Vercel does not run database migrations automatically. Apply migrations through a trusted CI migration job or a trusted machine using the separate database-owner connection. Never give the owner connection to the runtime API.

The existing production database may already be migrated. Check migration history before running anything. For a new environment:

```bash
DATABASE_URL="<owner connection string>" \
DATABASE_SSL=true \
DATABASE_SSL_CA="<CA PEM>" \
pnpm --filter @sac/api migrate
```

Use the migration role/connection only for migrations. The API uses the least-privilege `sac_app_runtime` role through the transaction pooler.

## Post-deployment verification

Run these checks against the API domain:

- `GET https://api.sriananthacart.in/health` returns the API health response.
- `GET https://api.sriananthacart.in/ready` returns `{"status":"ready"}` only when required tables/columns exist and PostgreSQL is reachable.
- `GET https://api.sriananthacart.in/api/internal/worker` without the Cron bearer token returns 404.
- Vercel → API project → Cron Jobs shows `/api/internal/worker` scheduled every minute.
- Vercel function logs show worker cycles completing without overlap or repeated timeout.
- Storefront and admin can sign in, load products, and display Supabase images.
- Admin product/category/inventory changes invalidate the storefront catalogue cache.
- Uploads go through the Fastify API to Supabase Storage.
- COD checkout, stock reservation, order lifecycle and delivery-partner flows pass staging acceptance.
- Razorpay test mode, webhooks, reconciliation and refunds pass before online payment is enabled.
- Verify Vercel API function region is `bom1` and Supabase database traffic uses the Mumbai transaction pooler.

## Upload-size constraint

Vercel Functions limit request and response payloads to 4.5 MB. The API therefore limits uploaded image files to 4 MB, leaving room for multipart overhead. Larger media must use a future authenticated direct-to-Supabase upload flow rather than passing through the Function.

## Performance and reliability notes

- Web storefront assets are delivered through Vercel's CDN.
- API functions run in `bom1`, close to the Supabase Mumbai database.
- The API uses a small per-instance PostgreSQL pool to limit connection multiplication from serverless scaling.
- Product images are served directly from Supabase Storage; do not proxy every image through the API.
- The database queue remains the source of truth for background work. The cron function is a bounded trigger, not an in-memory queue.
- Keep API response payloads paginated and use existing catalogue caching.
- Watch Vercel function duration, cold starts, error rates, database pooler connections, oldest queued job age, Supabase egress and Storage usage.

## Launch gates

This archive is configured for Vercel deployment, but deployment is not the same as launch approval. Keep `CHECKOUT_ENABLED=false` and `ONLINE_PAYMENTS_ENABLED=false` until production SMS, payment, refund, webhook, delivery and operational acceptance tests pass. Shiprocket is a separate integration and must not be represented as active until its credentials and live tracking flow are verified.

## Rollback

Vercel supports redeploying a previous successful deployment. Keep database changes backward-compatible and additive. Do not remove old production infrastructure until the Vercel deployment has passed the full acceptance checklist. For this Vercel-only target, Render is not part of the deployment architecture.
