import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { requireRole } from '../../auth/session.js';
import { thumbOf } from '../../catalog/queries.js';
import { likePattern } from '../../lib/http.js';
import { displayOrderNumber, parseOrderReference } from '../../lib/orders.js';
import { istParts } from '../../orders/pricing.js';

/** "Day" boundaries follow the store's local calendar (Asia/Kolkata). */
const dayStart = (param: string) => `(${param}::date::timestamp AT TIME ZONE 'Asia/Kolkata')`;
const dayEnd = (param: string) => `((${param}::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')`;
const COUNTED = `status NOT IN ('pending_payment')`;

function todayIst(): string {
  const now = istParts(new Date());
  return `${now.y}-${String(now.m + 1).padStart(2, '0')}-${String(now.d).padStart(2, '0')}`;
}

export const lowStockSku = `
  SELECT p.id AS product_id, p.name, NULL::text AS variant_label, p.minimum_stock_level, COALESCE(i.quantity, 0)::integer AS quantity,
         COALESCE((SELECT pi.image_url FROM product_images pi WHERE pi.product_id = p.id ORDER BY pi.sort_order LIMIT 1), p.image_url) AS image_url
    FROM products p LEFT JOIN inventory i ON i.product_id = p.id
   WHERE p.archived_at IS NULL AND p.is_active AND NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.is_active)
  UNION ALL
  SELECT p.id, p.name, v.label, p.minimum_stock_level, v.quantity,
         COALESCE((SELECT pi.image_url FROM product_images pi WHERE pi.product_id = p.id ORDER BY pi.sort_order LIMIT 1), p.image_url)
    FROM products p JOIN product_variants v ON v.product_id = p.id AND v.is_active
   WHERE p.archived_at IS NULL AND p.is_active`;

