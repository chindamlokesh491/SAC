# Sri Anantha Cart — Application Flow and Mechanisms

> This document separates repository-verified behaviour from planned features. Planned flows are not claims of completed implementation.

## 1. System architecture

~~~mermaid
flowchart TB
  C[Customer web: Next.js] -->|HTTPS| A[Fastify API]
  M[Customer Android: Expo] -->|HTTPS / bearer| A
  AD[Admin dashboard: Next.js] -->|HTTPS / cookie| A
  A --> DB[(Supabase PostgreSQL)]
  A --> ST[(Supabase Storage)]
  A --> Q[(Durable jobs and outbox tables)]
  W[Background worker] --> Q
  W --> DB
  W --> RP[Razorpay]
  A --> RP
  A --> SMS[Configured SMS provider]
  A --> GEO[Reverse geocoder]
~~~

The monorepo keeps business rules in the API and shared contracts in packages. The storefront uses an HttpOnly cookie session and CSRF header. Mobile uses a bearer session stored in platform secure storage. Admin and customer authorization is enforced by API route guards, not merely by hiding UI controls.

## 2. Customer sign-in and session flow

~~~mermaid
flowchart TD
  S[Open app] --> Q{Existing session?}
  Q -->|Yes| V[API validates session]
  V -->|Valid| HOME[Continue to store]
  V -->|Invalid| L[Login]
  Q -->|No| L
  L --> G[Google Identity Services]
  L --> O[Request SMS OTP]
  G --> GV[API verifies Google ID token]
  O --> OV[API verifies OTP challenge]
  GV --> ROLE{Customer account?}
  OV --> ROLE
  ROLE -->|No / staff| DENY[Reject customer sign-in]
  ROLE -->|Yes| SES[Create server-side session]
  SES --> P{Profile complete?}
  P -->|No| PROF[Prefilled profile setup; allow Skip]
  P -->|Yes| TOUR[Account first-login tutorial]
  PROF --> TOUR
  TOUR --> HOME
~~~

Verified mechanisms:
- OTP challenges are short-lived, single-use, rate-limited and attempt-limited.
- Google ID tokens are verified server-side; unverified email claims are rejected.
- Google identity linking uses the stable Google subject, not an email-only account match.
- Web cookies are HttpOnly, Secure in production and SameSite=Lax.
- Logout revokes the server-side session and clears the cookie.
- Staff cannot authenticate to staff routes using customer SMS OTP.

## 3. First-visit and profile onboarding

Guest tutorial completion is stored per browser. Signed-in tutorial completion is stored separately per customer account, so a guest tutorial does not suppress the first-login tutorial.

The profile page uses verified Google name/email when supplied. Customers can add missing information and continue, or skip and finish later. An email typed by the customer is not treated as verified merely because it was entered in the profile.

## 4. Delivery PIN detection

~~~mermaid
flowchart TD
  A[Store page ready] --> B{Saved PIN?}
  B -->|Yes| D[Display Delivering at PIN]
  B -->|No| C[Request browser geolocation permission]
  C -->|Granted| E[Read coordinates]
  C -->|Denied| F[Show location correction option]
  E --> G[Reverse geocode]
  G --> H{Six-digit PIN returned?}
  H -->|No| F
  H -->|Yes| I[API checks delivery-zone availability]
  I --> J[Persist PIN locally]
  J --> D
~~~

Coordinates are used to derive the PIN code. The customer-facing delivery label displays the PIN, not latitude/longitude or a full address. Delivery eligibility is checked against server-side delivery-zone settings. Browser geolocation requires a secure context and explicit permission.

## 5. Product discovery, search and filters

1. Storefront requests category and product data through the shared API client.
2. Search suggestions are debounced and previous in-flight requests are aborted when the query changes.
3. Suggestions are separated into categories and products.
4. Listing filters are represented in URL query parameters, so refresh and sharing preserve filter state.
5. Catalogue queries enforce active/archived visibility and stock constraints in the API/database.
6. Search ordering and pagination are server-owned; the browser does not decide inventory or availability.

