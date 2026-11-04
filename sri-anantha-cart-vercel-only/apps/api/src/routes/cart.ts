import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { requireAuth } from '../auth/session.js';
import { MAX_LINE_QUANTITY } from '../catalog/queries.js';
import { HttpError, parseOrReply, postalCodeSchema, sendHttpError, uuidPattern, uuidSchema, withTransaction } from '../lib/http.js';
import { buildQuote, loadGuestRows, publicQuote } from '../orders/pricing.js';
import { loadSettings } from '../settings/store-settings.js';

const MAX_CART_LINES = 50;
const lineSchema = z.object({
  product_id: uuidSchema,
  variant_id: uuidSchema.nullable().optional(),
  quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY, `You can order up to ${MAX_LINE_QUANTITY} of an item`),
}).strict();

/** Validates product/variant sellability and stock, then writes the line (set or increment). */
async function upsertLine(client: PoolClient, userId: string, input: z.infer<typeof lineSchema>, mode: 'set' | 'add') {
  const product = await client.query<{ visible: boolean; has_variants: boolean; stock: number }>(
    `SELECT (p.is_active AND p.archived_at IS NULL AND (c.id IS NULL OR c.is_active) AND (sub.id IS NULL OR sub.is_active)) AS visible,
            EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.is_active) AS has_variants,
            COALESCE(i.quantity, 0)::integer AS stock
       FROM products p LEFT JOIN categories c ON c.id = p.category_id LEFT JOIN categories sub ON sub.id = p.subcategory_id
       LEFT JOIN inventory i ON i.product_id = p.id
      WHERE p.id = $1 FOR SHARE OF p`, [input.product_id],
  );
  const row = product.rows[0];
  if (!row || !row.visible) throw new HttpError(404, 'PRODUCT_NOT_FOUND', 'This product is unavailable');
  let stock = Number(row.stock);
  const variantId = input.variant_id ?? null;
  if (row.has_variants && !variantId) throw new HttpError(400, 'VARIANT_REQUIRED', 'Choose a size or pack option');
  if (variantId) {
    const variant = await client.query<{ quantity: number }>(
      'SELECT quantity FROM product_variants WHERE id = $1 AND product_id = $2 AND is_active', [variantId, input.product_id],
    );
    if (!variant.rows[0]) throw new HttpError(404, 'VARIANT_NOT_FOUND', 'This option is unavailable');
    stock = Number(variant.rows[0].quantity);
  }
  const cart = await client.query<{ id: string }>(
    `INSERT INTO carts(user_id) VALUES ($1) ON CONFLICT (user_id) DO UPDATE SET updated_at = now() RETURNING id`, [userId],
  );
  const cartId = cart.rows[0]!.id;
  // Serialise concurrent writes to one cart so the line limit and increments are exact.
  await client.query('SELECT id FROM carts WHERE id = $1 FOR UPDATE', [cartId]);
  const existing = await client.query<{ id: string; quantity: number }>(
    `SELECT id, quantity FROM cart_items WHERE cart_id = $1 AND product_id = $2 AND variant_id IS NOT DISTINCT FROM $3`,
    [cartId, input.product_id, variantId],
  );
  const current = existing.rows[0];
  const quantity = mode === 'add' ? (current ? Number(current.quantity) : 0) + input.quantity : input.quantity;
  if (quantity > MAX_LINE_QUANTITY) throw new HttpError(409, 'QUANTITY_LIMIT', `You can order up to ${MAX_LINE_QUANTITY} of an item`);
  if (quantity > stock) throw new HttpError(409, 'INSUFFICIENT_STOCK', stock > 0 ? `Only ${Math.min(stock, MAX_LINE_QUANTITY)} available` : 'This item is out of stock', { available: Math.max(0, Math.min(stock, MAX_LINE_QUANTITY)) });
  if (current) {
    await client.query('UPDATE cart_items SET quantity = $2, updated_at = now() WHERE id = $1', [current.id, quantity]);
  } else {
    const count = await client.query<{ count: number }>('SELECT COUNT(*)::integer AS count FROM cart_items WHERE cart_id = $1', [cartId]);
    if (Number(count.rows[0]?.count ?? 0) >= MAX_CART_LINES) throw new HttpError(409, 'CART_LIMIT', 'Your cart is full');
    await client.query('INSERT INTO cart_items(cart_id, product_id, variant_id, quantity) VALUES ($1, $2, $3, $4)', [cartId, input.product_id, variantId, quantity]);
  }
  return { product_id: input.product_id, variant_id: variantId, quantity };
}

