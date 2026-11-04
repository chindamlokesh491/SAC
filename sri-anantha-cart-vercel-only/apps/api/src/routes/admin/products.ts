import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { requireRole } from '../../auth/session.js';
import { thumbOf } from '../../catalog/queries.js';
import { deleteUnusedMedia } from '../../media/cleanup.js';
import type { MediaStore } from '../../media/store.js';
import { audit, FEATURED_LIMIT, featuredLimitError, HttpError, likePattern, mediaUrlSchema, paging, paiseSchema, parseOrReply, sendHttpError, slugSchema, uuidPattern, uuidSchema, withTransaction } from '../../lib/http.js';

const variantSchema = z.object({
  id: uuidSchema.optional(),
  label: z.string().trim().min(1, 'Enter a variant label').max(40),
  sku: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,64}$/, 'SKU may contain letters, numbers, - and _'),
  price_paise: paiseSchema.refine(value => value > 0, 'Price must be more than zero'),
  mrp_paise: paiseSchema,
  weight_grams: z.number().int().positive().max(100_000).nullable().optional(),
  is_active: z.boolean().default(true),
  initial_quantity: z.number().int().min(0).max(1_000_000).optional(),
}).strict().refine(value => value.mrp_paise >= value.price_paise, { message: 'MRP cannot be lower than the selling price', path: ['mrp_paise'] });

const productFields = {
  name: z.string().trim().min(2, 'Enter the product title').max(160),
  slug: slugSchema,
  sku: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,64}$/, 'SKU may contain letters, numbers, - and _'),
  short_description: z.string().trim().max(120).nullable().optional(),
  description: z.string().trim().min(10, 'Add a description of at least 10 characters').max(4000),
  category_id: uuidSchema,
  subcategory_id: uuidSchema.nullable().optional(),
  price_paise: paiseSchema.refine(value => value > 0, 'Selling price must be more than zero'),
  mrp_paise: paiseSchema,
  gst_rate_basis_points: z.union([z.literal(0), z.literal(500), z.literal(1200), z.literal(1800), z.literal(2800)]),
  hsn_code: z.string().trim().regex(/^[0-9]{4,8}$/, 'HSN code must be 4 to 8 digits').nullable().optional(),
  minimum_stock_level: z.number().int().min(0).max(100_000),
  weight_grams: z.number().int().positive().max(100_000).nullable().optional(),
  highlights: z.array(z.string().trim().min(2).max(30)).max(4).default([]),
  is_active: z.boolean(),
  is_featured: z.boolean().default(false),
  images: z.array(z.object({ url: mediaUrlSchema, alt_text: z.string().trim().max(160).nullable().optional() }).strict()).min(1, 'Add at least one product image').max(8),
  variants: z.array(variantSchema).max(12).default([]),
};
const createSchema = z.object({ ...productFields, initial_quantity: z.number().int().min(0).max(1_000_000).default(0) }).strict()
  .refine(value => value.mrp_paise >= value.price_paise, { message: 'MRP cannot be lower than the selling price', path: ['mrp_paise'] });
const updateSchema = z.object(productFields).strict()
  .refine(value => value.mrp_paise >= value.price_paise, { message: 'MRP cannot be lower than the selling price', path: ['mrp_paise'] });
type ProductInput = z.infer<typeof updateSchema>;

function uniqueViolation(error: unknown): HttpError | null {
  const pgError = error as { code?: string; constraint?: string; detail?: string };
  if (pgError?.code !== '23505') return null;
  const target = `${pgError.constraint ?? ''} ${pgError.detail ?? ''}`;
  if (target.includes('slug')) return new HttpError(409, 'SLUG_TAKEN', 'Another product already uses this URL slug', { fields: { slug: 'Already in use' } });
  if (target.includes('sku')) return new HttpError(409, 'SKU_TAKEN', 'This SKU is already in use', { fields: { sku: 'Already in use' } });
  return new HttpError(409, 'DUPLICATE_VALUE', 'A unique value is already in use');
}

