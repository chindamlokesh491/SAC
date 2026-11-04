import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { requireRole } from '../../auth/session.js';
import { deleteUnusedMedia } from '../../media/cleanup.js';
import type { MediaStore } from '../../media/store.js';
import { audit, FEATURED_LIMIT, featuredLimitError, HttpError, likePattern, mediaUrlSchema, parseOrReply, sendHttpError, slugSchema, uuidPattern, uuidSchema, withTransaction } from '../../lib/http.js';

const fields = {
  name: z.string().trim().min(2, 'Enter a category name').max(120),
  slug: slugSchema,
  description: z.string().trim().max(2000).nullable().optional(),
  image_url: mediaUrlSchema.nullable().optional(),
  parent_category_id: uuidSchema.nullable().optional(),
  sort_order: z.number().int().min(0).max(100_000).optional(),
  is_active: z.boolean().optional(),
  is_featured: z.boolean().optional(),
};
const createSchema = z.object(fields).strict();
const updateSchema = z.object(fields).partial().strict().refine(value => Object.keys(value).length > 0, 'Nothing to update');
const columns = 'id, name, slug, description, image_url, parent_category_id, sort_order, is_active, is_featured';

function categoryError(error: unknown): HttpError | null {
  const featured = featuredLimitError(error);
  if (featured) return featured;
  const pgError = error as { code?: string; constraint?: string };
  if (pgError?.code === '23505' && pgError.constraint?.includes('slug')) return new HttpError(409, 'SLUG_TAKEN', 'Another category already uses this URL slug', { fields: { slug: 'Already in use' } });
  return null;
}

/** Only main categories may have children, and a category cannot be its own parent. */
async function checkParent(pool: Pool, parentId: string | null | undefined, selfId?: string) {
  if (!parentId) return;
  if (parentId === selfId) throw new HttpError(400, 'INVALID_CATEGORY_PARENT', 'A category cannot be its own parent');
  const parent = await pool.query<{ parent_category_id: string | null }>('SELECT parent_category_id FROM categories WHERE id = $1', [parentId]);
  if (!parent.rows[0] || parent.rows[0].parent_category_id) throw new HttpError(400, 'INVALID_CATEGORY_PARENT', 'Choose a main category as the parent');
  if (selfId) {
    const children = await pool.query('SELECT 1 FROM categories WHERE parent_category_id = $1 LIMIT 1', [selfId]);
    if (children.rowCount) throw new HttpError(400, 'INVALID_CATEGORY_PARENT', 'A category with subcategories cannot become a subcategory');
  }
}