export async function registerCartRoutes(app: FastifyInstance, pool: Pool, deps: { onlinePaymentsAvailable: () => boolean } = { onlinePaymentsAvailable: () => false }): Promise<void> {
  const respondWithCart = async (userId: string, postalCode: string | null) => {
    const settings = await loadSettings(pool);
    return { data: publicQuote(await buildQuote(pool, { userId, settings, postalCode, onlinePaymentsAvailable: deps.onlinePaymentsAvailable() })) };
  };

  app.get<{ Querystring: { address_id?: string } }>('/api/v1/cart', async (request, reply) => {
    const user = await requireAuth(pool, request, reply);
    if (!user) return;
    let postalCode: string | null = null;
    if (request.query.address_id) {
      if (!uuidPattern.test(request.query.address_id)) return reply.code(400).send({ error: 'INVALID_ADDRESS_ID', message: 'Invalid address' });
      const address = await pool.query<{ postal_code: string }>('SELECT postal_code FROM addresses WHERE id = $1 AND user_id = $2', [request.query.address_id, user.id]);
      if (!address.rows[0]) return reply.code(404).send({ error: 'ADDRESS_NOT_FOUND', message: 'Address not found' });
      postalCode = address.rows[0].postal_code;
    }
    return respondWithCart(user.id, postalCode);
  });

  const writeHandler = (mode: 'set' | 'add') => async (request: FastifyRequest, reply: FastifyReply) => {
    const user = await requireAuth(pool, request, reply);
    if (!user) return;
    const body = parseOrReply(lineSchema, request.body, reply);
    if (!body) return;
    try {
      await withTransaction(pool, client => upsertLine(client, user.id, body, mode));
    } catch (error) {
      if (error instanceof HttpError) return sendHttpError(reply, error);
      throw error;
    }
    return respondWithCart(user.id, null);
  };
  const guestItems = z.array(lineSchema).max(MAX_CART_LINES);

  /** Prices a guest's device-stored cart. Read-only and public; prices always come from the database. */
  app.post('/api/v1/cart/preview', {
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const body = parseOrReply(z.object({ items: guestItems, postal_code: postalCodeSchema.optional() }).strict(), request.body, reply);
    if (!body) return;
    const settings = await loadSettings(pool);
    const quote = await buildQuote(pool, { userId: null, rows: await loadGuestRows(pool, body.items), settings, postalCode: body.postal_code ?? null, onlinePaymentsAvailable: deps.onlinePaymentsAvailable() });
    return { data: publicQuote(quote) };
  });

  /**
   * Moves a guest cart into the signed-in customer's cart. For an item already in the cart the larger
   * quantity wins (so signing in twice on one device never doubles it); quantities are capped at stock,
   * and items that are no longer sold are skipped. Each skipped or reduced item is reported back.
   */
  app.post('/api/v1/cart/merge', async (request, reply) => {
    const user = await requireAuth(pool, request, reply);
    if (!user) return;
    const body = parseOrReply(z.object({ items: guestItems }).strict(), request.body, reply);
    if (!body) return;
    const adjusted: { product_id: string; variant_id: string | null; reason: string }[] = [];
    for (const item of body.items) {
      try {
        await withTransaction(pool, async client => {
          const existing = await client.query<{ quantity: number }>(
            `SELECT ci.quantity FROM cart_items ci JOIN carts c ON c.id = ci.cart_id
              WHERE c.user_id = $1 AND ci.product_id = $2 AND ci.variant_id IS NOT DISTINCT FROM $3`, [user.id, item.product_id, item.variant_id ?? null]);
          const quantity = Math.max(Number(existing.rows[0]?.quantity ?? 0), item.quantity);
          try {
            await upsertLine(client, user.id, { ...item, quantity }, 'set');
          } catch (error) {
            const available = error instanceof HttpError && error.code === 'INSUFFICIENT_STOCK' ? Number(error.extra.available ?? 0) : 0;
            if (available <= 0) throw error;
            await upsertLine(client, user.id, { ...item, quantity: available }, 'set');
            adjusted.push({ product_id: item.product_id, variant_id: item.variant_id ?? null, reason: `Only ${available} available` });
          }
        });
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        adjusted.push({ product_id: item.product_id, variant_id: item.variant_id ?? null, reason: error.message });
      }
    }
    return { ...(await respondWithCart(user.id, null)), adjusted };
  });

  app.post('/api/v1/cart/items', writeHandler('add'));
  app.put('/api/v1/cart/items', writeHandler('set'));

  app.delete<{ Params: { itemId: string } }>('/api/v1/cart/items/:itemId', async (request, reply) => {
    const user = await requireAuth(pool, request, reply);
    if (!user) return;
    if (!uuidPattern.test(request.params.itemId)) return reply.code(400).send({ error: 'INVALID_CART_ITEM', message: 'Invalid cart item' });
    // Accept either the cart line id or a product id (removes all lines of that product).
    await pool.query(
      `DELETE FROM cart_items ci USING carts c WHERE ci.cart_id = c.id AND c.user_id = $1 AND (ci.id = $2 OR ci.product_id = $2)`,
      [user.id, request.params.itemId],
    );
    return respondWithCart(user.id, null);
  });

  app.delete('/api/v1/cart', async (request, reply) => {
    const user = await requireAuth(pool, request, reply);
    if (!user) return;
    await pool.query('DELETE FROM cart_items ci USING carts c WHERE ci.cart_id = c.id AND c.user_id = $1', [user.id]);
    return respondWithCart(user.id, null);
  });
}