The current search implementation uses PostgreSQL-backed catalogue queries and suggestions. GraphQL is not required to improve ranking. The intended search improvements are query normalization, category relevance, synonym expansion, typo tolerance and product similarity ranking, implemented in the existing API contract.

## 6. Cart and pricing

~~~mermaid
flowchart TD
  A[Add / update cart item] --> B{Signed in?}
  B -->|No| C[Store guest item locally]
  B -->|Yes| D[Write item to customer cart API]
  C --> E[API previews and validates guest cart]
  D --> F[API returns server quote]
  E --> F
  F --> G[Display product count in cart]
  G --> H[Checkout]
  H --> I[API re-reads cart, prices, stock and delivery zone]
  I --> J[Create authoritative quote]
  J --> K[Customer reviews checkout breakdown]
~~~

- Browser storage contains guest cart identifiers and quantities, never trusted prices.
- Guest cart and wishlist are merged after sign-in.
- API recalculates price, stock, GST, discounts, delivery fees and minimum-order eligibility.
- Checkout includes an expected total and idempotency key. API rejects stale totals and duplicate/mismatched attempts.
- Hiding cart prices does not change server-side pricing or payment validation.

## 7. Checkout and payment

~~~mermaid
flowchart TD
  A[Checkout] --> B[Choose saved delivery address]
  B --> C[API builds quote for address PIN]
  C --> D{Delivery and minimum order valid?}
  D -->|No| ERR[Show correction / unavailable state]
  D -->|Yes| E[Choose delivery slot and payment method]
  E --> F{Payment method}
  F -->|COD| G[Create placed order; payment pending]
  F -->|Razorpay| H[Create pending-payment order and Razorpay order]
  H --> I[Open Razorpay Checkout]
  I --> J[Verify signature and fetch captured payment server-side]
  J --> K[Commit inventory and mark paid]
  G --> L[Delivery workflow]
  K --> L
~~~

Razorpay credentials and signature verification are server-side. Test credentials must be used for staging acceptance. Live payments and refunds remain disabled until webhook, reconciliation, refund and inventory-contention acceptance passes.

## 8. COD and invoices

COD orders are valid fulfilment orders while payment is pending. Delivery completion records cash collection and marks payment as paid. Invoice generation is gated so COD invoices cannot be generated before payment status is paid. COD invoice issue time is based on delivery/payment collection time.

## 9. Admin and notifications

- Admin routes check admin or operator role; sensitive actions such as return decisions require admin.
- Admin dashboard notifications are computed from pending orders, return requests, low stock, payment reviews and open refunds.
- Return-request counts already feed the admin notification dropdown.
- Admin order actions validate legal state transitions and payment eligibility on the server.
- Inventory updates, order changes and sensitive admin operations are audited.

## 10. Returns — implemented lifecycle

A customer may request a return within 48 hours of delivery. The API creates a separate `order_returns` record rather than treating admin approval as a completed refund. The order remains in `return_requested` while the physical return is being arranged.

~~~mermaid
stateDiagram-v2
  [*] --> Requested
  Requested --> Accepted: Admin accepts
  Requested --> Rejected: Admin rejects
  Accepted --> PickupScheduled: Admin selects method
  PickupScheduled --> PickedUp: Staff confirms self drop-off
  PickupScheduled --> InTransit: Customer submits courier details
  PickedUp --> Received: Staff confirms item receipt
  InTransit --> Received: Admin confirms courier parcel receipt
  Received --> RefundPending: Refund record created
  RefundPending --> Refunded: Refund fully completed
~~~

