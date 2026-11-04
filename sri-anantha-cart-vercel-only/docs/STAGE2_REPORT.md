# Stage 2 report

Branch `feat/stage2-platform` (from `main` at `30af58d`). All numbers below were measured in the local development container unless stated otherwise. **Nothing was deployed; no account, billing, DNS, payment or SMS setting was changed.**

## 1. GitHub

- Before pushing, I scanned **all 13 commits** of history (not 3 as described), the working tree and untracked files for `.env` files, keys, tokens, passwords, private keys and Razorpay, Shiprocket, SMS Gateway Hub or Supabase credentials.
- **Nothing found.** The only long encoded strings are `pnpm-lock.yaml` hashes and an image. Every `.env.example` value is a placeholder or a localhost default.
- Typecheck and the 163 API tests passed before the push.
- Pushed to `main`: **`30af58d`**, with the remote `Sri-Anantha-Cart/sri-anantha-cart` and a clean tree.
- Stage 2 work is on **`feat/stage2-platform`**. Workflow: feature branches → pull request → CI (typecheck, build, API tests, Supabase-emulation security job, E2E) → merge. Branch protection on `main` must be switched on in GitHub settings by an owner (not done).

## 2. Directory structure

```
apps/        storefront  admin  mobile  api  worker
packages/    contracts  api-client  shared  ui-web  config
database/    migrations  roles  performance  seed
tests/       e2e  load  security  responsive        (API unit/integration tests: apps/api/test)
docs/        architecture  database  api  payments  integrations  deployment  performance
scripts/  .github/workflows/  .env.example  pnpm-workspace.yaml  turbo.json  render.yaml  README.md
```

Not created, to avoid empty structure: `packages/test-utils` (no shared test code yet), `tests/unit` and `tests/integration` (they import API internals and stay in `apps/api/test`), and `docs/responsive-design` (folded into `docs/performance/RESPONSIVE.md`).

## 3. Files

**113 moved, 87 created, 52 modified, 6 deleted.** The full list is in [STAGE2_FILES.md](STAGE2_FILES.md).
- Deleted: the API's in-process timer helper and its test (replaced by the worker).
- Shown as deleted then recreated, because they were rewritten: `apps/web/README.md`, `apps/web/next.config.ts`, `docs/ARCHITECTURE.md`, `docs/DEPLOYMENT.md`.

## 4. Architecture changes

See [architecture/ARCHITECTURE.md](architecture/ARCHITECTURE.md).
- `apps/web` was split into **storefront** and **admin**. They are separate Next.js apps; the admin has a stricter CSP and `noindex`.
- New **worker** process.
- Five shared **packages**, with imports rewritten by name.
- **Turborepo** runs build, typecheck, lint and dev.
- Shared security headers.
- The API is still the only path to data, and the `/api/v1` REST API is unchanged.

## 5. Supabase project and region

- The existing project `sri-anantha-cart` (Frankfurt, eu-central-1, PostgreSQL 17) is **confirmed empty**: no tables, migrations, users, buckets or objects.
- The Free plan allows **2 projects**, so a second project can be created without deleting anything.
- Mumbai (ap-south-1) is offered by the project-creation API.
- **Recommendation:** create the production project in **Mumbai** and pause or delete Frankfurt afterwards. No data would be lost. **Awaiting your approval for both steps.**

## 6. Database

See [database/DATABASE.md](database/DATABASE.md).

New migrations:
- 022: sales summary and indexes.
- 023: jobs, outbox, webhooks, notifications, shipments.
- 024: RLS and roles.
- 025: storage.

021 was amended before any deployment, so it no longer breaks Supabase's own services. All migrations are additive. The requested tables are mapped to the existing schema rather than duplicated.

## 7. Storage

Buckets: `product-images`, `category-images`, `banners`, `public-assets` (public read, WebP, 5 MB) and `private-files` (private). They are created by migration 025 when it runs on Supabase.
- Uploads only go through the API's admin check, using the service-role key held on the server only.
- There are no anon or authenticated storage policies.
- Image paths and metadata are in `media_assets`.
- Three Sharp sizes (1200, 720, 400 px).
- Existing local media move with `apps/api/scripts/migrate-media-to-supabase.mjs`. Tested against a fake Storage server: 93 objects uploaded and verified, 123 references switched in one transaction, rollback restored all 123, and local files were kept. **Not run against Supabase.**

## 8. Security and permission tests

Run with `tests/security/run-supabase-emulation.sh` (also a CI job) on a cluster that reproduces Supabase's roles: non-superuser owner, `anon`, `authenticated`, `service_role`, `authenticator`, and PUBLIC CONNECT.
- **29/29 checks pass:**
  - RLS on all 38 tables;
  - the three API roles cannot read, write, call functions or use sequences;
  - a mistaken grant still returns zero rows;
  - the runtime role can read and write rows but cannot TRUNCATE, DROP, ALTER, CREATE, disable RLS, read migration history, become the owner, create roles or edit the audit log;
  - Supabase service roles can still connect.
- **All 182 API tests pass** with the application connected as the least-privilege runtime role.
- The emulation found a real bug, now fixed: the runtime-role script failed on Supabase, where the owner is not a superuser.

## 9. Performance

See [performance/PERFORMANCE.md](performance/PERFORMANCE.md). Measured on 100k orders and 300k order lines:

