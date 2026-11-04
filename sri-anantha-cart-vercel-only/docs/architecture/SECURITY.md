# Security model

Each control below is covered by an automated test in `apps/api/test` or `e2e/` unless noted.

## Authentication
- Sign-in uses a 6-digit SMS OTP. Codes are stored only as keyed SHA-256 hashes, expire after 5 minutes and are single-use. After 5 wrong attempts the code is dead. Each number gets one code per minute and 5 per hour, and per-IP route limits apply on top. Codes are never returned or logged.
- Google sign-in verifies the ID token signature, audience (`GOOGLE_CLIENT_IDS`), issuer and expiry server-side.
- Web sessions are HttpOnly cookies (`__Host-` prefixed, Secure, SameSite=Lax in production) and are invisible to JavaScript. Cookie-authenticated writes must carry `x-sac-csrf: 1`, which a cross-site form cannot send.
- Logging out revokes the session server-side. Blocking a customer revokes all their sessions and prevents new sign-ins.

## Staff sign-in
- Staff (admin and operator) sign in with mobile number and password. Passwords are stored only as salted scrypt hashes (N=32768, r=8, p=1) and must have 10+ characters, letters and digits, and must not contain the mobile number.
- Wrong passwords, unknown numbers and customer numbers get the same error, and unknown numbers still pay the hashing cost, so the login can't be used to discover staff numbers. Five wrong passwords lock the account for 15 minutes, and per-IP limits apply on top.
- The first admin is created by `staff:grant` from a trusted shell. After that, admins add, reset or remove staff in **Settings → Admin accounts**. Every one of those changes requires the acting admin's own password, is rate-limited and is written to the audit log. New and reset accounts get a one-time random temporary password (about 93 bits), shown once. Until it is changed, the server refuses every admin request except the password change.
- An admin cannot remove themselves or the last remaining admin. Removing staff revokes all their sessions at once.
- Changing the password signs out every other device. Changing the sign-in number requires the current password. Staff numbers are refused by SMS-code and Google sign-in, and the database refuses a password on a customer account.

## Authorisation
- Every protected route checks the session in the API; the UI hides nothing that the API would otherwise allow.
- Every admin route rejects anonymous callers (401) and customers (403). The test enumerates all registered admin routes, so a new unguarded route fails CI.
- Operators can view and fulfil orders. Only admins can change the catalogue, stock, prices, settings, delivery zones, customers, refunds and reports.
- Only an admin who confirms with their password can grant a staff role over HTTP (`/api/v1/admin/staff`). Operators and customers get 403. Customers can never change their own role.
- Customer data (orders, invoices, tracking, addresses, cart, wishlist) is always queried with the caller's user ID. Another customer's order returns the same 404 as a missing one.
- Guests can browse and keep a cart and wishlist in their own browser or phone storage. That storage holds only product IDs and quantities, never prices. The server prices a guest cart from the database (`/cart/preview`) and moves it into the account at sign-in (`/cart/merge`), capping quantities at stock. Checkout always requires sign-in.

## Money
- The client never sends prices. Totals are recomputed on the server, and a mismatch is refused (`409 PRICE_CHANGED`). Unknown body fields are rejected.
- Checkout needs an `Idempotency-Key`, so a retried request returns the same order. Concurrent purchases of the last unit sell it once; stock cannot go negative (database check plus row locks).
- Database constraints enforce `total = subtotal + delivery − discount`, non-negative amounts and stock, and valid status values, even if application code is bypassed.
- Online payments stay disabled until Razorpay test-mode acceptance. Web checkout verifies the HMAC signature against the server-stored order ID and then confirms captured status, order ID, amount, and INR currency with Razorpay before marking an order paid. The browser callback alone is never proof of payment.

## Secrets and data exposure
- Secrets (`SESSION_SECRET`, OTP key, Razorpay key ID and secret, database URL, `INTERNAL_API_TOKEN`) exist only in server environment variables. CI fails if a `.env`, key or keystore file is committed, or if a `NEXT_PUBLIC_*` / `EXPO_PUBLIC_*` variable looks like a secret.
- Public catalogue responses contain no stock thresholds, staff or customer fields. Newsletter sign-up gives the same answer for new and existing emails.
- Logs redact authorisation headers, cookies, tokens, phone numbers and OTP fields. Error responses never include stack traces.

## Database
- Browsers and the Android app only ever talk to the API. The API and worker connect as `sac_app_runtime`, a member of `sac_backend`: row access only, with no DDL, no TRUNCATE, no BYPASSRLS, and a 15 s statement timeout. Migrations use the owner login, only at deploy time.
- Supabase's Data API roles (`anon`, `authenticated`, `service_role`) have **no privileges** on any table, sequence or function (migration 024). Row Level Security is enabled on every table with a single policy for `sac_backend`, so even a mistaken grant returns no rows. CI fails if a new table lacks this.
- Migration 021 keeps PUBLIC's CONNECT on Supabase (Auth, Storage, the Data API and the pooler need it); on plain PostgreSQL it revokes it.
- Triggers keep the audit log append-only and make an order's amounts and line items unchangeable once placed.
- TLS to the database is verified against the provider's CA (`DATABASE_SSL_CA`). Production refuses to start with certificate checks disabled.
- Proof: `tests/security/run-supabase-emulation.sh` runs 29 privilege checks and the whole API suite as the runtime role on a Supabase-like cluster, in CI as well.

## Storage
- Images are uploaded only by the API, after its admin check, using the Supabase service-role key. The key exists only in the API and worker environments; CI fails if it appears in a web or app env file.
- Catalogue buckets are public-read and WebP-only (5 MB). `private-files` is not public. No `storage.objects` policies exist for `anon` or `authenticated`, so they cannot upload, change, delete or list anything.

## Location
- Device location is used only when the customer taps "Use my current location", and the browser or Android asks permission first. Background location is never requested.
- The API rounds coordinates to about 100 m before looking them up, keeps them out of logs, accepts only Indian coordinates and is rate-limited. The detected address is always editable before saving.

## Hardening
- Production refuses to start with a short session secret, insecure cookies, a development OTP outbox, disabled rate limits or a non-HTTPS public URL.
- `TRUST_PROXY=1` trusts exactly the platform load balancer, so spoofed `X-Forwarded-For` prefixes cannot dodge rate limits. The web server's cached catalogue reads use `INTERNAL_API_TOKEN` to avoid sharing one IP budget. The token only exempts GET requests from the rate limit and grants no data access.
- Strict Content-Security-Policy and security headers are set on the web and API. The API serves JSON and images only.
- Uploads are limited to 4 MB (to stay below Vercel's function request-body limit), decoded and re-encoded (SVG, scripts and polyglots are rejected) and served under generated UUID names; path traversal is impossible.
- Malformed IDs return 400 or 404, never 500. SQL is always parameterised.

## Before launch (not automated)
- Database backups with a tested restore, uptime and error alerting, and a dependency audit (`pnpm audit`).
- SMS provider and Razorpay test-mode acceptance with the client's real accounts.
