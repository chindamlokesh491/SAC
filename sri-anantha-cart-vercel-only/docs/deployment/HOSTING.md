# Hosting architecture

Sri Anantha Cart's production application tier is deployed entirely on Vercel:

- Storefront: Vercel project rooted at `apps/storefront`.
- Admin: Vercel project rooted at `apps/admin`.
- Fastify API and scheduled durable-job runner: Vercel project rooted at `apps/api`.
- PostgreSQL and object storage: existing Supabase Mumbai project.

Use Vercel Pro for commercial production and the per-minute worker Cron schedule. Vercel Hobby Cron is limited to once per day and is not suitable for frequent inventory reservation expiry, payment reconciliation or notification processing.

The API uses Vercel Node.js Functions in `bom1` (Mumbai) and the Supabase transaction pooler. Its per-instance PostgreSQL pool is intentionally small because serverless instances scale horizontally. The background queue remains durable in PostgreSQL; a protected Vercel Cron route claims and processes a bounded batch, using advisory locking, job leases, idempotent handlers and retry/backoff.

No Render service is required. See [DEPLOYMENT.md](DEPLOYMENT.md) for project settings, domains, environment variables, migrations and go-live checks.

Supabase pricing, storage, database size, egress and Vercel usage are provider-plan dependent. Check the current provider dashboards before selecting or upgrading plans.
