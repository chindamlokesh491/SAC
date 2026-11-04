# Admin API

All routes need a staff session (web cookie + `x-sac-csrf: 1` on writes, or a bearer token). Anonymous callers get 401, customers 403. The role column is enforced by the API and covered by `apps/api/test/api-security.integration.test.ts`.

Staff sign in with `POST /api/v1/auth/staff/login` (`phone`, `password`), change their password with `POST /api/v1/auth/staff/password` (`current_password`, `new_password`) and their sign-in number with `POST /api/v1/auth/staff/phone` (`current_password`, `phone`). While an account still has its temporary password, every route below answers `403 PASSWORD_CHANGE_REQUIRED`.

| Method | Path | Roles |
| --- | --- | --- |
| GET | `/api/v1/admin/categories` | admin + operator |
| POST | `/api/v1/admin/categories` | admin |
| PATCH | `/api/v1/admin/categories/:categoryId` | admin |
| DELETE | `/api/v1/admin/categories/:categoryId` | admin |
| GET | `/api/v1/admin/customers` | admin + operator |
| GET | `/api/v1/admin/customers/:customerId` | admin + operator |
| PATCH | `/api/v1/admin/customers/:customerId/status` | admin |
| GET | `/api/v1/admin/dashboard` | admin + operator |
| GET | `/api/v1/admin/delivery-partners` | admin + operator |
| GET | `/api/v1/admin/orders/:orderId/delivery-assignment` | admin + operator |
| POST | `/api/v1/admin/orders/:orderId/delivery-assignment` | admin + operator |
| GET | `/api/v1/admin/delivery-slots` | admin + operator |
| POST | `/api/v1/admin/delivery-slots` | admin |
| PATCH | `/api/v1/admin/delivery-slots/:slotId` | admin |
| GET | `/api/v1/admin/delivery-zones` | admin + operator |
| POST | `/api/v1/admin/delivery-zones` | admin |
| PATCH | `/api/v1/admin/delivery-zones/:zoneId` | admin |
| GET | `/api/v1/admin/inventory` | admin + operator |
| PATCH | `/api/v1/admin/inventory/:productId/minimum` | admin |
| GET | `/api/v1/admin/inventory/:productId/movements` | admin + operator |
| POST | `/api/v1/admin/inventory/adjustments` | admin |
| POST | `/api/v1/admin/media` | admin |
| GET | `/api/v1/admin/notifications` | admin + operator |
| GET | `/api/v1/admin/orders` | admin + operator |
| GET | `/api/v1/admin/orders/:orderId` | admin + operator |
| POST | `/api/v1/admin/orders/:orderId/cancel` | admin + operator |
| GET | `/api/v1/admin/orders/:orderId/invoice` | admin + operator |
| POST | `/api/v1/admin/orders/:orderId/refunds` | admin |
| PATCH | `/api/v1/admin/orders/:orderId/return-decision` | admin |
| PATCH | `/api/v1/admin/orders/:orderId/status` | admin + operator |
| GET | `/api/v1/admin/payments` | admin + operator |
| GET | `/api/v1/admin/products` | admin + operator |
| POST | `/api/v1/admin/products` | admin |
| DELETE | `/api/v1/admin/products/:productId` | admin |
| GET | `/api/v1/admin/products/:productId` | admin + operator |
| PATCH | `/api/v1/admin/products/:productId` | admin |
| PUT | `/api/v1/admin/products/:productId` | admin |
| POST | `/api/v1/admin/products/:productId/delete-permanently` | admin |
| POST | `/api/v1/admin/products/:productId/restore` | admin |
| GET | `/api/v1/admin/refunds` | admin + operator |
| POST | `/api/v1/admin/refunds/:refundId/execute` | admin |
| POST | `/api/v1/admin/refunds/:refundId/reconcile` | admin |
| PATCH | `/api/v1/admin/refunds/:refundId/status` | admin |
| GET | `/api/v1/admin/reports/summary` | admin |
| GET | `/api/v1/admin/reports/tax` | admin |
| GET | `/api/v1/admin/search` | admin + operator |
| GET | `/api/v1/admin/settings` | admin + operator |
| PUT | `/api/v1/admin/settings/:key` | admin |
| GET | `/api/v1/admin/staff` | admin |
| POST | `/api/v1/admin/staff` | admin |
| POST | `/api/v1/admin/staff/:staffId/remove` | admin |
| POST | `/api/v1/admin/staff/:staffId/reset-password` | admin |

Writes that move money or stock (`refunds`, `inventory/adjustments`, order status, cancel) are transactional and written to the audit log. Refund creation requires an `Idempotency-Key` header. Gateway refund execution and provider reconciliation are not enabled yet. Refund requests remain auditable and require an authorized administrator to reconcile them manually.

**Featured limit.** At most 8 products and 8 categories can be featured. Setting a 9th returns `409 FEATURED_LIMIT`; the database enforces the same cap. Product and category lists include `featured: { count, limit }`.

**Deleting.** `DELETE /products/:id` archives a product, which can be restored. `POST /products/:id/delete-permanently` with `{ "confirm_name": "<exact product name>" }` erases the product, its variants, images, cart and wishlist entries. It is refused while the product is in an open order. Past orders keep their own copy of the name and price. `DELETE /categories/:id` is refused with `409` "Products exists, so it cannot be deleted." while any product uses the category, and while it still has subcategories.

**Staff.** `POST /staff` (`phone`, `role`, optional `name`, `current_password`) returns a one-time `temporary_password`. `reset-password` and `remove` take `current_password`. A wrong password returns `400 WRONG_PASSWORD`. Admins cannot remove themselves or the last admin.


## Manual self-delivery assignment

Self-delivery orders are never assigned automatically. Staff create delivery-partner accounts from Settings → Staff accounts, then use the order detail page to choose a partner. `POST /api/v1/admin/orders/:orderId/delivery-assignment` accepts `{ "delivery_person_id": "<uuid>" }`; a new assignment supersedes the prior active assignment and both events remain in assignment history. Only active `delivery_partner` accounts can be selected. The API rejects assignment for Shiprocket orders, unpaid non-COD orders, and terminal orders. A self-delivery order cannot move to dispatched or delivered until it has an active assignment. All assignment and reassignment actions are audited.
