# Environment Variable Guide

Secrets are set **only** in Vercel project environment settings, never in the repository. `pnpm verify:deployment` checks the Vercel-only deployment contract and ensures secrets do not appear in `NEXT_PUBLIC_*` or `EXPO_PUBLIC_*` variables.

Legend: **S** = secret (dashboard only) · Staging / Production = recommended value or source.

## API and Cron worker (`apps/api`)

| Variable | S | Purpose | Staging | Production |
| --- | --- | --- | --- | --- |
| `NODE_ENV` | | Runtime mode | `production` | `production` |
| `DEPLOYMENT_ENV` | | Environment identity; **must be set explicitly** | `staging` | `production` |
| `CRON_SECRET` | S | Vercel Cron bearer secret for the protected worker endpoint | generated | generated |
| `TRUST_PROXY` | | Proxy hops for client IPs | `1` | `1` |
| `COOKIE_SECURE` | | Secure session cookie | `true` | `true` |
| `SESSION_SECRET` | S | Session tokens, OTP hashes, delivery-code encryption. Rotating it signs everyone out and voids outstanding codes. | generated | generated |
| `INTERNAL_API_TOKEN` | S | Lets the storefront server bypass per-IP limits for cached catalogue reads | generated | generated |
| `DATABASE_URL` | S | **Runtime role** (`sac_app_runtime`) connection | Supabase pooler URL | client Supabase |
| `MIGRATION_DATABASE_URL` | S | **Owner** connection, used only by a trusted migration run; never exposed to the API runtime | Supabase owner | client Supabase |
| `DATABASE_SSL`, `DATABASE_SSL_CA` | S (CA) | Verified TLS to PostgreSQL | `true` + CA | `true` + CA |
| `DATABASE_POOL_SIZE` | | Per-instance pool; keep small for serverless | 3 | 3–5 after load testing |
| `MEDIA_STORAGE` | | `supabase` in hosted environments | `supabase` | `supabase` |
| `SUPABASE_URL` | | `https://<ref>.supabase.co` | staging ref | client ref |
| `SUPABASE_SERVICE_ROLE_KEY` | S | Storage uploads/deletes (API and worker only) | staging key | client key |
| `PUBLIC_WEB_URL`, `PUBLIC_API_URL` | | Public origins (links, redirects) | staging URLs | live URLs |
| `CHECKOUT_ENABLED` | | Allow orders | `true` for acceptance | `true` at launch |
| `ONLINE_PAYMENTS_ENABLED` | | Show Razorpay at checkout | `false` (or `true` with test keys) | after approval |
| `GOOGLE_CLIENT_IDS` | | Comma-separated OAuth client IDs (web, Android) | staging IDs | client IDs |
| `GEOCODER_URL`, `GEOCODER_CONTACT` | | "Use my location" reverse geocoder and contact email | defaults + email | defaults + email |
| **OTP / SMS** | | | | |
| `OTP_PROVIDER` | | Hosted runtime: `smsgatewayhub` or `http`; `dev-outbox` is local only | configured test provider | `smsgatewayhub` |
| `ALLOW_DEV_OTP` | | Development OTP is not supported as a durable hosted channel | `false` | `false` |
| `OTP_DEV_OUTBOX` | | Local-only file for development OTP codes; do not set on Vercel | — | — |
| `SMSGH_API_KEY` | S | SMS Gateway Hub API key | — | client |
| `SMSGH_SENDER_ID` | S | Approved 6-character DLT header | — | client |
| `SMSGH_ENTITY_ID` | S | DLT Principal Entity ID | — | client |
| `SMSGH_OTP_TEMPLATE_ID` / `_TEXT` | S | Approved sign-in OTP template (exactly one `{#var#}`) | — | client |
| `SMSGH_DELIVERY_TEMPLATE_ID` / `_TEXT` | S | Approved delivery-code template (optional; must differ from sign-in) | — | client |
| `SMSGH_CHANNEL`, `SMSGH_ROUTE` | | `2` (transactional) or `OTP`; route if required by the account | — | per account |
| `OTP_SEND_URL`, `OTP_API_KEY` | S | Generic HTTPS gateway (alternative to SMS Gateway Hub) | — | — |
| **Payments** | | | | |
| `RAZORPAY_MODE` | | `test` or `live` (start with `test`) | `test` | `live` after approval |
| `RAZORPAY_LIVE_APPROVED` | | Must be `true` for live; refused unless `DEPLOYMENT_ENV=production` | `false` | `true` after approval |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | S | Keys (`rzp_test_` in staging) | test keys | live keys |
| `RAZORPAY_API_BASE_URL` | | Official API base | default | default |
| `RAZORPAY_REFUNDS_ENABLED` | | Gateway refunds (otherwise manual) | `false` | after acceptance |
| **Worker** | | | | |
| `STOREFRONT_REVALIDATE_URL`, `REVALIDATE_TOKEN` | S (token) | Cache revalidation after admin changes | staging | live |

| **Local only (refused in production)** | | `DEV_DISABLE_RATE_LIMIT`, `DATABASE_SSL_REJECT_UNAUTHORIZED=false` | — | — |

## Storefront (`apps/storefront`)

| Variable | S | Purpose |
| --- | --- | --- |
| `API_SERVER_ORIGIN` | | API origin used by the same-origin `/api` rewrite and server rendering |
| `INTERNAL_API_TOKEN` | S | Same value as the API |
| `REVALIDATE_TOKEN` | S | Same value as the worker's |
| `NEXT_PUBLIC_SITE_URL` | | Public site URL (SEO, links) |
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | | Web OAuth client ID (public) |
| `NEXT_PUBLIC_ANDROID_APK_URL` | | Optional app download link |
| `MEDIA_PUBLIC_ORIGIN` | | Supabase origin for images (CSP) |

## Admin + delivery-partner PWA (`apps/admin`)

| Variable | S | Purpose |
| --- | --- | --- |
| `API_SERVER_ORIGIN` | | API origin for the same-origin rewrite |
| `NEXT_PUBLIC_STOREFRONT_URL` | | Link back to the store |
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | | Optional staff Google sign-in. When unset, no Google script loads and the CSP blocks Google. |
| `MEDIA_PUBLIC_ORIGIN` | | Supabase origin for images (CSP) |

## Mobile (`apps/mobile`, compiled into the app; never secrets)

`EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_WEB_URL`, `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID`, `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`, `EXPO_PUBLIC_ONLINE_PAYMENTS_IN_APP`, `APP_LINK_HOST`.

## Scripts

| Variable | Used by |
| --- | --- |
| `STAFF_PASSWORD` | `staff:grant` (automation; admin/operator only) |
| `INCLUDE_DEVELOPMENT_SEED` | `migrate` (local only) |
| `ACCEPTANCE_SEED_CONFIRM=yes`, `ACCEPTANCE_SEED_FORCE`, `ACCEPTANCE_CUSTOMER_PHONE` / `_ADMIN_PHONE` / `_PARTNER_PHONE` | `seed:acceptance` (refused when `DEPLOYMENT_ENV=production`) |
| `E2E_*` | Browser tests (see `.github/workflows/ci.yml`) |
