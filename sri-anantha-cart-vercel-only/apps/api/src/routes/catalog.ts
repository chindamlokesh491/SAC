import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { MAX_LINE_QUANTITY, productCardSelect, productVisibleWhere, queryCardRows, queryCards, thumbOf, toCard, type ProductCard } from '../catalog/queries.js';
import { afterCursor, cursorFor, InvalidCursorError, sortOrder, type ListSort } from '../catalog/cursor.js';
import { likePattern, paging, parseOrReply } from '../lib/http.js';
import { exactMatch, relevanceOrder, searchTerms, similarProducts } from '../catalog/search.js';

/** Fisher-Yates shuffle of a small in-memory list (never ORDER BY random() over a table). */
function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  category: z.string().regex(/^[a-z0-9-]{1,120}$/).optional(),
  min_price: z.coerce.number().int().min(0).max(99_999_999).optional(),
  max_price: z.coerce.number().int().min(0).max(99_999_999).optional(),
  sort: z.enum(['relevance', 'popular', 'newest', 'price_asc', 'price_desc', 'name_asc']).optional(),
  featured: z.enum(['true', 'false']).optional(),
  in_stock: z.enum(['true', 'false']).optional(),
  discount_only: z.enum(['true', 'false']).optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
  // Keyset pagination: pass pagination.next_cursor from the previous page. Not available for search relevance.
  cursor: z.string().max(600).regex(/^[A-Za-z0-9_-]+$/).optional(),
});

type CategoryRow = { id: string; name: string; slug: string; description: string | null; image_url: string | null; parent_category_id: string | null; sort_order: number; is_featured: boolean; product_count: number };

async function loadCategoryTree(pool: Pool) {
  const result = await pool.query<CategoryRow>(
    `SELECT c.id, c.name, c.slug, c.description, c.image_url, c.parent_category_id, c.sort_order, c.is_featured,
            (SELECT COUNT(*) FROM products p
              WHERE p.is_active AND p.archived_at IS NULL AND (p.category_id = c.id OR p.subcategory_id = c.id))::integer AS product_count
       FROM categories c
       LEFT JOIN categories parent ON parent.id = c.parent_category_id
      WHERE c.is_active AND (parent.id IS NULL OR parent.is_active)
      ORDER BY c.sort_order, c.name`,
  );
  const top = result.rows.filter(row => !row.parent_category_id);
  return top.map(category => ({
    ...category,
    thumb_url: thumbOf(category.image_url),
    children: result.rows.filter(row => row.parent_category_id === category.id).map(child => ({ ...child, thumb_url: thumbOf(child.image_url) })),
  }));
}