/** Category must be an active top-level category; subcategory must belong to it and is required when it has children. */
async function validateCategories(client: PoolClient, input: ProductInput) {
  const category = await client.query<{ parent_category_id: string | null }>('SELECT parent_category_id FROM categories WHERE id = $1', [input.category_id]);
  if (!category.rows[0] || category.rows[0].parent_category_id) throw new HttpError(400, 'INVALID_CATEGORY', 'Choose a main category', { fields: { category_id: 'Choose a main category' } });
  const children = await client.query<{ id: string }>('SELECT id FROM categories WHERE parent_category_id = $1', [input.category_id]);
  if (input.subcategory_id) {
    if (!children.rows.some(row => row.id === input.subcategory_id)) throw new HttpError(400, 'INVALID_SUBCATEGORY', 'Subcategory does not belong to the selected category', { fields: { subcategory_id: 'Choose a subcategory of the selected category' } });
  } else if (children.rowCount) {
    throw new HttpError(400, 'SUBCATEGORY_REQUIRED', 'Choose a subcategory', { fields: { subcategory_id: 'Choose a subcategory' } });
  }
  const skus = [input.sku, ...input.variants.map(variant => variant.sku)];
  if (new Set(skus).size !== skus.length) throw new HttpError(400, 'DUPLICATE_SKU', 'Product and variant SKUs must all be different', { fields: { variants: 'Duplicate SKU' } });
}

async function writeImages(client: PoolClient, productId: string, images: ProductInput['images'], name: string) {
  await client.query('DELETE FROM product_images WHERE product_id = $1', [productId]);
  for (const [index, image] of images.entries()) {
    await client.query('INSERT INTO product_images (product_id, image_url, alt_text, sort_order) VALUES ($1, $2, $3, $4)', [productId, image.url, image.alt_text || name, index]);
  }
  await client.query('UPDATE products SET image_url = $2 WHERE id = $1', [productId, images[0]!.url]);
}

