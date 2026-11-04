import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { requireRole } from '../../auth/session.js';
import { parseOrReply } from '../../lib/http.js';
import { displayOrderNumber, parseOrderReference } from '../../lib/orders.js';

const query = z.object({
  /** Exact action, or a prefix ending in '.' or '*': "order.", "delivery*", "refund.recorded". */
  action: z.string().trim().regex(/^[a-z_]+(\.[a-z_]*)*\*?$/).max(60).optional(),
  resource_type: z.string().trim().regex(/^[a-z_]{2,40}$/).optional(),
  /** Order reference (SA10001), UUID or other resource identifier. */
  resource: z.string().trim().max(80).optional(),
  actor: z.string().trim().regex(/^\+?\d{4,15}$/).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
}).strict();

/**
 * Read-only view of the append-only audit trail (migration 021 forbids updates and deletes).
 * Admins only: entries include staff actions, refunds and delivery events.
 */
export async function registerAdminAuditRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  app.get('/api/v1/admin/audit-logs', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['admin']);
    if (!user) return;
    const q = parseOrReply(query, request.query, reply);
    if (!q) return;
    const values: unknown[] = [];
    const where: string[] = [];
    if (q.action) {
      if (q.action.endsWith('.') || q.action.endsWith('*')) { values.push(`${q.action.replace(/\*$/, '')}%`); where.push(`l.action LIKE $${values.length}`); }
      else { values.push(q.action); where.push(`l.action = $${values.length}`); }
    }
    if (q.resource_type) { values.push(q.resource_type); where.push(`l.resource_type = $${values.length}`); }
    if (q.resource) {
      // An order reference is stored as the order's UUID; resolve it so staff can search by what they see.
      const orderNumber = /^\s*(#|SA)/i.test(q.resource) ? parseOrderReference(q.resource) : null;
      const resourceId = orderNumber
        ? (await pool.query<{ id: string }>('SELECT id::text AS id FROM orders WHERE order_number = $1', [orderNumber])).rows[0]?.id ?? '00000000-0000-0000-0000-000000000000'
        : q.resource;
      values.push(resourceId); where.push(`l.resource_id = $${values.length}`);
    }
    if (q.actor) {
      const digits = q.actor.replace(/\D/g, '').slice(-10);
      values.push(`%${digits}`); where.push(`a.phone_e164 LIKE $${values.length}`);
    }
    if (q.from) { values.push(q.from); where.push(`l.created_at >= ($${values.length}::date::timestamp AT TIME ZONE 'Asia/Kolkata')`); }
    if (q.to) { values.push(q.to); where.push(`l.created_at < (($${values.length}::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')`); }
    const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows, total] = await Promise.all([
      pool.query(
        `SELECT l.id, l.action, l.resource_type, l.resource_id, l.metadata, l.created_at,
                a.id AS actor_id, a.role AS actor_role, a.phone_e164 AS actor_phone, a.display_name AS actor_name,
                o.order_number
           FROM admin_audit_logs l
           LEFT JOIN users a ON a.id = l.actor_user_id
           LEFT JOIN orders o ON l.resource_type = 'order' AND o.id::text = l.resource_id
           ${filter}
          ORDER BY l.created_at DESC, l.id DESC
          LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, q.limit, q.offset]),
      pool.query<{ total: number }>(`SELECT COUNT(*)::integer AS total FROM admin_audit_logs l LEFT JOIN users a ON a.id = l.actor_user_id ${filter}`, values),
    ]);
    return {
      data: rows.rows.map(row => ({
        id: row.id, action: row.action, resource_type: row.resource_type, resource_id: row.resource_id, metadata: row.metadata, created_at: row.created_at,
        actor: row.actor_id ? { id: row.actor_id, role: row.actor_role, phone: row.actor_phone, name: row.actor_name } : null,
        order_display_number: row.order_number ? displayOrderNumber(row.order_number) : null,
      })),
      pagination: { limit: q.limit, offset: q.offset, total: Number(total.rows[0]?.total ?? 0) },
    };
  });
}
