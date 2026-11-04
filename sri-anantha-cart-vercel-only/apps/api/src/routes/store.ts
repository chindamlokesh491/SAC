import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { requireAuth } from '../auth/session.js';
import { queryCards } from '../catalog/queries.js';
import { parseOrReply, uuidPattern, uuidSchema } from '../lib/http.js';
import { loadSettings, publicSettings } from '../settings/store-settings.js';

export async function registerStoreRoutes(app: FastifyInstance, pool: Pool, deps: { onlinePaymentsAvailable: () => boolean }): Promise<void> {
  app.get('/api/v1/store/config', async (_request, reply) => {
    void reply.header('cache-control', 'public, max-age=60');
    return { data: publicSettings(await loadSettings(pool), deps.onlinePaymentsAvailable()) };
  });

  app.get('/api/v1/wishlist', async (request, reply) => {
    const user = await requireAuth(pool, request, reply);
    if (!user) return;
    const items = await queryCards(pool, 'p.id IN (SELECT product_id FROM wishlist_items WHERE user_id = $1)', [user.id], 'p.name ASC', 200);
    const ids = await pool.query<{ product_id: string }>('SELECT product_id FROM wishlist_items WHERE user_id = $1', [user.id]);
    return { data: { items, product_ids: ids.rows.map(row => row.product_id) } };
  });

  /** Adds a guest's device-stored wishlist to the signed-in customer's wishlist. Unknown or hidden products are ignored. */
  app.post('/api/v1/wishlist/merge', async (request, reply) => {
    const user = await requireAuth(pool, request, reply);
    if (!user) return;
    const body = parseOrReply(z.object({ product_ids: z.array(uuidSchema).max(200) }).strict(), request.body, reply);
    if (!body) return;
    await pool.query(
      `INSERT INTO wishlist_items(user_id, product_id)
       SELECT $1, id FROM products WHERE id = ANY($2::uuid[]) AND is_active AND archived_at IS NULL
       ON CONFLICT DO NOTHING`, [user.id, body.product_ids]);
    const ids = await pool.query<{ product_id: string }>('SELECT product_id FROM wishlist_items WHERE user_id = $1', [user.id]);
    return { data: { product_ids: ids.rows.map(row => row.product_id) } };
  });

  /** Product cards for a guest's wishlist (public catalogue data only). */
  app.post('/api/v1/products/by-ids', {
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const body = parseOrReply(z.object({ ids: z.array(uuidSchema).max(200) }).strict(), request.body, reply);
    if (!body) return;
    if (!body.ids.length) return { data: [] };
    return { data: await queryCards(pool, 'p.id = ANY($1::uuid[])', [body.ids], 'p.name ASC', 200) };
  });

  app.put<{ Params: { productId: string } }>('/api/v1/wishlist/:productId', async (request, reply) => {
    const user = await requireAuth(pool, request, reply);
    if (!user) return;
    if (!uuidPattern.test(request.params.productId)) return reply.code(400).send({ error: 'INVALID_PRODUCT_ID', message: 'Invalid product' });
    const result = await pool.query(
      `INSERT INTO wishlist_items(user_id, product_id)
       SELECT $1, id FROM products WHERE id = $2 AND is_active AND archived_at IS NULL
       ON CONFLICT DO NOTHING RETURNING product_id`, [user.id, request.params.productId],
    );
    if (!result.rowCount) {
      const exists = await pool.query('SELECT 1 FROM wishlist_items WHERE user_id = $1 AND product_id = $2', [user.id, request.params.productId]);
      if (!exists.rowCount) return reply.code(404).send({ error: 'PRODUCT_NOT_FOUND', message: 'This product is unavailable' });
    }
    return reply.code(204).send();
  });

  app.delete<{ Params: { productId: string } }>('/api/v1/wishlist/:productId', async (request, reply) => {
    const user = await requireAuth(pool, request, reply);
    if (!user) return;
    if (!uuidPattern.test(request.params.productId)) return reply.code(400).send({ error: 'INVALID_PRODUCT_ID', message: 'Invalid product' });
    await pool.query('DELETE FROM wishlist_items WHERE user_id = $1 AND product_id = $2', [user.id, request.params.productId]);
    return reply.code(204).send();
  });
}