async function writeVariants(client: PoolClient, productId: string, variants: ProductInput['variants'], actorId: string) {
  const existing = await client.query<{ id: string }>('SELECT id FROM product_variants WHERE product_id = $1', [productId]);
  const existingIds = new Set(existing.rows.map(row => row.id));
  const kept = new Set<string>();
  for (const [index, variant] of variants.entries()) {
    if (variant.id) {
      if (!existingIds.has(variant.id)) throw new HttpError(400, 'INVALID_VARIANT', 'A variant does not belong to this product');
      kept.add(variant.id);
      await client.query(
        `UPDATE product_variants SET label = $2, sku = $3, price_paise = $4, mrp_paise = $5, weight_grams = $6, is_active = $7, sort_order = $8, updated_at = now() WHERE id = $1`,
        [variant.id, variant.label, variant.sku, variant.price_paise, variant.mrp_paise, variant.weight_grams ?? null, variant.is_active, index],
      );
    } else {
      const created = await client.query<{ id: string }>(
        `INSERT INTO product_variants (product_id, label, sku, price_paise, mrp_paise, weight_grams, is_active, sort_order, quantity)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [productId, variant.label, variant.sku, variant.price_paise, variant.mrp_paise, variant.weight_grams ?? null, variant.is_active, index, variant.initial_quantity ?? 0],
      );
      if (variant.initial_quantity) {
        await client.query(`INSERT INTO inventory_movements (product_id, variant_id, quantity_delta, reason, created_by) VALUES ($1, $2, $3, 'initial_stock', $4)`, [productId, created.rows[0]!.id, variant.initial_quantity, actorId]);
      }
    }
  }
  // Removed variants are deactivated, not deleted, so past orders keep their references.
  for (const id of existingIds) {
    if (!kept.has(id)) await client.query('UPDATE product_variants SET is_active = FALSE, updated_at = now() WHERE id = $1', [id]);
  }
}

async function loadAdminProduct(db: Pool | PoolClient, productId: string) {
  const product = await db.query(
    `SELECT p.id, p.name, p.slug, p.sku, p.short_description, p.description, p.category_id, p.subcategory_id, p.price_paise, p.mrp_paise,
            p.gst_rate_basis_points, p.hsn_code, p.minimum_stock_level, p.weight_grams, p.highlights, p.is_active, p.is_featured,
            p.archived_at, p.created_at, p.updated_at, COALESCE(i.quantity, 0)::integer AS quantity
       FROM products p LEFT JOIN inventory i ON i.product_id = p.id WHERE p.id = $1`, [productId],
  );
  if (!product.rows[0]) return null;
  const [images, variants] = await Promise.all([
    db.query('SELECT image_url AS url, alt_text FROM product_images WHERE product_id = $1 ORDER BY sort_order, created_at', [productId]),
    db.query('SELECT id, label, sku, price_paise, mrp_paise, weight_grams, is_active, quantity FROM product_variants WHERE product_id = $1 ORDER BY is_active DESC, sort_order, created_at', [productId]),
  ]);
  return { ...product.rows[0], images: images.rows.map(image => ({ ...image, thumb_url: thumbOf(image.url) })), variants: variants.rows };
}

function handleError(reply: FastifyReply, error: unknown) {
  const featured = featuredLimitError(error);
  if (featured) return sendHttpError(reply, featured);
  const unique = uniqueViolation(error);
  if (unique) return sendHttpError(reply, unique);
  if (error instanceof HttpError) return sendHttpError(reply, error);
  throw error;
}

export async function registerAdminProductRoutes(app: FastifyInstance, pool: Pool, options: { media: MediaStore }): Promise<void> {
  app.get<{ Querystring: { search?: string; category?: string; status?: string; stock?: string; limit?: string; offset?: string } }>('/api/v1/admin/products', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['admin', 'operator']);
    if (!user) return;
    const { limit, offset } = paging(request.query, 20, 100);
    const values: unknown[] = [];
    const where: string[] = [];
    const { search, category, status, stock } = request.query;
    if (search?.trim()) { values.push(likePattern(search)); where.push(`(p.name ILIKE $${values.length} ESCAPE '\\' OR p.sku ILIKE $${values.length} ESCAPE '\\' OR p.slug ILIKE $${values.length} ESCAPE '\\')`); }
    if (category) {
      if (!uuidPattern.test(category)) return reply.code(400).send({ error: 'INVALID_CATEGORY', message: 'Invalid category' });
      values.push(category); where.push(`(p.category_id = $${values.length} OR p.subcategory_id = $${values.length})`);
    }
    if (status === 'active') where.push('p.is_active AND p.archived_at IS NULL');
    else if (status === 'inactive') where.push('NOT p.is_active AND p.archived_at IS NULL');
    else if (status === 'archived') where.push('p.archived_at IS NOT NULL');
    else where.push('p.archived_at IS NULL');
    const stockExpr = `(CASE WHEN EXISTS (SELECT 1 FROM product_variants pv WHERE pv.product_id = p.id AND pv.is_active)
                         THEN (SELECT COALESCE(SUM(pv.quantity), 0) FROM product_variants pv WHERE pv.product_id = p.id AND pv.is_active)
                         ELSE COALESCE(i.quantity, 0) END)`;
    if (stock === 'low') where.push(`${stockExpr} > 0 AND ${stockExpr} <= p.minimum_stock_level`);
    else if (stock === 'out') where.push(`${stockExpr} <= 0`);
    const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const listValues = [...values, limit, offset];
    const [rows, total] = await Promise.all([
      pool.query(
        `SELECT p.id, p.name, p.slug, p.sku, p.price_paise, p.mrp_paise, p.gst_rate_basis_points, p.minimum_stock_level, p.is_active, p.is_featured, p.archived_at,
                COALESCE((SELECT pi.image_url FROM product_images pi WHERE pi.product_id = p.id ORDER BY pi.sort_order LIMIT 1), p.image_url) AS image_url,
                c.name AS category_name, sub.name AS subcategory_name, ${stockExpr}::integer AS stock,
                (SELECT COUNT(*)::integer FROM product_variants pv WHERE pv.product_id = p.id AND pv.is_active) AS variant_count, p.updated_at
           FROM products p LEFT JOIN inventory i ON i.product_id = p.id
           LEFT JOIN categories c ON c.id = p.category_id LEFT JOIN categories sub ON sub.id = p.subcategory_id
           ${filter} ORDER BY p.updated_at DESC, p.name LIMIT $${listValues.length - 1} OFFSET $${listValues.length}`, listValues),
      pool.query<{ total: number }>(`SELECT COUNT(*)::integer AS total FROM products p LEFT JOIN inventory i ON i.product_id = p.id ${filter}`, values),
    ]);
    const featured = await pool.query<{ count: number }>('SELECT COUNT(*)::integer AS count FROM products WHERE is_featured');
    return {
      data: rows.rows.map(row => ({ ...row, thumb_url: thumbOf(row.image_url) })),
      pagination: { limit, offset, total: Number(total.rows[0]?.total ?? 0) },
      featured: { count: Number(featured.rows[0]?.count ?? 0), limit: FEATURED_LIMIT },
    };
  });

  app.get<{ Params: { productId: string } }>('/api/v1/admin/products/:productId', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['admin', 'operator']);
    if (!user) return;
    if (!uuidPattern.test(request.params.productId)) return reply.code(400).send({ error: 'INVALID_PRODUCT_ID', message: 'Invalid product' });
    const product = await loadAdminProduct(pool, request.params.productId);
    if (!product) return reply.code(404).send({ error: 'PRODUCT_NOT_FOUND', message: 'Product not found' });
    return { data: product };
  });

  app.post('/api/v1/admin/products', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['admin']);
    if (!user) return;
    const body = parseOrReply(createSchema, request.body, reply);
    if (!body) return;
    try {
      const product = await withTransaction(pool, async client => {
        await validateCategories(client, body);
        const created = await client.query<{ id: string }>(
          `INSERT INTO products (name, slug, sku, short_description, description, category_id, subcategory_id, price_paise, mrp_paise, gst_rate_basis_points,
                                 hsn_code, minimum_stock_level, weight_grams, highlights, is_active, is_featured)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
          [body.name, body.slug, body.sku, body.short_description ?? null, body.description, body.category_id, body.subcategory_id ?? null, body.price_paise, body.mrp_paise,
            body.gst_rate_basis_points, body.hsn_code ?? null, body.minimum_stock_level, body.weight_grams ?? null, body.highlights, body.is_active, body.is_featured],
        );
        const productId = created.rows[0]!.id;
        await client.query('INSERT INTO inventory (product_id, quantity) VALUES ($1, $2)', [productId, body.variants.length ? 0 : body.initial_quantity]);
        if (!body.variants.length && body.initial_quantity > 0) {
          await client.query(`INSERT INTO inventory_movements (product_id, quantity_delta, reason, created_by) VALUES ($1, $2, 'initial_stock', $3)`, [productId, body.initial_quantity, user.id]);
        }
        await writeImages(client, productId, body.images, body.name);
        await writeVariants(client, productId, body.variants, user.id);
        await audit(client, user.id, 'product.created', 'product', productId, { sku: body.sku, slug: body.slug });
        return loadAdminProduct(client, productId);
      });
      return reply.code(201).send({ data: product });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.put<{ Params: { productId: string } }>('/api/v1/admin/products/:productId', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['admin']);
    if (!user) return;
    if (!uuidPattern.test(request.params.productId)) return reply.code(400).send({ error: 'INVALID_PRODUCT_ID', message: 'Invalid product' });
    const body = parseOrReply(updateSchema, request.body, reply);
    if (!body) return;
    try {
      const product = await withTransaction(pool, async client => {
        const found = await client.query('SELECT id FROM products WHERE id = $1 FOR UPDATE', [request.params.productId]);
        if (!found.rowCount) throw new HttpError(404, 'PRODUCT_NOT_FOUND', 'Product not found');
        await validateCategories(client, body);
        await client.query(
          `UPDATE products SET name = $2, slug = $3, sku = $4, short_description = $5, description = $6, category_id = $7, subcategory_id = $8,
                  price_paise = $9, mrp_paise = $10, gst_rate_basis_points = $11, hsn_code = $12, minimum_stock_level = $13, weight_grams = $14,
                  highlights = $15, is_active = $16, is_featured = $17, updated_at = now()
            WHERE id = $1`,
          [request.params.productId, body.name, body.slug, body.sku, body.short_description ?? null, body.description, body.category_id, body.subcategory_id ?? null,
            body.price_paise, body.mrp_paise, body.gst_rate_basis_points, body.hsn_code ?? null, body.minimum_stock_level, body.weight_grams ?? null,
            body.highlights, body.is_active, body.is_featured],
        );
        await writeImages(client, request.params.productId, body.images, body.name);
        await writeVariants(client, request.params.productId, body.variants, user.id);
        await audit(client, user.id, 'product.updated', 'product', request.params.productId, { sku: body.sku });
        return loadAdminProduct(client, request.params.productId);
      });
      return { data: product };
    } catch (error) {
      return handleError(reply, error);
    }
  });

  /** Quick toggles from the product list (visibility / featured). */
  app.patch<{ Params: { productId: string } }>('/api/v1/admin/products/:productId', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['admin']);
    if (!user) return;
    if (!uuidPattern.test(request.params.productId)) return reply.code(400).send({ error: 'INVALID_PRODUCT_ID', message: 'Invalid product' });
    const body = parseOrReply(z.object({ is_active: z.boolean().optional(), is_featured: z.boolean().optional() }).strict()
      .refine(value => Object.keys(value).length > 0, 'Nothing to update'), request.body, reply);
    if (!body) return;
    let result;
    try {
      result = await pool.query(
        `UPDATE products SET is_active = COALESCE($2, is_active), is_featured = COALESCE($3, is_featured), updated_at = now()
          WHERE id = $1 AND archived_at IS NULL RETURNING id, is_active, is_featured`,
        [request.params.productId, body.is_active ?? null, body.is_featured ?? null],
      );
    } catch (error) {
      return handleError(reply, error);
    }
    if (!result.rows[0]) return reply.code(404).send({ error: 'PRODUCT_NOT_FOUND', message: 'Product not found' });
    await audit(pool, user.id, 'product.toggled', 'product', request.params.productId, body);
    return { data: result.rows[0] };
  });

  /** Archive: hidden everywhere, kept for order history and reports (reversible). */
  app.delete<{ Params: { productId: string } }>('/api/v1/admin/products/:productId', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['admin']);
    if (!user) return;
    if (!uuidPattern.test(request.params.productId)) return reply.code(400).send({ error: 'INVALID_PRODUCT_ID', message: 'Invalid product' });
    const result = await withTransaction(pool, async client => {
      const updated = await client.query(`UPDATE products SET archived_at = now(), is_active = FALSE, is_featured = FALSE, updated_at = now() WHERE id = $1 AND archived_at IS NULL RETURNING id`, [request.params.productId]);
      if (!updated.rowCount) return false;
      await client.query('DELETE FROM cart_items WHERE product_id = $1', [request.params.productId]);
      await audit(client, user.id, 'product.archived', 'product', request.params.productId);
      return true;
    });
    if (!result) return reply.code(404).send({ error: 'PRODUCT_NOT_FOUND', message: 'Product not found' });
    return reply.code(204).send();
  });

  /**
   * Permanent delete: removes the product, its variants, images, stock records, carts and wishlists.
   * Past orders keep their own snapshot (name, price, GST, picture), so invoices stay correct.
   * Refused while the product is in an order that is still open.
   */
  app.post<{ Params: { productId: string } }>('/api/v1/admin/products/:productId/delete-permanently', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['admin']);
    if (!user) return;
    if (!uuidPattern.test(request.params.productId)) return reply.code(400).send({ error: 'INVALID_PRODUCT_ID', message: 'Invalid product' });
    const body = parseOrReply(z.object({ confirm_name: z.string().max(200) }).strict(), request.body, reply);
    if (!body) return;
    let imageUrls: string[] = [];
    try {
      await withTransaction(pool, async client => {
        const found = await client.query<{ name: string; sku: string; image_url: string | null }>('SELECT name, sku, image_url FROM products WHERE id = $1 FOR UPDATE', [request.params.productId]);
        const product = found.rows[0];
        if (!product) throw new HttpError(404, 'PRODUCT_NOT_FOUND', 'Product not found');
        if (body.confirm_name.trim() !== product.name) throw new HttpError(400, 'CONFIRMATION_MISMATCH', 'Type the product name exactly to confirm', { fields: { confirm_name: 'Does not match the product name' } });
        const open = await client.query<{ count: number }>(
          `SELECT COUNT(DISTINCT o.id)::integer AS count FROM order_items oi JOIN orders o ON o.id = oi.order_id
            WHERE oi.product_id = $1 AND o.status IN ('pending_payment','placed','accepted','packed','dispatched','return_requested','refund_initiated')`,
          [request.params.productId]);
        const openOrders = Number(open.rows[0]?.count ?? 0);
        if (openOrders > 0) throw new HttpError(409, 'PRODUCT_IN_OPEN_ORDERS', `This product is in ${openOrders} open order${openOrders === 1 ? '' : 's'}. Deliver or cancel ${openOrders === 1 ? 'it' : 'them'} first, or archive the product instead.`);
        const images = await client.query<{ image_url: string }>('SELECT image_url FROM product_images WHERE product_id = $1', [request.params.productId]);
        imageUrls = [...images.rows.map(row => row.image_url), ...(product.image_url ? [product.image_url] : [])];
        await client.query('DELETE FROM order_inventory_reservations WHERE product_id = $1', [request.params.productId]);
        await client.query('DELETE FROM inventory_movements WHERE product_id = $1', [request.params.productId]);
        await client.query('DELETE FROM cart_items WHERE product_id = $1', [request.params.productId]);
        await client.query('DELETE FROM products WHERE id = $1', [request.params.productId]);
        await audit(client, user.id, 'product.deleted_permanently', 'product', request.params.productId, { name: product.name, sku: product.sku });
      });
    } catch (error) {
      if (error instanceof HttpError) return sendHttpError(reply, error);
      throw error;
    }
    const imagesRemoved = await deleteUnusedMedia(pool, options.media, imageUrls);
    return { data: { id: request.params.productId, deleted: true, images_removed: imagesRemoved } };
  });

  app.post<{ Params: { productId: string } }>('/api/v1/admin/products/:productId/restore', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['admin']);
    if (!user) return;
    if (!uuidPattern.test(request.params.productId)) return reply.code(400).send({ error: 'INVALID_PRODUCT_ID', message: 'Invalid product' });
    const result = await pool.query(`UPDATE products SET archived_at = NULL, updated_at = now() WHERE id = $1 AND archived_at IS NOT NULL RETURNING id`, [request.params.productId]);
    if (!result.rowCount) return reply.code(404).send({ error: 'PRODUCT_NOT_FOUND', message: 'Archived product not found' });
    await audit(pool, user.id, 'product.restored', 'product', request.params.productId);
    return { data: { id: request.params.productId, archived: false, is_active: false } };
  });
}
