# Razorpay integration status

The web checkout creates Razorpay orders server-side, opens Razorpay Checkout, verifies the returned signature against the server-stored order ID, and confirms the payment by fetching the payment from Razorpay. The API also verifies raw-body webhook signatures, handles captured-payment and refund status events, and the worker reconciles uncertain payment sessions. Checkout and online payments remain disabled by default. Only test credentials should be used until acceptance is complete.

## Server-side environment

| Variable | Purpose | Exposure |
| --- | --- | --- |
| `RAZORPAY_KEY_ID` | Public checkout key ID | API environment; returned to the browser for Checkout |
| `RAZORPAY_KEY_SECRET` | Create orders and verify checkout signatures | API only; secret |
| `RAZORPAY_WEBHOOK_SECRET` | Verify future webhook payloads | API only; secret |
| `RAZORPAY_API_BASE_URL` | Defaults to `https://api.razorpay.com/v1` | API environment |
| `ONLINE_PAYMENTS_ENABLED` | Feature gate; defaults false | API environment |
| `RAZORPAY_REFUNDS_ENABLED` | Separate refund feature gate; defaults false | API environment |

Never put a secret in a `NEXT_PUBLIC_*` or `EXPO_PUBLIC_*` variable, source file, GitHub Actions output, or client application.

## Current implemented scope

- API creates INR orders using server-calculated paise amounts and persists the Razorpay order ID.
- Web storefront opens Razorpay Checkout and submits the payment ID/signature to the API.
- API verifies the HMAC-SHA256 signature using the stored order ID, then fetches the payment and requires captured status, matching order ID, exact amount, and INR currency before confirming the order.
- Idempotent checkout retries reuse the original Razorpay order.
- Cash on Delivery remains independent of Razorpay.
- Test credentials and the payment feature flag are required before online checkout can be enabled.

## Not yet complete; do not enable production payments

- Webhook and payment-reconciliation behavior still requires test-mode acceptance, including duplicate delivery, late capture after reservation expiry, provider timeouts, and inventory contention. A local checkout timeout is not treated as proof that a Razorpay order is closed: the worker keeps inventory reserved and marks the payment for operator review rather than releasing stock while the provider order may still accept payment.
- Refund execution and status refresh are implemented behind `RAZORPAY_REFUNDS_ENABLED`; the admin reconciliation route can recover a refund ID by its stable receipt after an uncertain API response. Keep this disabled until partial/full refunds, duplicate requests, uncertain provider responses, and webhook status updates are tested with Razorpay test credentials.
- Native Android Razorpay SDK checkout. Mobile online payment remains disabled.
- End-to-end Razorpay test-mode acceptance and live-mode approval.

## Acceptance checklist

1. Apply migrations in order to the dedicated staging Supabase project, including `026_razorpay_payments.sql`. The migration refuses to proceed if historical PayU payment or reconciliation records remain.
2. Add test-mode keys only to the API environment.
3. Keep `CHECKOUT_ENABLED=false` and `ONLINE_PAYMENTS_ENABLED=false` until API, storefront, and provider acceptance tests pass.
4. Configure the Razorpay webhook URL as `/api/v1/webhooks/razorpay` and subscribe to `payment.captured`, `refund.processed`, and `refund.failed`. Test success, failure, dismissal, duplicate callback, invalid signature, amount mismatch, currency mismatch, and provider timeout cases.
5. Confirm COD checkout independently.
6. Complete test-mode acceptance for webhooks, reconciliation, and refunds; implement and verify native Android checkout before treating the integration as production-ready.
