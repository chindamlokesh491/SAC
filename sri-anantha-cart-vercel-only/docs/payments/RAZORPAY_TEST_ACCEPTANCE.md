# Razorpay test-mode acceptance

## Safety defaults

- `CHECKOUT_ENABLED=false` and `ONLINE_PAYMENTS_ENABLED=false` remain the deployment defaults.
- Only server-side `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, and `RAZORPAY_WEBHOOK_SECRET` are accepted. Never expose the secret or webhook secret through `NEXT_PUBLIC_*` or `EXPO_PUBLIC_*` variables.
- Use Razorpay test-mode credentials until the client approves a live-mode cutover.
- Android in-app online payments remain disabled until the native Razorpay SDK flow is implemented and tested.
- Gateway refunds remain disabled until the Razorpay refund execution and reconciliation workflow has been implemented and tested. Admin refund records remain auditable and can be manually reconciled by an authorized administrator.

## Web checkout flow

1. The API creates a Razorpay order with the exact server-calculated amount in paise and INR currency.
2. The API stores the Razorpay order ID against the local order before returning checkout details.
3. The storefront opens Razorpay Checkout using the public key ID and stored Razorpay order ID.
4. The browser returns the Razorpay payment ID and signature to the API.
5. The API verifies the HMAC signature using the stored Razorpay order ID, fetches the payment from Razorpay, and requires captured status, matching order ID, amount, and INR currency before marking the local order paid.
6. If verification is unavailable or ambiguous, the order must remain pending; the storefront must not claim payment success.

## Before enabling test checkout

- Apply database migrations through the approved Supabase migration workflow, including `026_razorpay_payments.sql`.
- Configure test credentials only in the API service environment.
- Confirm the storefront CSP permits Razorpay Checkout.
- Run API unit/integration tests and storefront build in CI with the pinned lockfile.
- Exercise successful, failed, dismissed, duplicate, tampered-signature, amount-mismatch, and provider-timeout cases.
- Confirm COD still works when online payments are disabled.

## Not yet included in this acceptance

- Razorpay webhook processing and asynchronous payment reconciliation.
- Razorpay refund execution and provider-side refund reconciliation.
- Native Android Razorpay checkout.
- Live-mode activation.
