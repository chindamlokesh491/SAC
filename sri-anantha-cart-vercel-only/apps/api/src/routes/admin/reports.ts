import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import { requireRole } from '../../auth/session.js';
import { likePattern, paging } from '../../lib/http.js';
import { displayOrderNumber, parseOrderReference } from '../../lib/orders.js';

const RANGE_START = `($1::date::timestamp AT TIME ZONE 'Asia/Kolkata')`;
const RANGE_END = `(($2::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')`;
/** Revenue counts orders that were placed and not cancelled (COD included once confirmed). */
const REVENUE_ORDERS = `o.status NOT IN ('pending_payment','cancelled')`;

function readRange(query: { from?: string; to?: string }, reply: FastifyReply): { from: string; to: string } | null {
  const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  const from = query.from ?? new Date(Date.parse(today) - 29 * 86_400_000).toISOString().slice(0, 10);
  const to = query.to ?? today;
  const pattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!pattern.test(from) || !pattern.test(to) || from > to || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
    void reply.code(400).send({ error: 'INVALID_REPORT_RANGE', message: 'Choose a valid date range' });
    return null;
  }
  if (Date.parse(to) - Date.parse(from) > 366 * 86_400_000) {
    void reply.code(400).send({ error: 'REPORT_RANGE_TOO_LARGE', message: 'Reports cover at most one year' });
    return null;
  }
  return { from, to };
}