Implemented controls:
- Customer submits a reason and can upload up to five photos, maximum 5 MB each.
- Images are decoded and re-encoded to WebP. Evidence is stored in the private `private-files` Supabase Storage bucket (or a non-public local directory in development); no public image URL is created.
- The API returns evidence only after verifying the customer owns the order, or the caller is an active admin/operator. Responses use `private, no-store` cache headers.
- The admin Return Management screen supports review, accept/reject, pickup method/reference, pickup confirmation and received-item confirmation.
- For courier-posted returns, the customer submits carrier, tracking/consignment number and parcel description after courier return is selected; the return moves to in-transit. Staff confirm physical receipt before a refund can be recorded.
- Only an admin can accept or reject. Admins/operators can update the pickup and receipt stages.
- Return evidence count is serialized under a row lock and capped at five.
- A return refund cannot be recorded until staff confirm the item was received. Existing manual and Razorpay refund workflows remain responsible for payment execution and reconciliation.
- Return events are recorded separately for an auditable timeline. The return status advances to refund-pending/refunded as refund records change.

The dedicated delivery-person app, automatic Shiprocket return pickup creation and courier tracking callbacks are not part of this return milestone; those remain in the separate delivery integration workstream.

## 11. Delivery modes — planned extension

~~~mermaid
flowchart TD
  A[Admin selects fulfilment method] --> B{Partner available for PIN?}
  B -->|Yes| C[External partner shipment and tracking]
  B -->|No or admin selects| D[Self delivery]
  D --> E[Assign active delivery crew member]
  E --> F[Assigned crew sees minimum order/customer details]
  F --> G[Picked up]
  G --> H[Out for delivery]
  H --> I[Delivered]
  I --> J{COD?}
  J -->|Yes| K[Record cash collected and reconcile]
  J -->|No| L[Confirm delivery]
~~~

The delivery crew application must use a dedicated role, short-lived sessions and assignment-scoped API access. A driver must not be able to list arbitrary customers, orders, payment records or other drivers' assignments.

## 12. Performance and cache boundaries

- Public catalogue and category data can use bounded server/browser caching.
- Catalogue mutations must invalidate affected cache keys or emit the existing catalogue-changed outbox event.
- Cart, stock, checkout quote, session, payment, order status, customer profile and private media must not be treated as public cache data.
- Image variants are generated as WebP and immutable image URLs are cacheable.
- Durable jobs belong in the jobs/outbox model; serverless functions must not rely on in-memory timers or process-local queues.

## 13. Vercel-only target architecture — planned migration

The production hosting target is Vercel for storefront, admin, Fastify API and bounded Cron-triggered worker functions, with Supabase PostgreSQL and Storage retained. The API project's protected Cron endpoint leases work from the durable jobs table; job retries and idempotency remain in PostgreSQL.

## 14. Key algorithms and invariants

| Area | Mechanism / invariant |
|---|---|
| Authentication | Hashed opaque sessions, OTP challenge hashing, verified Google token claims |
| Authorization | API role checks and customer ownership predicates |
| Cart | Guest-cart merge, server-side quote, inventory checks |
| Checkout | Idempotency key and database transaction/advisory lock |
| Inventory | Reservation, consume, release and restock state transitions |
| Pricing | Paise integer arithmetic, GST and delivery-zone configuration |
| Search | PostgreSQL query/ranking and query-parameter filters |
| Payments | HMAC signature verification, provider fetch, webhook idempotency, reconciliation jobs |
| Notifications | Database-derived counts and durable outbox events |
| Media | Sharp decode/re-encode, size limits, metadata stripping, private/public storage separation |
| Performance | Cache only public catalogue data; invalidate on writes |

## 15. Production acceptance gates

1. Apply and verify all migrations in a dedicated staging database.
2. Pass API integration and security tests.
3. Pass web and Android build checks.
4. Test customer and staff role boundaries.
5. Test OTP rate limits, Google identity linking and session revocation.
6. Test delivery PIN permission denial and unavailable-zone paths.
7. Test cart concurrency, inventory contention and checkout idempotency.
8. Test Razorpay test-mode success, failure, duplicate callbacks, webhooks and reconciliation.
9. Test COD collection and invoice gating.
10. Test return photo privacy, pickup/courier branches and refund reconciliation.
11. Test delivery crew assignment isolation and status updates.
12. Test Vercel function timeouts, database pooling, cron scheduling and job retry behaviour before production traffic is enabled.
