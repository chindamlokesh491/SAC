# Client Acceptance Testing Guide

For the client's team testing the staging site. Each scenario lists what to do and what you should see. If something differs, note the scenario number, the step and a screenshot.

**Staging is a test environment.**
- Payments are Cash on Delivery only (online payment stays off, or uses Razorpay *test* mode).
- No real money moves and no real refunds are made.
- SMS is not sent yet: sign-in codes are provided by the project team until the SMS templates are approved.

## Demo accounts

The project team creates these with `seed:acceptance` and shares the details privately.

| Role | Sign in at | How |
| --- | --- | --- |
| Customer | Store website → Sign in | Mobile number + 6-digit code (from the project team) |
| Store admin | `<admin site>/admin/login` | Mobile number + temporary password. You must choose a new password at first sign-in. |
| Delivery partner | `<admin site>/partner` (on a phone) | Mobile number + 6-digit code |

The demo data already contains orders in each state:
- SA10001: placed
- SA10002: packed and assigned to the partner
- SA10003: delivered
- SA10004: cancelled
- SA10005: return requested
- SA10006: return received, refund recorded

Numbers may differ if staging already had orders. The script prints the actual list.

## Scenario 1: order to doorstep (main workflow)

| # | Who | Do | Expected |
| --- | --- | --- | --- |
| 1 | Customer | Browse a category; use filters (price, In stock, On sale); search "diya" | Results and filter counts update |
| 2 | Customer | Open a product, choose a variant if shown, Add to Cart (twice) | Cart shows item price, quantity, subtotal, discount, GST and delivery charge |
| 3 | Customer | Checkout → choose address (or "use my location") → Cash on Delivery → Place order | Order number shown (e.g. SA100xx); order appears under My Orders as "Placed" |
| 4 | Admin | Orders → open the new order → Accept → Mark as Packed | Status updates; timeline records each step |
| 5 | Admin | "Self-delivery assignment" → choose the demo partner → Assign | "Assigned" shown. The order page says it is waiting for the delivery partner (no dispatch/deliver buttons). |
| 6 | Partner (phone) | Sign in at `/partner` → New tab → open the order → Accept order | Moves to In progress |
| 7 | Partner | "Picked up, start delivery" | Customer's order shows "Out for delivery" |
| 8 | Customer | Open the order | **"Your delivery code"** with a 6-digit code and a 10-minute countdown |
| 9 | Partner | Enter a wrong code | "The delivery code is incorrect", attempts left shown |
| 10 | Partner | Enter the customer's code | "Collect cash" screen with the exact amount due |
| 11 | Partner | Enter a different amount, then the exact amount → "Cash collected" | Wrong amount refused; exact amount completes delivery |
| 12 | Customer | Refresh the order | "Delivered"; the code is gone; invoice available |
| 13 | Admin | Audit Log → search the order number | Every step with who did it and when |

## Scenario 2: delivery exceptions

| # | Do | Expected |
| --- | --- | --- |
| 1 | Partner: on a new assignment, "I cannot take this order" → choose a reason | Order returns to the store; admin can assign another partner |
| 2 | Partner: after pickup, "Report a delivery problem" | Admin sees the issue (dashboard notification, delivery issues) |
| 3 | Admin: try to reassign after pickup | Refused ("already with a delivery partner") |
| 4 | Admin: mark the reported issue as "reassignment required", then reassign | Allowed. The new partner picks up again and the customer gets a new code. |
| 5 | Customer: let the code expire (10 minutes) → "Get a new code" | New code shown; the old one no longer works |

## Scenario 3: cancellation

| # | Do | Expected |
| --- | --- | --- |
| 1 | Admin: open a placed, accepted or packed order → Cancel with a reason | Status "Cancelled"; stock restored (Inventory) |
| 2 | Admin: try to cancel after dispatch | Not allowed |

## Scenario 4: return and refund

| # | Do | Expected |
| --- | --- | --- |
| 1 | Customer: on a delivered order (within 48 hours) → Request return → choose items and quantities, reason, photos | Return "Requested"; photos visible to the customer and admins only |
| 2 | Customer: cancel the return before pickup (optional) | Return "Cancelled"; it cannot be reopened |
| 3 | Admin: Returns → approve (or reject with a reason) | Customer sees the decision |
| 4 | Admin: schedule drop-off/pickup → picked up → received | Timeline updates; refund becomes available only after "received" |
| 5 | Admin: Record refund (amount up to the returned items' value; full return up to the order total) | Refund "initiated" (manual in staging) |
| 6 | Admin: Payments & Refunds → mark refund completed (or failed, then record again) | Customer sees the refund status; a failed refund can be retried; nothing can be refunded twice |

## Scenario 5: inventory, admin and permissions

| # | Do | Expected |
| --- | --- | --- |
| 1 | Admin: Products → edit price/stock; Categories; Delivery Settings (zones, fees, minimum order, slots) | Changes appear on the store |
| 2 | Customer: order below the zone minimum | Checkout explains the minimum |
| 3 | Admin: Settings → add a staff member and a delivery partner | Staff get a temporary password; partners sign in with an SMS code |
| 4 | Partner: try to open `/admin` | Not allowed |
| 5 | Customer: try another customer's order URL | Not found |

## Scenario 6: phones and tablets

Repeat scenario 1 steps 1–3 on a phone (store) and steps 6–11 on a phone (partner). Check:
- no sideways scrolling;
- buttons are easy to tap;
- filters open as a panel;
- the admin dashboard is usable on a tablet.

## Reporting

For each issue, record:
- scenario and step;
- account role;
- device and browser;
- what you expected and what happened;
- a screenshot;
- the time (for log lookup).
