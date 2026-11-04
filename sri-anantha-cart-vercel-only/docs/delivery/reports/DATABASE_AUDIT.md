# Database Audit — Sri Anantha Cart

Scope: `database/migrations/001`–`037`, roles, RLS and runtime privileges. Date: 2026-11-04.

## 1. Migration inventory and order

`pnpm verify:migrations` passes. It checks:
- 37 contiguous numbered files;
- the development seed (`002`) is isolated;
- no unreviewed `DROP TABLE`;
- every table created after 024 calls `enable_backend_rls`;
- no unguarded `REVOKE ... ON DATABASE`.

| Range | Purpose | Notes |
| --- | --- | --- |
| 001–026 | Core schema, OTP, checkout idempotency, reservations, reconciliation, refunds, search, hardening, catalogue performance, jobs/outbox, access control (RLS), media, Razorpay | On `main` before Phase 1 |
| 027 | Pins `search_path` on application functions | |
| 028 | Return management (returns, evidence, events) | |
| 029 | Shiprocket request safety (ambiguous-state tracking, one shipment per order) | Schema only; no Shiprocket code |
| 030 | `fulfilment_provider`, `order_delivery_verifications` | |
| 031 | `delivery_partner` role, `delivery_assignments`, `order_cod_collections` | Made OTP expiry nullable; 035 and the code now set a 10-minute expiry |
| **032** | Partner portal: partner code + trigger, assignment timestamps, `delivery_assignment_events`, `delivery_issues`, `delivery_notifications_outbox` | Additive, `IF NOT EXISTS`; RLS on 3 new tables |
| **033** | Customer return cancellation (`cancelled` status) | Drop/re-add of status CHECK constraints |
| **034** | `order_return_items` (partial returns, refund snapshots) | Plain `CREATE TABLE`; not idempotent by design (ledger-tracked) |
| **035** | Pins `search_path` on 032 functions; OTP `send_count`/`last_sent_at`; rejection fields; event types | Append-only hardening; 032–034 unchanged |
| **036** | `otp_challenges.provider_message_id` (+ length check) | Ported from the team branch, renumbered 033 → 036; `IF NOT EXISTS` |
| **037** | `admin_audit_resource_idx` for the audit-log viewer | Index only; `IF NOT EXISTS` |

**Collision resolved:** `origin/feat/delivery-partner-portal-main` adds `033_otp_provider_message_reference.sql`, which clashes with the reviewed `033_return_cancellation.sql` that staging expects. On this branch it is **036**. Do not merge that branch's migration file as-is.

## 2. Verification performed

| Check | Result |
| --- | --- |
| Fresh apply in an isolated schema (owner), every API test run | ✅ 196/196 |
| Apply as a **non-superuser owner** on a Supabase-like cluster (`supabase_admin` bootstrap) | ✅ 36 applied (002 seed skipped by design) |
| Upgrade an existing 031-state database to 035, then a second run | ✅ Applied 4, then 0 (2026-11-03). 036 and 037 each applied to an existing database: ✅ 1 applied each. |
| Checksums: `migrate.mjs` hashes LF bytes; `.gitattributes` forces LF | ✅ Recorded checksums equal the expected values in `docs/audit/staging-migration-readonly-check.sql` (027–035). 036: `sha256` of the committed file. |
| `search_path` pinned on 032 functions after 035 | ✅ Tested (`delivery-workflow` test) |
| RLS: anon/authenticated/service_role read, write, function and sequence access | ✅ 29/29 refused as expected (`db-permissions.mjs`) |
| Runtime role (`sac_app_runtime`) can do DML but not TRUNCATE/DROP/ALTER/CREATE/disable RLS/read migration history/modify the audit log | ✅ |

## 3. Constraints, keys and indexes (Phase 1 tables)

| Table | Keys and constraints | Indexes |
| --- | --- | --- |
| `delivery_assignments` | FK order (CASCADE), partner (RESTRICT); status CHECK; **one active assignment per order** (partial unique) | partner+status, order history |
| `delivery_assignment_events` | FKs to assignment, order, partner; event CHECK (035 adds `rejected`, `otp_sent`) | order + time |
| `delivery_issues` | FKs; reason/status CHECKs; `other` requires a description; idempotency unique (assignment, client request) | status + time |
| `order_delivery_verifications` | PK order; `failed_attempts` 0–10; `send_count` 1–20 | pending expiry |
| `order_cod_collections` | **UNIQUE order**; amount > 0; FK assignment and collector | collector + time |
| `order_returns` | **UNIQUE order** (one return per order); status CHECK incl. `cancelled` | |
| `order_return_items` | UNIQUE (return, order item); quantities and amounts ≥ 0; FK order item RESTRICT | return |
| `otp_challenges` | phone E.164 CHECK; attempts 0–5; provider reference ≤ 128 chars | |

Integrity rules enforced in the database, not only in code:
- one active assignment per order;
- one COD collection per order;
- one return per order;
- immutable order amounts and lines (021);
- an append-only audit log (021).

## 4. Findings

| ID | Severity | Finding | Status |
| --- | --- | --- | --- |
| DB-1 | High (ops) | **Staging uses the Supabase migration ledger, but `render.yaml` runs `migrate.mjs`, which expects its own `schema_migrations` table.** A Render deploy against staging would try to re-run 001 and fail. It fails safely, but it blocks the deploy. | **Open, needs approval.** Either seed `schema_migrations` for 001–031 with the expected checksums after a read-only confirmation, or apply 032–037 through the Supabase mechanism and change the pre-deploy step. Never re-run 029–031. |
| DB-2 | Medium | `034` is not idempotent | Accepted: always applied through a ledger |
| DB-3 | Low | 031 left `expires_at` nullable | Accepted: code treats NULL as expired; 035/code always set it |
| DB-4 | Low | No index on `users.display_name`; admin name search ~100 ms at 2,000 customers / 100,000 orders | Accepted at launch scale; add `pg_trgm` index if the customer base grows |
| DB-5 | Info | Historic COD orders delivered before `order_cod_collections` existed have no collection row | A reporting backfill would be a separate, reviewed data migration |

## 5. Rules for future migrations

1. Append-only. Never edit an applied file. Checksums are enforced and LF line endings are forced by `.gitattributes`.
2. Every new table: `SELECT enable_backend_rls('<table>')`. CI enforces this.
3. Every new function: `SET search_path = <schema>, pg_temp` (see 027/035).
4. No grants to `anon`/`authenticated`/`service_role`. Run `test:security` before merging.
5. Apply to staging only through the confirmed ledger (DB-1), after approval.
