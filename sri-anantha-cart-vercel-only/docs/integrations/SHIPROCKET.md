# Shiprocket (investigation)

Status: **not integrated and disabled** (`SHIPROCKET_ENABLED` will default to `false`). The client's existing Shiprocket account is reused. No live API call is made without explicit approval: Shiprocket has no sandbox, so a test shipment is a real order that must be cancelled afterwards.

## Today's delivery design

- **Deliver Now (15–30 min):** zones by PIN code, delivered by the store's own staff. The admin moves the order `placed → accepted → packed → dispatched → delivered`.
- **Scheduled slots:** the same manual flow.
- No courier integration, AWB or tracking link exists yet. The tables are ready: `delivery_shipments` and `shipment_events` (migration 023) keep **external shipment status separate from the internal order status**.

## Standard shipping vs hyperlocal

| | Shiprocket standard (courier) | Shiprocket hyperlocal / quick (if enabled on the account) |
| --- | --- | --- |
| Typical speed | Next day to several days | Same day; partner riders, often within hours. 15–30 minutes depends entirely on rider availability. |
| Fits "Deliver Now 15–30 min"? | **No** | Only if the account has it and riders are reliably available in Tirupati. Must be tested. |
| Flow | Create order → assign AWB → pickup → courier tracking | Create order → rider assignment → live tracking |
| Status events | Pickup, in transit, out for delivery, delivered, exception, RTO | Assigned, picked up, delivered, cancelled |
| Charges | Per shipment, by weight and zone | Per trip, by distance |

**Recommendation:** keep "Deliver Now" on the store's own riders, as today. Use Shiprocket only for scheduled or standard orders, or for areas outside the store's own zones, decided per zone or per order. Do not promise 15–30 minutes through a courier.

## Integration design (when approved)

- A dedicated Shiprocket **API user** (Settings → API, an email not used for the panel login). The token is cached about 10 days, refreshed on 401, and never logged.
- An admin-only "Create shipment" action takes the address snapshot, items, weights and the COD/prepaid flag. The API stores the external IDs, AWB, courier, label and tracking URL, and writes an audit log entry.
- Webhook `POST /api/v1/delivery/shiprocket/webhook` is checked with a shared token header. Each event is stored in `webhook_events` before processing and mapped into `shipment_events`. Internal order status only moves forward (`dispatched`, `delivered`). Exceptions and RTO alert staff instead of changing the order silently.
- The worker reconciles shipments whose webhooks were missed by polling tracking.

## Information needed from the client

1. Which services the account has: **standard courier only, or hyperlocal / quick** as well, and for which pickup PIN code.
2. The registered **pickup location name** and address in the panel.
3. Whether COD is enabled on Shiprocket, and the remittance terms.
4. Package defaults: weight per product (products have an optional `weight_grams`), box dimensions, and the default weight when a product has none.
5. Which orders should use Shiprocket: by zone, by order type (scheduled or standard), or chosen by staff per order.
6. Create the API user and put `SHIPROCKET_EMAIL` and `SHIPROCKET_PASSWORD` into the Vercel API project's environment settings. **Never by chat.**