/** CSV cells are quoted, and formula-leading characters are neutralised for spreadsheet safety. */
function csv(rows: Record<string, unknown>[], columns: string[]): string {
  const cell = (value: unknown) => {
    let text = value === null || value === undefined ? '' : value instanceof Date ? value.toISOString() : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  return [columns.join(','), ...rows.map(row => columns.map(column => cell(row[column])).join(','))].join('\r\n');
}

export async function registerAdminReportRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  app.get<{ Querystring: { from?: string; to?: string; format?: string } }>('/api/v1/admin/reports/summary', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['admin']);
    if (!user) return;
    const range = readRange(request.query, reply);
    if (!range) return;
    const values = [range.from, range.to];
    const [daily, byStatus, byMethod, top, totals] = await Promise.all([
      pool.query(
        `SELECT d::date AS day, COUNT(o.id)::integer AS orders,
                COALESCE(SUM(o.total_paise), 0)::bigint AS revenue_paise, COALESCE(SUM(o.tax_paise), 0)::bigint AS tax_paise,
                COALESCE(SUM(o.delivery_fee_paise), 0)::bigint AS delivery_fee_paise
           FROM generate_series($1::date, $2::date, interval '1 day') d
           LEFT JOIN orders o ON ${REVENUE_ORDERS} AND o.created_at >= (d::timestamp AT TIME ZONE 'Asia/Kolkata') AND o.created_at < ((d + interval '1 day')::timestamp AT TIME ZONE 'Asia/Kolkata')
          GROUP BY d ORDER BY d`, values),
      pool.query(`SELECT o.status, COUNT(*)::integer AS orders FROM orders o WHERE o.status <> 'pending_payment' AND o.created_at >= ${RANGE_START} AND o.created_at < ${RANGE_END} GROUP BY o.status ORDER BY orders DESC`, values),
      pool.query(`SELECT COALESCE(o.payment_method, 'unknown') AS payment_method, COUNT(*)::integer AS orders, COALESCE(SUM(o.total_paise), 0)::bigint AS revenue_paise
                    FROM orders o WHERE ${REVENUE_ORDERS} AND o.created_at >= ${RANGE_START} AND o.created_at < ${RANGE_END} GROUP BY 1 ORDER BY revenue_paise DESC`, values),
      pool.query(`SELECT oi.product_name_snapshot AS name, SUM(oi.quantity)::integer AS units, SUM(oi.line_total_paise)::bigint AS revenue_paise
                    FROM order_items oi JOIN orders o ON o.id = oi.order_id
                   WHERE ${REVENUE_ORDERS} AND o.created_at >= ${RANGE_START} AND o.created_at < ${RANGE_END}
                   GROUP BY oi.product_name_snapshot ORDER BY units DESC, revenue_paise DESC LIMIT 10`, values),
      pool.query(`SELECT COUNT(*)::integer AS orders, COALESCE(SUM(o.total_paise), 0)::bigint AS revenue_paise, COALESCE(SUM(o.tax_paise), 0)::bigint AS tax_paise,
                         COALESCE(AVG(o.total_paise), 0)::bigint AS average_order_paise,
                         (SELECT COALESCE(SUM(r.amount_paise), 0) FROM refunds r WHERE r.status = 'completed' AND r.updated_at >= ${RANGE_START} AND r.updated_at < ${RANGE_END})::bigint AS refunded_paise
                    FROM orders o WHERE ${REVENUE_ORDERS} AND o.created_at >= ${RANGE_START} AND o.created_at < ${RANGE_END}`, values),
    ]);
    if (request.query.format === 'csv') {
      return reply.header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="sales-${range.from}-to-${range.to}.csv"`)
        .send(csv(daily.rows.map(row => ({ ...row, day: String(row.day instanceof Date ? row.day.toISOString().slice(0, 10) : row.day), revenue_rupees: (Number(row.revenue_paise) / 100).toFixed(2), tax_rupees: (Number(row.tax_paise) / 100).toFixed(2) })), ['day', 'orders', 'revenue_rupees', 'tax_rupees']));
    }
    return {
      data: {
        ...range,
        totals: totals.rows[0],
        daily: daily.rows,
        orders_by_status: byStatus.rows,
        payment_methods: byMethod.rows,
        top_products: top.rows,
      },
    };
  });

  app.get<{ Querystring: { from?: string; to?: string } }>('/api/v1/admin/reports/tax', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['admin']);
    if (!user) return;
    const range = readRange(request.query, reply);
    if (!range) return;
    const result = await pool.query(
      `SELECT oi.gst_rate_basis_points, COUNT(DISTINCT o.id)::integer AS orders,
              SUM(oi.line_total_paise)::bigint AS gross_paise, SUM(oi.tax_paise)::bigint AS tax_paise,
              (SUM(oi.line_total_paise) - SUM(oi.tax_paise))::bigint AS taxable_paise
         FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE ${REVENUE_ORDERS} AND o.created_at >= ${RANGE_START} AND o.created_at < ${RANGE_END}
        GROUP BY oi.gst_rate_basis_points ORDER BY oi.gst_rate_basis_points`, [range.from, range.to],
    );
    return { data: { ...range, by_rate: result.rows, total_tax_paise: result.rows.reduce((sum, row) => sum + Number(row.tax_paise), 0) } };
  });

  app.get<{ Querystring: Record<string, string | undefined> }>('/api/v1/admin/payments', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['admin', 'operator']);
    if (!user) return;
    const { limit, offset } = paging(request.query, 20, 100);
    const values: unknown[] = [];
    const where: string[] = [`o.status <> 'pending_payment' OR p.provider = 'razorpay'`];
    if (request.query.status) {
      if (!['created', 'pending', 'succeeded', 'failed', 'cancelled', 'refund_pending', 'refunded'].includes(request.query.status)) return reply.code(400).send({ error: 'INVALID_STATUS', message: 'Unknown payment status' });
      values.push(request.query.status); where.push(`p.status = $${values.length}`);
    }
    if (request.query.method) {
      if (!['upi', 'card', 'net_banking', 'wallet', 'cod'].includes(request.query.method)) return reply.code(400).send({ error: 'INVALID_METHOD', message: 'Unknown payment method' });
      values.push(request.query.method); where.push(`COALESCE(p.payment_method, o.payment_method) = $${values.length}`);
    }
    if (request.query.search?.trim()) {
      const number = parseOrderReference(request.query.search);
      values.push(likePattern(request.query.search));
      const like = `$${values.length}`;
      values.push(number ?? -1);
      where.push(`(o.order_number = $${values.length} OR p.provider_transaction_id ILIKE ${like} ESCAPE '\\' OR p.provider_reference ILIKE ${like} ESCAPE '\\')`);
    }
    const filter = `WHERE ${where.map(clause => `(${clause})`).join(' AND ')}`;
    const listValues = [...values, limit, offset];
    const [rows, total, summary] = await Promise.all([
      pool.query(
        `SELECT p.id, p.order_id, o.order_number, p.provider, COALESCE(p.payment_method, o.payment_method) AS payment_method, p.status, p.amount_paise,
                p.provider_transaction_id, p.provider_reference, p.verified_at, p.refund_amount_paise, p.refund_status, p.created_at,
                COALESCE(u.display_name, o.delivery_address_snapshot->>'recipient_name') AS customer_name
           FROM payments p JOIN orders o ON o.id = p.order_id JOIN users u ON u.id = o.user_id
           ${filter} ORDER BY p.created_at DESC LIMIT $${listValues.length - 1} OFFSET $${listValues.length}`, listValues),
      pool.query<{ total: number }>(`SELECT COUNT(*)::integer AS total FROM payments p JOIN orders o ON o.id = p.order_id ${filter}`, values),
      pool.query(`SELECT COALESCE(SUM(amount_paise) FILTER (WHERE status = 'succeeded'), 0)::bigint AS collected_paise,
                         COALESCE(SUM(amount_paise) FILTER (WHERE status = 'pending' AND provider = 'cod'), 0)::bigint AS cod_due_paise,
                         COUNT(*) FILTER (WHERE status = 'failed')::integer AS failed_count,
                         COALESCE(SUM(refund_amount_paise) FILTER (WHERE status IN ('refund_pending','refunded')), 0)::bigint AS refunds_paise
                    FROM payments`),
    ]);
    return {
      summary: summary.rows[0],
      data: rows.rows.map(row => ({ ...row, display_number: displayOrderNumber(row.order_number) })),
      pagination: { limit, offset, total: Number(total.rows[0]?.total ?? 0) },
      capabilities: { online_payments_configured: Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET), razorpay_refunds_enabled: process.env.RAZORPAY_REFUNDS_ENABLED === 'true' },
    };
  });
}
