# Sri Anantha Cart

Single-store quick-commerce shop for pooja and devotional essentials in Tirupati. It has a customer website, a staff admin panel, an Android app, one API and a background worker.

| Path | What it is |
| --- | --- |
| `apps/storefront` | Customer website (Next.js), port 3000 |
| `apps/admin` | Staff admin panel (Next.js), port 3001 |
| `apps/mobile` | Android app (Expo, React Native) |
| `apps/api` | REST API `/api/v1` (Fastify, PostgreSQL): every business rule and security check |
| `apps/worker` | Background jobs from a durable PostgreSQL queue |
| `packages/*` | `contracts` (types), `api-client`, `shared` (helpers), `ui-web` (shared web UI), `config` (TS presets, security headers) |
| `database/` | `migrations`, `roles`, `performance` (benchmarks), `seed` |
| `tests/` | `e2e`, `security`, `load`, `responsive` (API tests live in `apps/api/test`) |
| `docs/` | `architecture`, `database`, `api`, `payments`, `integrations`, `deployment`, `performance` |

Start with [docs/architecture/ARCHITECTURE.md](docs/architecture/ARCHITECTURE.md). The latest status report is [docs/STAGE2_REPORT.md](docs/STAGE2_REPORT.md).

## Status

The Phase 1 codebase is under integration and acceptance review. Customers can order with **Cash on Delivery**. Online payment remains switched off until Razorpay test-mode acceptance, webhook/refund completion, and explicit client approval. SMS sign-in codes need the client's SMS Gateway Hub and DLT details. Shiprocket is not integrated yet. See [docs/deployment/LAUNCH_CHECKLIST.md](docs/deployment/LAUNCH_CHECKLIST.md) and [docs/integrations/](docs/integrations/).

## Run locally

Requirements: Node.js 22, pnpm 10 (`corepack enable`), PostgreSQL 16.

```bash
pnpm install --frozen-lockfile
```

```bash
cp .env.example apps/api/.env
```

```bash
cp .env.example apps/worker/.env
```

```bash
cp apps/storefront/.env.example apps/storefront/.env.local
```

```bash
cp apps/admin/.env.example apps/admin/.env.local
```

Set `DATABASE_URL` and `SESSION_SECRET` in `apps/api/.env` and `apps/worker/.env`, then:

```bash
pnpm --filter @sac/api migrate
```

```bash
pnpm --filter @sac/api seed:demo
```

```bash
pnpm dev
```

`pnpm dev` starts the API (:4000), worker, storefront (http://localhost:3000) and admin (http://localhost:3001/admin). With `OTP_PROVIDER=dev-outbox`, customer sign-in codes are written to the `OTP_DEV_OUTBOX` file instead of being sent by SMS.

### First admin

```bash
pnpm --filter @sac/api staff:grant -- 9000000000 admin
```

This prints a one-time temporary password (`9000000000` is a placeholder number). The first sign-in at `/admin` forces a new password. Further staff are managed in **Admin → Settings → Admin accounts**, where every change asks for your own password.

## Checks

```bash
pnpm typecheck
```

```bash
pnpm build
```

```bash
TEST_DATABASE_URL=postgres://postgres@localhost:5432/sac_test pnpm test:api
```

```bash
pnpm verify:migrations
```

```bash
pnpm verify:deployment
```

The API suite (182 tests) applies every migration to a fresh schema and runs the real application: sign-in, sessions and CSRF, role checks on every admin route, cross-customer isolation, GST pricing, tamper-proof totals, idempotent and concurrent checkout, fulfilment, refunds, uploads, the job queue, sales summary, cursor paging and storage. `pnpm test:security` repeats it as the least-privilege database role on a Supabase-like cluster (see `tests/security`). Browser E2E: `pnpm test:e2e` (see `tests/e2e/storefront-admin.e2e.cjs` for the variables it needs).

## Deploy

Storefront, admin, Fastify API and scheduled worker run on Vercel; PostgreSQL and images remain on Supabase. See [docs/deployment/DEPLOYMENT.md](docs/deployment/DEPLOYMENT.md), [HOSTING.md](docs/deployment/HOSTING.md) and [DOMAIN.md](docs/deployment/DOMAIN.md). Nothing is deployed by this repository.
