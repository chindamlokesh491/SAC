import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { requireRole } from '../../auth/session.js';
import { thumbOf } from '../../catalog/queries.js';
import { audit, HttpError, likePattern, paging, parseOrReply, sendHttpError, uuidPattern, uuidSchema, withTransaction } from '../../lib/http.js';

/**
 * One row per stock-keeping unit: simple products, or each active variant of a product
 * that has variants.
 */
const skuRows = `
  SELECT p.id AS product_id, NULL::uuid AS variant_id, p.name, NULL::text AS variant_label, p.sku, p.minimum_stock_level, p.is_active,
         COALESCE(i.quantity, 0)::integer AS quantity, i.updated_at,
         COALESCE((SELECT pi.image_url FROM product_images pi WHERE pi.product_id = p.id ORDER BY pi.sort_order LIMIT 1), p.image_url) AS image_url,
         c.name AS category_name
    FROM products p LEFT JOIN inventory i ON i.product_id = p.id LEFT JOIN categories c ON c.id = p.category_id
   WHERE p.archived_at IS NULL AND NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.is_active)
  UNION ALL
  SELECT p.id, v.id, p.name, v.label, v.sku, p.minimum_stock_level, (p.is_active AND v.is_active), v.quantity, v.updated_at,
         COALESCE((SELECT pi.image_url FROM product_images pi WHERE pi.product_id = p.id ORDER BY pi.sort_order LIMIT 1), p.image_url),
         c.name
    FROM products p JOIN product_variants v ON v.product_id = p.id AND v.is_active LEFT JOIN categories c ON c.id = p.category_id
   WHERE p.archived_at IS NULL`;

const adjustmentSchema = z.object({
  product_id: uuidSchema,
  variant_id: uuidSchema.nullable().optional(),
  quantity_delta: z.number().int().refine(value => value !== 0, 'Enter a non-zero quantity').refine(value => Math.abs(value) <= 100_000, 'Quantity is too large'),
  reason: z.enum(['stock_in', 'damaged', 'lost', 'expired', 'correction', 'returned']),
  note: z.string().trim().max(200).optional(),
}).strict();