export async function registerAdminDashboardRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  app.get<{ Querystring: { date?: string } }>('/api/v1/admin/dashboard', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['admin', 'operator']);
    if (!user) return;
    const date = request.query.date ?? todayIst();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) return reply.code(400).send({ error: 'INVALID_DATE', message: 'Use YYYY-MM-DD' });

    const [orders, live, pendingReturns, catalogue, customers, sales7, status30, recent, lowStock] = await Promise.all([
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE created_at >= ${dayStart('$1')} AND created_at < ${dayEnd('$1')})::integer AS orders_today,
           COUNT(*) FILTER (WHERE created_at >= ${dayStart('$1')} - interval '1 day' AND created_at < ${dayStart('$1')})::integer AS orders_yesterday,
           COALESCE(SUM(total_paise) FILTER (WHERE status <> 'cancelled' AND created_at >= ${dayStart('$1')} AND created_at < ${dayEnd('$1')}), 0)::bigint AS sales_today,
           COALESCE(SUM(total_paise) FILTER (WHERE status <> 'cancelled' AND created_at >= ${dayStart('$1')} - interval '1 day' AND created_at < ${dayStart('$1')}), 0)::bigint AS sales_yesterday,
           COUNT(*) FILTER (WHERE delivered_at >= ${dayStart('$1')} AND delivered_at < ${dayEnd('$1')})::integer AS delivered_today,
           COUNT(*) FILTER (WHERE delivered_at >= ${dayStart('$1')} - interval '1 day' AND delivered_at < ${dayStart('$1')})::integer AS delivered_yesterday,
           COUNT(*) FILTER (WHERE status = 'cancelled' AND updated_at >= ${dayStart('$1')} AND updated_at < ${dayEnd('$1')})::integer AS cancelled_today,
           COUNT(*) FILTER (WHERE status = 'cancelled' AND updated_at >= ${dayStart('$1')} - interval '1 day' AND updated_at < ${dayStart('$1')})::integer AS cancelled_yesterday,
           COUNT(*) FILTER (WHERE status = 'cancelled')::integer AS cancelled_total
         FROM orders WHERE ${COUNTED}`, [date]),
      pool.query<{ status: string; count: number }>(`SELECT status, COUNT(*)::integer AS count FROM orders WHERE status IN ('placed','accepted','packed','dispatched','return_requested') GROUP BY status`),
      pool.query<{ count: number }>("SELECT COUNT(*)::integer AS count FROM order_returns WHERE status = 'requested'"),
      pool.query(
        `SELECT COUNT(*) FILTER (WHERE is_active)::integer AS total_products,
                COUNT(*) FILTER (WHERE is_active AND created_at < ${dayStart('$1')})::integer AS products_yesterday
           FROM products WHERE archived_at IS NULL`, [date]),
      pool.query(
        `SELECT COUNT(*)::integer AS total, COUNT(*) FILTER (WHERE created_at < ${dayStart('$1')})::integer AS until_yesterday
           FROM users WHERE role = 'customer' AND created_at < ${dayEnd('$1')}`, [date]),
      pool.query(
        `SELECT d::date AS day,
                COALESCE(SUM(o.total_paise) FILTER (WHERE o.status <> 'cancelled'), 0)::bigint AS sales_paise,
                COUNT(o.id)::integer AS orders
           FROM generate_series($1::date - 6, $1::date, interval '1 day') d
           LEFT JOIN orders o ON o.${COUNTED} AND o.created_at >= (d::timestamp AT TIME ZONE 'Asia/Kolkata') AND o.created_at < ((d + interval '1 day')::timestamp AT TIME ZONE 'Asia/Kolkata')
          GROUP BY d ORDER BY d`, [date]),
      pool.query<{ bucket: string; count: number }>(
        `SELECT CASE WHEN status = 'placed' THEN 'pending' WHEN status = 'dispatched' THEN 'out_for_delivery'
                     WHEN status IN ('delivered','return_requested','refund_initiated','refund_completed','refunded') THEN 'delivered'
                     ELSE status END AS bucket, COUNT(*)::integer AS count
           FROM orders WHERE ${COUNTED} AND created_at >= ${dayEnd('$1')} - interval '30 days' AND created_at < ${dayEnd('$1')}
          GROUP BY 1`, [date]),
      pool.query(
        `SELECT o.id, o.order_number, o.status, o.payment_status, o.payment_method, o.total_paise, o.created_at, u.id AS customer_id,
                COALESCE(u.display_name, o.delivery_address_snapshot->>'recipient_name') AS customer_name,
                (SELECT COALESCE(SUM(quantity), 0)::integer FROM order_items WHERE order_id = o.id) AS item_count
           FROM orders o JOIN users u ON u.id = o.user_id WHERE o.${COUNTED} ORDER BY o.created_at DESC LIMIT 6`),
      pool.query(`SELECT * FROM (${lowStockSku}) s WHERE quantity <= minimum_stock_level ORDER BY quantity ASC, name LIMIT 6`),
    ]);
    const o = orders.rows[0];
    const liveCounts = Object.fromEntries(live.rows.map(row => [row.status, Number(row.count)]));
    const stock = await pool.query(`SELECT COUNT(*) FILTER (WHERE quantity <= 0)::integer AS out_of_stock,
                                           COUNT(*) FILTER (WHERE quantity > 0 AND quantity <= minimum_stock_level)::integer AS low_stock
                                      FROM (${lowStockSku}) s`);
    const metric = (value: number, previous: number | null) => ({ value: Number(value), previous: previous === null ? null : Number(previous) });
    return {
      data: {
        date,
        kpis: {
          total_orders: metric(o.orders_today, o.orders_yesterday),
          pending: metric(liveCounts.placed ?? 0, null),
          accepted: metric(liveCounts.accepted ?? 0, null),
          packed: metric(liveCounts.packed ?? 0, null),
          out_for_delivery: metric(liveCounts.dispatched ?? 0, null),
          delivered_today: metric(o.delivered_today, o.delivered_yesterday),
          sales_paise: metric(o.sales_today, o.sales_yesterday),
          cancelled: metric(o.cancelled_today, o.cancelled_yesterday),
          cancelled_total: Number(o.cancelled_total),
          total_customers: metric(customers.rows[0].total, customers.rows[0].until_yesterday),
          total_products: metric(catalogue.rows[0].total_products, catalogue.rows[0].products_yesterday),
          low_stock: metric(stock.rows[0].low_stock, null),
          out_of_stock: metric(stock.rows[0].out_of_stock, null),
          return_requests: Number(pendingReturns.rows[0]?.count ?? 0),
        },
        sales_7d: sales7.rows.map(row => ({ day: row.day, sales_paise: Number(row.sales_paise), orders: Number(row.orders) })),
        status_30d: ['pending', 'accepted', 'packed', 'out_for_delivery', 'delivered', 'cancelled'].map(bucket => ({
          status: bucket, count: Number(status30.rows.find(row => row.bucket === bucket)?.count ?? 0),
        })),
        recent_orders: recent.rows.map(row => ({ ...row, display_number: displayOrderNumber(row.order_number) })),
        low_stock: lowStock.rows.map(row => ({ ...row, thumb_url: thumbOf(row.image_url) })),
      },
    };
  });

  app.get('/api/v1/admin/notifications', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['admin', 'operator']);
    if (!user) return;
    const result = await pool.query(
      `SELECT (SELECT COUNT(*) FROM orders WHERE status = 'placed')::integer AS pending_orders,
              (SELECT COUNT(*) FROM order_returns WHERE status = 'requested')::integer AS return_requests,
              (SELECT COUNT(*) FROM (${lowStockSku}) s WHERE quantity <= minimum_stock_level)::integer AS low_stock,
              (SELECT COUNT(*) FROM payment_reconciliation_jobs WHERE status = 'needs_review')::integer AS payments_need_review,
              (SELECT COUNT(*) FROM refunds WHERE status IN ('initiated','processing'))::integer AS open_refunds,
              (SELECT COUNT(*) FROM delivery_issues WHERE status IN ('open','admin_review'))::integer AS delivery_issues_open,
              (SELECT COUNT(*) FROM delivery_issues WHERE status = 'reassignment_required')::integer AS delivery_reassignments_required`,
    );
    return { data: result.rows[0] };
  });

  app.get<{ Querystring: { q?: string } }>('/api/v1/admin/search', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['admin', 'operator']);
    if (!user) return;
    const q = (request.query.q ?? '').trim().slice(0, 80);
    if (q.length < 2) return { data: { orders: [], products: [], customers: [] } };
    const pattern = likePattern(q);
    const number = parseOrderReference(q);
    const [ordersResult, products, customers] = await Promise.all([
      pool.query(
        `SELECT o.id, o.order_number, o.status, o.total_paise, COALESCE(u.display_name, o.delivery_address_snapshot->>'recipient_name') AS customer_name
           FROM orders o JOIN users u ON u.id = o.user_id
          WHERE o.status <> 'pending_payment' AND (o.order_number = $2 OR u.phone_e164 ILIKE $1 ESCAPE '\\' OR COALESCE(u.display_name, '') ILIKE $1 ESCAPE '\\')
          ORDER BY o.created_at DESC LIMIT 5`, [pattern, number ?? -1]),
      pool.query(`SELECT id, name, sku FROM products WHERE archived_at IS NULL AND (name ILIKE $1 ESCAPE '\\' OR sku ILIKE $1 ESCAPE '\\') ORDER BY name LIMIT 5`, [pattern]),
      pool.query(`SELECT id, display_name, phone_e164, email FROM users WHERE role = 'customer' AND (phone_e164 ILIKE $1 ESCAPE '\\' OR COALESCE(display_name, '') ILIKE $1 ESCAPE '\\' OR COALESCE(email, '') ILIKE $1 ESCAPE '\\') ORDER BY created_at DESC LIMIT 5`, [pattern]),
    ]);
    return {
      data: {
        orders: ordersResult.rows.map(row => ({ ...row, display_number: displayOrderNumber(row.order_number) })),
        products: products.rows,
        customers: customers.rows,
      },
    };
  });
}
