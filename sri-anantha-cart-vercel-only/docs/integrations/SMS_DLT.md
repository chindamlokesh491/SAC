# SMS: Airtel DLT and SMS Gateway Hub

Status: **provider adapter implemented; not enabled or live-tested**. No SMS has been sent and no credentials or approved OTP template are configured. The client's existing Airtel DLT entity and SMS Gateway Hub account are reused; no new entity or template is to be registered by us.

## What exists in the code today

| Piece | Where | State |
| --- | --- | --- |
| OTP generation, hashing, expiry (5 min), single use, 5 wrong attempts, 1 code/minute and 5/hour per number, per-IP limits | `apps/api/src/auth/otp-challenges.ts`, `routes/auth.ts` | Done and tested. Codes are never logged or stored in plain text. |
| OTP sender | `apps/api/src/auth/otp-sender.ts` | SMS Gateway Hub SendSMS adapter (`POST` form-urlencoded), generic HTTPS adapter, and development outbox. The API key is sent in the POST body, not the URL. Provider `MessageId` is saved to `otp_challenges.provider_message_id`. Unit tests mock the provider response; no real SMS has been sent. |
| OTP wording | Render environment `SMSGH_OTP_TEMPLATE_TEXT` | The exact approved DLT wording is supplied as configuration. The adapter substitutes exactly one approved `{#var#}`, `{#numeric#}`, or `{#alphanumeric#}` slot with the OTP; it does not rewrite the surrounding text. |
| Transactional SMS (order confirmed, out for delivery, delivered, cancelled, refund) | — | **Not built.** The `notifications` table (migration 023) and the worker queue are ready for it. |
| Delivery reports | — | Not built. `webhook_events` (provider `smsgatewayhub`) is ready to record them. |

## Implemented OTP adapter

- Set `OTP_PROVIDER=smsgatewayhub` only after all required account and DLT values are supplied.
- The adapter calls `https://www.smsgatewayhub.com/api/mt/SendSMS` using HTTPS form POST, with `APIKey`, `senderid`, `channel`, `DCS`, `flashsms`, `number`, `text`, `EntityId`, and `dlttemplateid`; `route` is optional. This follows the provider's [API key documentation](https://www.smsgatewayhub.com/http-api-key).
- The API key stays server-side and is placed in the POST body, not the URL. The request has an 8-second timeout. The adapter treats `ErrorCode=000` plus a returned `MessageId` as success and rejects provider errors.
- OTP remains synchronous because the customer is waiting. Only the provider message ID is stored; the OTP itself is never stored in plain text.
- Default `SMSGH_CHANNEL=2` (transactional/service). Set `OTP` only if the SMS Gateway Hub account manager confirms that channel for this DLT template. `SMSGH_ROUTE` is optional and must be the route ID assigned to the account.

## Still outstanding

- Live transactional SMS for order confirmed, out for delivery, delivered, cancelled, and refund messages is **not built**. The notifications table and worker queue are ready, but the SMS template dispatcher, retry policy and delivery-report processing remain future work.
- Delivery reports/webhooks are **not built**. `webhook_events` (provider `smsgatewayhub`) is ready to record them.

## Information needed from the client (copy exactly from the DLT portal / SMS Gateway Hub; IDs are not secret)

1. **Principal Entity ID** (PE ID) of the registered entity.
2. **Header / Sender ID** (6 characters) approved for transactional or service-implicit messages.
3. For each template: **DLT Template ID**, **template category** (Service Implicit / Transactional), and the **exact approved text** including every `{#var#}`:
   - OTP / sign-in code
   - Order confirmed
   - Out for delivery
   - Delivered
   - Cancelled
   - Refund initiated / completed
4. Whether the templates are linked to the header in the DLT portal (a "content template – header" mapping is required by most operators).
5. Confirm the account's SMS Gateway Hub route ID and whether the account should use `channel=2` or the dedicated `channel=OTP` route. The public SendSMS API format is documented at https://www.smsgatewayhub.com/http-api-key; confirm any account-specific variations and delivery-report webhook settings with SMS Gateway Hub.
6. The API key goes into the Vercel API project's environment settings as `SMSGH_API_KEY`. **Never send it by chat or email.** Also configure `SMSGH_SENDER_ID`, `SMSGH_ENTITY_ID`, `SMSGH_OTP_TEMPLATE_ID`, and the exact `SMSGH_OTP_TEMPLATE_TEXT`. Do not change `OTP_PROVIDER` until all are ready.
7. Consent: confirm that customers agree to transactional SMS at sign-up (privacy policy wording) and whether any promotional SMS is planned. Promotional SMS needs separate templates and a separate consent flow, and is out of scope.

## Risks

- A message that differs from the approved template by even one character is rejected or blocked by the operator. Copy the text exactly.
- A missing template means that message cannot be sent. Plan launch around the templates that are actually approved.