export async function registerAdminInventoryRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  app.get<{ Querystring: { search?: string; stock?: string; limit?: string; offset?: string } }>('/api/v1/admin/inventory', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['admin', 'operator']);
    if (!user) return;
    const { limit, offset } = paging(request.query, 25, 100);
    const values: unknown[] = [];
    const where: string[] = [];
    if (request.query.search?.trim()) { values.push(likePattern(request.query.search)); where.push(`(name ILIKE $${values.length} ESCAPE '\\' OR sku ILIKE $${values.length} ESCAPE '\\')`); }
    if (request.query.stock === 'low') where.push('quantity > 0 AND quantity <= minimum_stock_level');
    else if (request.query.stock === 'out') where.push('quantity <= 0');
    else if (request.query.stock === 'in') where.push('quantity > 0');
    const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const listValues = [...values, limit, offset];
    const [summary, rows, total] = await Promise.all([
      pool.query(`SELECT COUNT(*)::integer AS total_skus,
                         COUNT(*) FILTER (WHERE quantity > 0)::integer AS in_stock,
                         COUNT(*) FILTER (WHERE quantity > 0 AND quantity <= minimum_stock_level)::integer AS low_stock,
                         COUNT(*) FILTER (WHERE quantity <= 0)::integer AS out_of_stock,
                         COALESCE(SUM(GREATEST(quantity, 0)), 0)::integer AS total_units
                    FROM (${skuRows}) s`),
      pool.query(`SELECT * FROM (${skuRows}) s ${filter}
                  ORDER BY (quantity <= minimum_stock_level) DESC, quantity ASC, name LIMIT $${listValues.length - 1} OFFSET $${listValues.length}`, listValues),
      pool.query<{ total: number }>(`SELECT COUNT(*)::integer AS total FROM (${skuRows}) s ${filter}`, values),
    ]);
    return {
      summary: summary.rows[0],
      data: rows.rows.map(row => ({
        ...row, thumb_url: thumbOf(row.image_url),
        stock_status: row.quantity <= 0 ? 'out_of_stock' : row.quantity <= row.minimum_stock_level ? 'low_stock' : 'in_stock',
      })),
      pagination: { limit, offset, total: Number(total.rows[0]?.total ?? 0) },
    };
  });

  app.get<{ Params: { productId: string } }>('/api/v1/admin/inventory/:productId/movements', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['admin', 'operator']);
    if (!user) return;
    if (!uuidPattern.test(request.params.productId)) return reply.code(400).send({ error: 'INVALID_PRODUCT_ID', message: 'Invalid product' });
    const result = await pool.query(
      `SELECT m.id, m.variant_id, v.label AS variant_label, m.quantity_delta, m.reason, m.reference_id, m.created_at,
              COALESCE(u.display_name, u.phone_e164) AS actor
         FROM inventory_movements m LEFT JOIN product_variants v ON v.id = m.variant_id LEFT JOIN users u ON u.id = m.created_by
        WHERE m.product_id = $1 ORDER BY m.created_at DESC LIMIT 100`, [request.params.productId],
    );
    return { data: result.rows };
  });

  /** Manual stock-in (received goods) or stock-out (damaged/lost) with a recorded reason. */
  app.post('/api/v1/admin/inventory/adjustments', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['admin']);
    if (!user) return;
    const body = parseOrReply(adjustmentSchema, request.body, reply);
    if (!body) return;
    if (body.reason === 'stock_in' && body.quantity_delta < 0) return reply.code(400).send({ error: 'INVALID_INVENTORY_ADJUSTMENT', message: 'Stock-in must add units' });
    if (['damaged', 'lost', 'expired'].includes(body.reason) && body.quantity_delta > 0) return reply.code(400).send({ error: 'INVALID_INVENTORY_ADJUSTMENT', message: 'Damaged, lost or expired stock must remove units' });
    try {
      const result = await withTransaction(pool, async client => {
        const current = body.variant_id
          ? await client.query<{ quantity: number }>('SELECT quantity FROM product_variants WHERE id = $1 AND product_id = $2 FOR UPDATE', [body.variant_id, body.product_id])
          : await client.query<{ quantity: number }>('SELECT quantity FROM inventory WHERE product_id = $1 FOR UPDATE', [body.product_id]);
        if (!current.rows[0]) throw new HttpError(404, 'INVENTORY_NOT_FOUND', 'Stock record not found');
        const next = Number(current.rows[0].quantity) + body.quantity_delta;
        if (next < 0) throw new HttpError(409, 'INSUFFICIENT_STOCK', `Only ${current.rows[0].quantity} units are in stock`);
        if (body.variant_id) await client.query('UPDATE product_variants SET quantity = $2, updated_at = now() WHERE id = $1', [body.variant_id, next]);
        else await client.query('UPDATE inventory SET quantity = $2, updated_at = now() WHERE product_id = $1', [body.product_id, next]);
        const reason = body.note ? `${body.reason}: ${body.note}` : body.reason;
        await client.query(
          `INSERT INTO inventory_movements (product_id, variant_id, quantity_delta, reason, created_by) VALUES ($1, $2, $3, $4, $5)`,
          [body.product_id, body.variant_id ?? null, body.quantity_delta, reason, user.id],
        );
        await audit(client, user.id, 'inventory.adjusted', 'product', body.product_id, { variant_id: body.variant_id ?? null, delta: body.quantity_delta, resulting_quantity: next, reason });
        return { product_id: body.product_id, variant_id: body.variant_id ?? null, quantity: next };
      });
      return { data: result };
    } catch (error) {
      if (error instanceof HttpError) return sendHttpError(reply, error);
      throw error;
    }
  });

  app.patch<{ Params: { productId: string } }>('/api/v1/admin/inventory/:productId/minimum', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['admin']);
    if (!user) return;
    if (!uuidPattern.test(request.params.productId)) return reply.code(400).send({ error: 'INVALID_PRODUCT_ID', message: 'Invalid product' });
    const body = parseOrReply(z.object({ minimum_stock_level: z.number().int().min(0).max(100_000) }).strict(), request.body, reply);
    if (!body) return;
    const result = await pool.query('UPDATE products SET minimum_stock_level = $2, updated_at = now() WHERE id = $1 RETURNING id, minimum_stock_level', [request.params.productId, body.minimum_stock_level]);
    if (!result.rowCount) return reply.code(404).send({ error: 'PRODUCT_NOT_FOUND', message: 'Product not found' });
    await audit(pool, user.id, 'inventory.minimum_changed', 'product', request.params.productId, body);
    return { data: result.rows[0] };
  });
}