| Endpoint | p95 before | p95 after |
| --- | --- | --- |
| Home | 14,457 ms | 71 ms |
| Listings | 8,711 ms | 27 ms |
| Product | 2,539 ms | 32 ms |
| Search | 3,395 ms | 66 ms |

Mobile LCP (throttled 4G):

| Page | Before | After |
| --- | --- | --- |
| Home | 2.85 s | 1.66 s |
| Category | 2.60 s | 2.38 s |
| Product | 3.15 s | 2.63 s (still above the 2.5 s target in this emulation) |
| Cart | 0.84 s | 0.71 s |

Catalogue pages make 0 API calls on repeat views, and admin changes reach the storefront in about 0.9 s. These are local measurements, **not production measurements**.

## 10. Worker

See [architecture/ARCHITECTURE.md](architecture/ARCHITECTURE.md).
- Durable PostgreSQL queue: SKIP LOCKED claims, leases, crash recovery, exponential backoff, dead jobs, attempt history, scheduled dedupe, outbox fan-out exactly once, graceful SIGTERM.
- 11 integration tests cover concurrent claims, lease expiry, retries to dead, outbox and schedule dedupe, and revalidation.
- The API no longer runs timers.

## 11. Responsive testing

See [performance/RESPONSIVE.md](performance/RESPONSIVE.md).
- Storefront: **0 defects in 130 page loads**, previously 13.
- Admin: **0 in 120**, previously 30.
- Android web build: **0 in 35 screens**.
- All at 320, 360, 375, 390, 412, 430, 768, 1024, 1280 and 1440 px, with screenshots reviewed by eye. Real Android device or emulator testing is still needed.

## 12. Build, lint, typecheck and tests (final run)

| Check | Result |
| --- | --- |
| `turbo run lint typecheck` | 18/18 tasks pass. Lint is a TypeScript check; ESLint is not configured. |
| `turbo run build --force` | API, worker, storefront and admin all build, with no network needed for fonts |
| API tests (PostgreSQL 16) | **182/182** |
| API tests as the runtime role, Supabase emulation | **182/182**, plus 29/29 privilege checks |
| Browser E2E (storefront :3000 + admin :3001 + worker) | **7/7** |
| `verify:migrations` and `verify:deployment` | pass |
| Android bundle (`expo export`) | builds |

## 13. Hosting

See [deployment/HOSTING.md](deployment/HOSTING.md). Free tiers that **cannot** carry production:
- A Render free web service sleeps after 15 minutes idle.
- Vercel Hobby forbids commercial use.
- Supabase Free pauses inactive projects and has no downloadable backups.

**Recommended:**

| Service | Plan | Monthly |
| --- | --- | --- |
| API | Render Starter | about $7 |
| Worker | Render Starter | about $7 |
| Storefront and admin | Vercel Pro | about $20 |
| Database and images | Supabase Free, then Pro for backups | $0, then $25 |
| **Total** | | **about $34, then about $59** |

An all-Render alternative costs about $28. Nothing has been purchased.

## 14. Information needed from you

1. **Approval** to create the Supabase project in Mumbai, and later to pause or delete the empty Frankfurt project.
2. **Hosting:** which option (A, B or C) and who pays.
3. **Domain:** name, registrar and DNS access ([deployment/DOMAIN.md](deployment/DOMAIN.md)).
4. **Airtel DLT and SMS Gateway Hub:** PE ID, header, template IDs with their exact texts, and the API document ([integrations/SMS_DLT.md](integrations/SMS_DLT.md)).
5. **Razorpay:** switch the existing account to test mode and generate test keys yourself; tell me which payment methods are enabled ([integrations/RAZORPAY.md](integrations/RAZORPAY.md)).
6. **Shiprocket:** standard or hyperlocal service, pickup location, package defaults, and which orders should use it ([integrations/SHIPROCKET.md](integrations/SHIPROCKET.md)).
7. **GitHub:** turn on branch protection for `main`.

## 15. Risks and blockers

- **Customer sign-in needs SMS.** Launch is blocked until the DLT templates and SMS Gateway Hub details arrive.
- **Online payment needs Razorpay test mode,** then live KYC and activation.
- **The 15–30 minute promise is not something a courier can deliver.** Keep "Deliver Now" on the store's own riders.
- **Supabase Free:** no downloadable backups, 5 GB egress, pauses after 7 inactive days. Plan for Pro around launch.
- **Region:** the existing Supabase project is in Frankfurt. Using it from India would add network delay on every database query.
- **Not yet measured:** production latency, real-device Android layout and real-user web vitals.
- **No ESLint configuration yet.**
- **Razorpay web checkout** is now implemented in source; webhooks, asynchronous reconciliation, gateway refunds, native Android checkout, and full test-mode acceptance remain open.

## 16. Next stage, proposed order

1. On approval: create the Supabase Mumbai project, apply migrations, create the runtime role and buckets, and run the security emulation checks against it (read-only verification queries).
2. Complete Razorpay test-mode acceptance for webhook/reconciliation/refund workflows and retain PayU mentions only in immutable historical migrations and migration notes.
3. SMS Gateway Hub adapter for OTP plus transactional SMS through the worker, using the approved templates.
4. Staging deployment (Render, Vercel, Supabase) on temporary URLs. Measure real latency and LCP, then connect the domain after DNS approval.
5. Shiprocket, once the service type is confirmed and the feature stays disabled until approved.
6. Android device testing (small, standard and large phones, plus a tablet), EAS build, Play Console.
7. ESLint, load test on staging, backup and restore drill, go-live checklist.