export async function registerCatalogRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  app.get('/api/v1/categories', async (_request, reply) => {
    void reply.header('cache-control', 'public, max-age=60');
    return { data: await loadCategoryTree(pool) };
  });

  // Home shows 8 featured products and 8 featured categories. When the admin has featured fewer
  // than 8, the rest are filled with other in-stock products / categories chosen at random.
  app.get('/api/v1/home', async (_request, reply) => {
    void reply.header('cache-control', 'public, max-age=60');
    // Candidates: featured products first, then the 40 best sellers. The random fill is drawn from this
    // short list in memory, so the database never sorts the whole catalogue randomly.
    const [categories, candidates, kits] = await Promise.all([
      loadCategoryTree(pool),
      queryCards(pool, 'TRUE', [], `p.is_featured DESC, ${sortOrder('popular')}`, 48),
      queryCards(pool, `c.slug = 'pooja-kits' OR sub.slug = 'pooja-kits'`, [], sortOrder('popular'), 4),
    ]);
    const featured = candidates.filter(card => card.is_featured);
    const rest = candidates.filter(card => !card.is_featured);
    const popular: ProductCard[] = [
      ...featured,
      ...shuffle(rest.filter(card => card.stock_status !== 'out_of_stock')),
      ...shuffle(rest.filter(card => card.stock_status === 'out_of_stock')),
    ].slice(0, 8);
    const flat = categories.flatMap(({ children, ...category }) => [category, ...children]);
    const featuredCategories = flat.filter(category => category.is_featured);
    const others = flat.filter(category => !category.is_featured && !category.parent_category_id && category.product_count > 0).sort(() => Math.random() - 0.5);
    const featured_categories = [...featuredCategories, ...others].slice(0, 8);
    return { data: { categories, featured_categories, popular, kits } };
  });

  app.get('/api/v1/products/filters', async (request, reply) => {
    const parsed = z.object({
      q: z.string().trim().max(100).optional(),
      category: z.string().regex(/^[a-z0-9-]{1,120}$/).optional(),
    }).safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_FILTERS', message: 'The selected search or category filter is invalid.' });
    const values: unknown[] = [];
    const where: string[] = ['TRUE'];
    const terms = parsed.data.q ? searchTerms(parsed.data.q) : null;
    if (terms?.words.length) {
      values.push(terms.words);
      const wordsParam = `$${values.length}`;
      const byName = await pool.query(`SELECT 1 FROM products p WHERE p.is_active AND p.archived_at IS NULL AND ${exactMatch('$1')} LIMIT 1`, [terms.words]);
      values.push(terms.full);
      const fullParam = `$${values.length}`;
      where.push(`(${exactMatch(wordsParam, byName.rowCount ? 'product' : 'category')} OR lower(c.name) = ${fullParam} OR lower(sub.name) = ${fullParam})`);
    }
    if (parsed.data.category) {
      values.push(parsed.data.category);
      where.push(`(c.slug = $${values.length} OR sub.slug = $${values.length})`);
    }
    const result = await pool.query(
      `SELECT COALESCE(MIN(price_paise), 0)::integer AS min_price_paise,
              COALESCE(MAX(price_paise), 0)::integer AS max_price_paise,
              COUNT(*) FILTER (WHERE stock > 0)::integer AS in_stock_count,
              COUNT(*) FILTER (WHERE is_featured)::integer AS featured_count,
              COUNT(*) FILTER (WHERE has_discount)::integer AS discounted_count,
              COUNT(*) FILTER (WHERE has_variants)::integer AS variant_count,
              COUNT(*)::integer AS total
         FROM (${productCardSelect} WHERE ${productVisibleWhere} AND (${where.join(' AND ')})) catalogue`, values,
    );
    const row = result.rows[0] ?? {};
    return { data: { price_min_paise: Number(row.min_price_paise), price_max_paise: Number(row.max_price_paise),
      counts: { total: Number(row.total), in_stock: Number(row.in_stock_count), featured: Number(row.featured_count), discounted: Number(row.discounted_count), variants: Number(row.variant_count) } } };
  });

  app.get('/api/v1/products', async (request, reply) => {
    const query = parseOrReply(listQuery, request.query, reply);
    if (!query) return;
    const { limit, offset: requestedOffset } = paging(query, 12, 48);
    const offset = query.cursor ? 0 : requestedOffset;
    const values: unknown[] = [];
    const where: string[] = ['TRUE'];
    const terms = query.q ? searchTerms(query.q) : null;
    const sort: ListSort = query.sort && query.sort !== 'relevance' ? query.sort : 'popular';
    let order: string = sortOrder(sort);
    let keyset = true;
    let wordsParam = '';
    if (terms?.words.length) {
      values.push(terms.words);
      wordsParam = `$${values.length}`;
      // Products whose own name matches; if there are none, products in a matching category.
      const byName = await pool.query(`SELECT 1 FROM products p WHERE p.is_active AND p.archived_at IS NULL AND ${exactMatch('$1')} LIMIT 1`, [terms.words]);
      // Typing a category's exact name ("pooja essentials") also lists that category's products.
      values.push(terms.full);
      const fullParam = `$${values.length}`;
      where.push(`(${exactMatch(wordsParam, byName.rowCount ? 'product' : 'category')} OR lower(c.name) = ${fullParam} OR lower(sub.name) = ${fullParam})`);
    }
    if (query.category) {
      values.push(query.category);
      where.push(`(c.slug = $${values.length} OR sub.slug = $${values.length})`);
    }
    if (query.min_price !== undefined) { values.push(query.min_price); where.push(`COALESCE(v.min_price, p.price_paise) >= $${values.length}`); }
    if (query.max_price !== undefined) { values.push(query.max_price); where.push(`COALESCE(v.min_price, p.price_paise) <= $${values.length}`); }
    if (query.featured === 'true') where.push('p.is_featured');
    if (query.in_stock === 'true') where.push('(CASE WHEN v.product_id IS NOT NULL THEN v.stock ELSE COALESCE(i.quantity, 0) END) > 0');
    if (query.discount_only === 'true') where.push(`CASE WHEN v.product_id IS NOT NULL THEN COALESCE(v.min_mrp > v.min_price, FALSE) ELSE COALESCE(p.mrp_paise, p.price_paise) > p.price_paise END`);
    const filter = where.join(' AND ');
    // Ranking parameters come after every filter parameter; the count query uses only the filters.
    const listValues = [...values];
    if (wordsParam && (!query.sort || query.sort === 'relevance')) {
      listValues.push(terms!.full, terms!.prefix);
      order = relevanceOrder(`$${listValues.length - 1}`, `$${listValues.length}`, wordsParam);
      keyset = false;
    }
    let pageFilter = filter;
    if (query.cursor) {
      if (!keyset) return reply.code(400).send({ error: 'INVALID_CURSOR', message: 'Search results sorted by best match use page numbers, not a cursor.' });
      try { pageFilter = `${filter} AND ${afterCursor(sort, query.cursor, listValues)}`; } catch (error) {
        if (error instanceof InvalidCursorError) return reply.code(400).send({ error: 'INVALID_CURSOR', message: 'The page cursor is invalid. Start again from the first page.' });
        throw error;
      }
    }
    const [rows, total] = await Promise.all([
      queryCardRows(pool, pageFilter, listValues, order, limit, offset),
      pool.query<{ total: number }>(`SELECT COUNT(*)::integer AS total FROM (${productCardSelect} WHERE ${productVisibleWhere} AND (${filter})) t`, values),
    ]);
    const items = rows.map(toCard);
    const nextCursor = keyset && rows.length === limit ? cursorFor(sort, rows[rows.length - 1]!) : null;
    // A short "similar products" row after the exact matches, on the first page of a search only.
    const similar = terms?.words.length && offset === 0 && !query.cursor ? await similarProducts(pool, query.q!, items) : [];
    return { data: items, similar, pagination: { limit, offset, total: Number(total.rows[0]?.total ?? 0), next_cursor: nextCursor } };
  });

  app.get<{ Querystring: { q?: string } }>('/api/v1/search/suggest', async (request) => {
    const q = (request.query.q ?? '').trim().slice(0, 60);
    if (q.length < 2) return { data: { products: [], categories: [] } };
    const terms = searchTerms(q);
    if (!terms.words.length) return { data: { products: [], categories: [] } };
    const [products, categories] = await Promise.all([
      queryCards(pool, exactMatch('$1'), [terms.words, terms.full, terms.prefix], relevanceOrder('$2', '$3', '$1'), 6),
      pool.query(`SELECT c.name, c.slug FROM categories c LEFT JOIN categories sub ON FALSE LEFT JOIN products p ON FALSE WHERE c.is_active AND ${exactMatch('$1', 'category')} ORDER BY c.sort_order, c.name LIMIT 4`, [terms.words]),
    ]);
    return { data: { products, categories: categories.rows } };
  });

  app.get<{ Params: { productId: string } }>('/api/v1/products/:productId', async (request, reply) => {
    const key = request.params.productId.trim().slice(0, 120);
    if (!/^[A-Za-z0-9-]+$/.test(key)) return reply.code(400).send({ error: 'INVALID_PRODUCT_ID', message: 'A valid product identifier is required.' });
    const base = await pool.query(
      `${productCardSelect} WHERE ${productVisibleWhere} AND (p.slug = $1 OR p.id::text = $1) LIMIT 1`, [key],
    );
    const row = base.rows[0];
    if (!row) return reply.code(404).send({ error: 'PRODUCT_NOT_FOUND', message: 'This product is unavailable or no longer listed.' });
    const [detail, images, variants] = await Promise.all([
      pool.query(
        `SELECT p.description, p.highlights, p.weight_grams, p.hsn_code, p.sku, p.gst_rate_basis_points,
                c.name AS parent_category_name, c.slug AS parent_category_slug, sub.name AS subcategory_name, sub.slug AS subcategory_slug
           FROM products p LEFT JOIN categories c ON c.id = p.category_id LEFT JOIN categories sub ON sub.id = p.subcategory_id
          WHERE p.id = $1`, [row.id]),
      pool.query(`SELECT image_url AS url, alt_text FROM product_images WHERE product_id = $1 ORDER BY sort_order, created_at`, [row.id]),
      pool.query(
        `SELECT id, label, price_paise, mrp_paise, weight_grams, quantity FROM product_variants
          WHERE product_id = $1 AND is_active ORDER BY sort_order, price_paise`, [row.id]),
    ]);
    const card = toCard(row);
    const info = detail.rows[0];
    const gallery = images.rows.length ? images.rows : card.image_url ? [{ url: card.image_url, alt_text: card.name }] : [];
    const related = row.category_slug
      ? await queryCards(pool, '(c.slug = $1 OR sub.slug = $1) AND p.id <> $2', [row.category_slug, row.id], sortOrder('popular'), 4)
      : [];
    return {
      data: {
        ...card,
        description: info.description,
        highlights: info.highlights,
        weight_grams: info.weight_grams,
        sku: info.sku,
        hsn_code: info.hsn_code,
        gst_rate_basis_points: info.gst_rate_basis_points,
        category: info.parent_category_slug ? { name: info.parent_category_name, slug: info.parent_category_slug } : null,
        subcategory: info.subcategory_slug ? { name: info.subcategory_name, slug: info.subcategory_slug } : null,
        images: gallery.map((image: { url: string; alt_text: string | null }) => ({ ...image, thumb_url: thumbOf(image.url) })),
        variants: variants.rows.map(variant => {
          const stock = Number(variant.quantity);
          return {
            id: variant.id, label: variant.label, price_paise: Number(variant.price_paise), mrp_paise: Number(variant.mrp_paise),
            weight_grams: variant.weight_grams,
            stock_status: stock <= 0 ? 'out_of_stock' : stock <= Number(row.minimum_stock_level) ? 'low_stock' : 'in_stock',
            max_quantity: Math.max(0, Math.min(stock, MAX_LINE_QUANTITY)),
          };
        }),
        related,
      },
    };
  });
}
