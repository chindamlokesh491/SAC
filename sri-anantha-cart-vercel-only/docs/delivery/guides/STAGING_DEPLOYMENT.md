# Staging Deployment Guide

Target: Vercel (storefront, admin, Fastify API and Cron worker) + Supabase PostgreSQL/Storage.
**Only use staging project credentials and test payment keys. Never deploy staging settings to production.**

## Staging rules

| Rule | How it is enforced |
|---|---|
| Razorpay test mode only | API refuses unsafe live configuration |
| Gateway refunds disabled | `RAZORPAY_REFUNDS_ENABLED=false` |
| Real SMS provider required for hosted staging | The local `dev-outbox` writes to ephemeral function storage and is not a hosted OTP solution |
| COD for acceptance | `CHECKOUT_ENABLED=true`, `ONLINE_PAYMENTS_ENABLED=false` initially |
| Secrets only in Vercel settings | CI deployment contract checks secret hygiene |

## Steps

1. **CI green.** Push the reviewed branch and wait for dependency audit, typecheck, build, API, database-security and E2E checks.
2. **Database.** Follow `DATABASE_MIGRATIONS.md`. Inspect the Supabase migration ledger before applying anything. Never re-run migrations already recorded by Supabase.
3. **Vercel projects.** Create three projects using `docs/deployment/DEPLOYMENT.md`: storefront (`apps/storefront`), admin (`apps/admin`) and API (`apps/api`). Enable Include files outside the Root Directory.
4. **API environment.** Configure the staging Supabase runtime pooler URL, verified TLS CA, session secret, CRON_SECRET, internal token, Supabase Storage credentials and staging public origins. Set `DEPLOYMENT_ENV=staging`, `NODE_ENV=production`, `COOKIE_SECURE=true`, `TRUST_PROXY=1`, `MEDIA_STORAGE=supabase`.
5. **OTP.** Use an approved staging HTTP/SMS OTP provider. Do not use file-based `dev-outbox` on Vercel because function files are ephemeral and not a durable OTP channel.
6. **Checkout.** Enable COD only for acceptance (`CHECKOUT_ENABLED=true`, `ONLINE_PAYMENTS_ENABLED=false`). Razorpay stays in test mode until its full test acceptance passes.
7. **Web apps.** Configure `API_SERVER_ORIGIN` to the staging API origin, site URLs, Supabase public media origin, internal token and revalidation token. Configure Google OAuth staging origins if needed.
8. **Cron.** Use a plan that supports the per-minute schedule. Confirm the API project's Cron Jobs page lists `/api/internal/worker` and logs show authenticated successful invocations.
9. **Health checks.**
   - `GET /health` → `{"status":"ok","service":"sri-anantha-cart-api"}`
   - `GET /ready` → `{"status":"ready"}`
   - Storefront home page loads catalogue images.
   - `/admin/login` and `/partner/login` load.
10. **Demo data.** Only seed a staging database after confirming it is empty. Record temporary staff credentials securely and change them at first login.
11. **Smoke test.** Run `CLIENT_ACCEPTANCE_TESTING.md` and the payment/worker acceptance scenarios.

## Logs and rollback

Use Vercel Function logs for API and Cron diagnostics. Check that redacted fields never appear: authorization, cookies, passwords, OTP codes, tokens and phone numbers. For rollback, redeploy the previous successful Vercel deployment; database migrations remain forward-only and backward-compatible.
