# Database Migration Guide

## Rules

1. Migrations are append-only, numbered `NNN_name.sql` in `database/migrations/`. Never edit a migration that has been applied anywhere.
2. Every new table calls `SELECT enable_backend_rls('<table>')`, and every new function sets `search_path = <schema>, pg_temp`.
3. `pnpm verify:migrations` must pass (CI runs it).
4. Line endings are LF (`.gitattributes`), because checksums are taken over the raw bytes.
5. Never run migrations against production without a reviewed release and a backup.

## Two ledgers: know which one your database uses

| Environment | Ledger | How to apply |
| --- | --- | --- |
| Local, CI, fresh databases | `public.schema_migrations(migration_name, checksum_sha256, applied_at)`, written by `apps/api/scripts/migrate.mjs` | `DATABASE_URL=<owner url> pnpm --filter @sac/api migrate` |
| **Staging (Supabase `gtafzzkiyitfzadqusad`)** | **Supabase migration history** (`supabase_migrations.schema_migrations`). It also contains `027_create_runtime_login`, which is not a file here and must be preserved. | Supabase migration mechanism, **or** reconcile first (below) |

`render.yaml` runs `migrate.mjs` before each API deploy (`preDeployCommand`). Against staging as it is today, that step would try to re-run 001 and fail. It fails safely, but it blocks the deploy. Resolve this before the first Render deploy.

## Staging procedure (requires approval)

1. **Read-only check:** run `docs/audit/staging-migration-readonly-check.sql`. It is SELECT-only; each section runs in a READ ONLY transaction. Confirm:
   - the 029–031 schema fingerprints are present;
   - 032–037 are absent;
   - what the Supabase ledger contains.
2. **Choose a ledger.**
   - **Option A (keep Render pre-deploy):** in one reviewed transaction, create `public.schema_migrations` and insert rows for `001`–`031` with the checksums `sha256sum database/migrations/0*.sql` gives for the committed LF files. The runner then applies only 032–037.
   - **Option B (Supabase mechanism):** apply 032–037 in order via Supabase. Change Render's `preDeployCommand` so it no longer runs `migrate.mjs` for staging.
3. **Never re-run 029–031.** 031 resets delivery-code expiries.
4. Apply **032 → 033 → 034 → 035 → 036 → 037** in order.
5. Verify:
   - re-run the read-only check;
   - every table has RLS;
   - the 032 functions have a pinned `search_path` (035);
   - Supabase security and performance advisors are clean;
   - API `/ready` reports `ready`.

## Phase 1 migrations

| # | Change | Safe on a live database? |
| --- | --- | --- |
| 032 | Partner portal schema (partner code + trigger; assignment timestamps; events, issues, notifications outbox) | Additive, `IF NOT EXISTS`; backfills partner codes |
| 033 | Return cancellation status | Drops and re-adds two CHECK constraints (brief lock) |
| 034 | `order_return_items` | New table (not idempotent; apply once via the ledger) |
| 035 | `search_path` on 032 functions; OTP send tracking; rejection fields; event types | Additive; replaces one CHECK constraint |
| 036 | `otp_challenges.provider_message_id` | Additive, `IF NOT EXISTS` |
| 037 | Audit-log resource index | Index only (brief lock on `admin_audit_logs`) |

## Deploy order

Apply migrations **before** deploying the API that needs them. The API's `/ready` check refuses traffic until the 032 schema exists.

## Verifying a migration change locally

```bash
pnpm verify:migrations
TEST_DATABASE_URL=... pnpm test:api                 # applies every migration to a fresh isolated schema
EMUL_HOST=localhost EMUL_PORT=5434 pnpm test:security   # non-superuser apply + privilege checks + runtime-role API suite
```

To test an upgrade, migrate a copy of a database at the previous version, run `migrate` twice, and confirm the second run applies nothing.
