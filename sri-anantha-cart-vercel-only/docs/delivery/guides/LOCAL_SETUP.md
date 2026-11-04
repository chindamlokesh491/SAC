# Local Setup

For developers running Sri Anantha Cart on their own machine. Uses only local services; no production credentials.

## Requirements

- Node.js 22 (CI version; Node 24 also works), pnpm 10 (`corepack enable`)
- PostgreSQL 16 (CI version; 17/18 also work locally)
- For browser tests: `pnpm exec playwright install chromium`
- For the Android app: Expo tooling (`apps/mobile/README.md`)

## 1. Install and configure

```bash
pnpm install --frozen-lockfile
cp .env.example apps/api/.env
cp .env.example apps/worker/.env
cp apps/storefront/.env.example apps/storefront/.env.local
cp apps/admin/.env.example apps/admin/.env.local
```

In `apps/api/.env` and `apps/worker/.env`, set at least:

| Variable | Local value |
| --- | --- |
| `DATABASE_URL` | `postgresql://postgres:<password>@localhost:5432/sac` |
| `SESSION_SECRET` | any random string of 32 or more characters (`openssl rand -hex 32`) |
| `OTP_PROVIDER` | `dev-outbox` (codes are written to `OTP_DEV_OUTBOX`, default `var/otp-outbox.jsonl`) |
| `CHECKOUT_ENABLED` | `true` to place COD orders locally |

Keep `RAZORPAY_*` empty and `RAZORPAY_MODE=test`. Never put real keys in local files that could be committed; `.env` files are git-ignored.

## 2. Database

```bash
createdb sac
pnpm --filter @sac/api migrate          # applies 001–037 (skips the 002 dev seed unless INCLUDE_DEVELOPMENT_SEED=true)
pnpm --filter @sac/api seed:demo        # demo catalogue, Tirupati delivery zone, slots
```

## 3. Accounts

```bash
pnpm --filter @sac/api staff:grant -- 9000000000 admin              # prints a one-time temporary password
pnpm --filter @sac/api staff:grant -- 9000000001 delivery_partner   # no password; signs in at /partner with an SMS code
```

Or create a full demo set (customer, admin, partner and orders in every state):

```bash
pnpm --filter @sac/api build
ACCEPTANCE_SEED_CONFIRM=yes pnpm --filter @sac/api seed:acceptance
```

## 4. Run

```bash
pnpm dev
```

| App | URL |
| --- | --- |
| Storefront | http://localhost:3000 |
| Admin | http://localhost:3001/admin |
| Delivery-partner PWA | http://localhost:3001/partner |
| API | http://localhost:4000 (`/health`, `/ready`) |

Sign-in codes (customer, partner, delivery codes) appear in the OTP outbox file.

## 5. Checks

```bash
pnpm typecheck
pnpm verify:migrations && pnpm verify:deployment
TEST_DATABASE_URL=postgresql://postgres:<password>@localhost:5432/sac_test pnpm test:api
pnpm build
```

Browser tests need the full stack running with dev OTP. See the `e2e` job in `.github/workflows/ci.yml` for the exact environment:

```bash
E2E_OTP_OUTBOX=<outbox path> E2E_ADMIN_PHONE=... E2E_ADMIN_PASSWORD=... \
E2E_DELIVERY_PARTNER_PHONE=... E2E_OPERATOR_PHONE=... E2E_OPERATOR_PASSWORD=... pnpm test:e2e
```

Re-run `staff:grant` for the admin and operator before each local E2E run, because the tests replace their temporary passwords. After switching databases, clear `apps/storefront/.next/cache/fetch-cache` before rebuilding: Next.js otherwise serves cached catalogue data from the previous database for the first requests.

Database security emulation (non-superuser migrations, privilege checks, runtime-role API tests) uses a throwaway cluster whose superuser is `supabase_admin`:

```bash
EMUL_HOST=localhost EMUL_PORT=5434 pnpm test:security
```

Performance (disposable database whose name contains `bench`):

```bash
psql "$BENCH_DATABASE_URL" -f database/performance/generate-dataset.sql
node tests/load/catalogue-latency.mjs http://localhost:4000 300 10
node tests/load/admin-latency.mjs http://localhost:4000 <admin-phone> <permanent-password>
```
