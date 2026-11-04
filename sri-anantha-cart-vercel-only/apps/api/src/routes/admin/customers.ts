import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { requireRole } from '../../auth/session.js';
import { audit } from '../../lib/http.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function registerAdminCustomerRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  // Customer search and account blocking. Blocking revokes all existing sessions.
  app.get<{ Querystring: { search?: string; limit?: string; offset?: string } }>('/api/v1/admin/customers', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['admin', 'operator']);
    if (!user) return;
    const limit = Math.min(Math.max(Number.parseInt(request.query.limit ?? '25', 10) || 25, 1), 100);
    const offset = Math.max(Number.parseInt(request.query.offset ?? '0', 10) || 0, 0);
    const search = request.query.search?.trim().slice(0, 100);
    const values: unknown[] = [];
    let where = "WHERE u.role = 'customer'";
    if (search) { values.push(`%${search.replace(/[\\%_]/g, '\\$&')}%`); where += ` AND (u.phone_e164 ILIKE $1 ESCAPE '\\' OR COALESCE(u.display_name, '') ILIKE $1 ESCAPE '\\' OR COALESCE(u.email, '') ILIKE $1 ESCAPE '\\')`; }
    values.push(limit, offset);
    const result = await pool.query(
      // Page the customers first, then aggregate orders for that page only (an index lookup per customer
      // on orders_user_created_idx) instead of grouping every order before LIMIT.
      `SELECT u.id, u.phone_e164, u.display_name, u.email, u.is_active, u.blocked_at, u.created_at,
              stats.order_count, stats.total_spent_paise, stats.last_order_at
         FROM (SELECT u.* FROM users u ${where} ORDER BY u.created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}) u
         CROSS JOIN LATERAL (
           SELECT COUNT(*) FILTER (WHERE o.status <> 'pending_payment')::integer AS order_count,
                  COALESCE(SUM(o.total_paise) FILTER (WHERE o.payment_status = 'paid'), 0)::bigint AS total_spent_paise,
                  MAX(o.created_at) AS last_order_at
             FROM orders o WHERE o.user_id = u.id
         ) stats
        ORDER BY u.created_at DESC`, values,
    );
    return { data: result.rows, pagination: { limit, offset } };
  });

  app.patch<{ Params: { customerId: string }; Body: { blocked: boolean; reason?: string } }>('/api/v1/admin/customers/:customerId/status', async (request, reply) => {
    const actor = await requireRole(pool, request, reply, ['admin']);
    if (!actor) return;
    const { customerId } = request.params; const body = request.body;
    if (!uuid.test(customerId) || !body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !['blocked', 'reason'].includes(key)) || typeof body.blocked !== 'boolean' || (body.reason !== undefined && (typeof body.reason !== 'string' || body.reason.trim().length > 300))) return reply.code(400).send({ error: 'INVALID_CUSTOMER_STATUS' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query<{ id: string; role: string }>('SELECT id, role FROM users WHERE id = $1 FOR UPDATE', [customerId]);
      if (!found.rows[0] || found.rows[0].role !== 'customer') { await client.query('ROLLBACK'); return reply.code(404).send({ error: 'CUSTOMER_NOT_FOUND' }); }
      const active = !body.blocked;
      await client.query('UPDATE users SET is_active = $2, blocked_at = CASE WHEN $2 THEN NULL ELSE now() END, updated_at = now() WHERE id = $1', [customerId, active]);
      if (body.blocked) await client.query('UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [customerId]);
      await client.query('INSERT INTO customer_account_events (customer_id, actor_user_id, action, reason) VALUES ($1,$2,$3,$4)', [customerId, actor.id, body.blocked ? 'blocked' : 'unblocked', body.reason?.trim() || null]);
      await audit(client, actor.id, body.blocked ? 'customer.blocked' : 'customer.unblocked', 'customer', customerId, { reason: body.reason?.trim() || null });
      await client.query('COMMIT'); return { data: { id: customerId, is_active: active, blocked: body.blocked } };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  });



  app.get<{ Params: { customerId: string } }>('/api/v1/admin/customers/:customerId', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['admin', 'operator']);
    if (!user) return;
    if (!uuid.test(request.params.customerId)) return reply.code(400).send({ error: 'INVALID_CUSTOMER_ID', message: 'Invalid customer' });
    const customer = await pool.query(
      `SELECT id, phone_e164, display_name, email, email_verified, google_sub IS NOT NULL AS google_linked, is_active, blocked_at, created_at
         FROM users WHERE id = $1 AND role = 'customer'`, [request.params.customerId],
    );
    if (!customer.rows[0]) return reply.code(404).send({ error: 'CUSTOMER_NOT_FOUND', message: 'Customer not found' });
    const [addresses, orders, events] = await Promise.all([
      pool.query(`SELECT id, label, recipient_name, phone_e164, line1, line2, locality, city, state, postal_code, is_default FROM addresses WHERE user_id = $1 ORDER BY is_default DESC, created_at DESC`, [request.params.customerId]),
      pool.query(
        `SELECT id, order_number, 'SA' || (10000 + order_number) AS display_number, status, payment_status, payment_method, total_paise, created_at
           FROM orders WHERE user_id = $1 AND status <> 'pending_payment' ORDER BY created_at DESC LIMIT 100`, [request.params.customerId]),
      pool.query(`SELECT action, reason, created_at FROM customer_account_events WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 20`, [request.params.customerId]),
    ]);
    return { data: { ...customer.rows[0], addresses: addresses.rows, orders: orders.rows, account_events: events.rows } };
  });
}