export async function registerAdminCategoryRoutes(app: FastifyInstance, pool: Pool, options: { media: MediaStore }): Promise<void> {
  app.get<{ Querystring: { search?: string; include_inactive?: string } }>('/api/v1/admin/categories', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['admin', 'operator']);
    if (!user) return;
    const values: unknown[] = [];
    const clauses: string[] = [];
    if (request.query.include_inactive !== 'true') clauses.push('c.is_active = TRUE');
    if (request.query.search?.trim()) { values.push(likePattern(request.query.search)); clauses.push(`c.name ILIKE $${values.length} ESCAPE '\\'`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const [result, featured] = await Promise.all([
      pool.query(
        `SELECT c.id, c.name, c.slug, c.description, c.image_url, c.parent_category_id, c.sort_order, c.is_active, c.is_featured,
                (SELECT COUNT(*)::integer FROM products p WHERE p.category_id = c.id OR p.subcategory_id = c.id) AS product_count,
                (SELECT COUNT(*)::integer FROM categories child WHERE child.parent_category_id = c.id) AS child_count
           FROM categories c ${where} ORDER BY c.sort_order, c.name`, values),
      pool.query<{ count: number }>('SELECT COUNT(*)::integer AS count FROM categories WHERE is_featured'),
    ]);
    return { data: result.rows, featured: { count: Number(featured.rows[0]?.count ?? 0), limit: FEATURED_LIMIT } };
  });

  app.post('/api/v1/admin/categories', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['admin']);
    if (!user) return;
    const body = parseOrReply(createSchema, request.body, reply);
    if (!body) return;
    try {
      await checkParent(pool, body.parent_category_id);
      const created = await withTransaction(pool, async client => {
        const result = await client.query(
          `INSERT INTO categories (name, slug, description, image_url, parent_category_id, sort_order, is_active, is_featured)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${columns}`,
          [body.name, body.slug, body.description ?? null, body.image_url ?? null, body.parent_category_id ?? null, body.sort_order ?? 0, body.is_active ?? true, body.is_featured ?? false]);
        await audit(client, user.id, 'category.created', 'category', result.rows[0].id, { slug: body.slug, parent_category_id: body.parent_category_id ?? null });
        return result.rows[0];
      });
      return reply.code(201).send({ data: created });
    } catch (error) {
      const mapped = error instanceof HttpError ? error : categoryError(error);
      if (mapped) return sendHttpError(reply, mapped);
      throw error;
    }
  });

  app.patch<{ Params: { categoryId: string } }>('/api/v1/admin/categories/:categoryId', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['admin']);
    if (!user) return;
    const { categoryId } = request.params;
    if (!uuidPattern.test(categoryId)) return reply.code(400).send({ error: 'INVALID_CATEGORY_ID', message: 'Invalid category' });
    const body = parseOrReply(updateSchema, request.body, reply);
    if (!body) return;
    const keys = (Object.keys(body) as (keyof typeof body)[]).filter(key => body[key] !== undefined);
    try {
      if (body.parent_category_id !== undefined) await checkParent(pool, body.parent_category_id, categoryId);
      const updated = await withTransaction(pool, async client => {
        const values: unknown[] = [categoryId, ...keys.map(key => body[key])];
        const result = await client.query(
          `UPDATE categories SET ${keys.map((key, index) => `${key} = $${index + 2}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING ${columns}`, values);
        if (!result.rows[0]) throw new HttpError(404, 'CATEGORY_NOT_FOUND', 'Category not found');
        await audit(client, user.id, 'category.updated', 'category', categoryId, { fields: keys });
        return result.rows[0];
      });
      return { data: updated };
    } catch (error) {
      const mapped = error instanceof HttpError ? error : categoryError(error);
      if (mapped) return sendHttpError(reply, mapped);
      throw error;
    }
  });

  /** Deletes a category or subcategory, only when no product (active, hidden or archived) uses it. */
  app.delete<{ Params: { categoryId: string } }>('/api/v1/admin/categories/:categoryId', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['admin']);
    if (!user) return;
    const { categoryId } = request.params;
    if (!uuidPattern.test(categoryId)) return reply.code(400).send({ error: 'INVALID_CATEGORY_ID', message: 'Invalid category' });
    let imageUrl: string | null = null;
    try {
      await withTransaction(pool, async client => {
        const found = await client.query<{ name: string; image_url: string | null }>('SELECT name, image_url FROM categories WHERE id = $1 FOR UPDATE', [categoryId]);
        if (!found.rows[0]) throw new HttpError(404, 'CATEGORY_NOT_FOUND', 'Category not found');
        imageUrl = found.rows[0].image_url;
        // Lock the products that point here so a product cannot be moved in while we delete.
        const products = await client.query('SELECT id FROM products WHERE category_id = $1 OR subcategory_id = $1 FOR UPDATE', [categoryId]);
        if (products.rowCount) throw new HttpError(409, 'CATEGORY_HAS_PRODUCTS', 'Products exists, so it cannot be deleted.', { product_count: products.rowCount });
        const children = await client.query('SELECT 1 FROM categories WHERE parent_category_id = $1 LIMIT 1', [categoryId]);
        if (children.rowCount) throw new HttpError(409, 'CATEGORY_HAS_SUBCATEGORIES', 'This category has subcategories. Delete them first.');
        await client.query('DELETE FROM categories WHERE id = $1', [categoryId]);
        await audit(client, user.id, 'category.deleted', 'category', categoryId, { name: found.rows[0].name });
      });
    } catch (error) {
      if (error instanceof HttpError) return sendHttpError(reply, error);
      throw error;
    }
    await deleteUnusedMedia(pool, options.media, [imageUrl]);
    return reply.code(204).send();
  });
}
