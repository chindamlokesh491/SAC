import type { Pool, PoolClient } from 'pg';
import { variantUrl } from '../media/store.js';

/** Public listing card. Exact stock counts are not exposed; only a status and an order cap. */
export type ProductCard = {
  id: string; slug: string; name: string; short_description: string | null;
  price_paise: number; mrp_paise: number; image_url: string | null; thumb_url: string | null;
  category_name: string | null; category_slug: string | null;
  stock_status: 'in_stock' | 'low_stock' | 'out_of_stock'; max_quantity: number;
  has_variants: boolean; is_featured: boolean;
};

export const MAX_LINE_QUANTITY = 20;

/** Thumbnails are generated next to uploads as <name>-sm.webp (local disk or Supabase Storage). */
export function thumbOf(url: string | null): string | null {
  return variantUrl(url, '-sm');
}

/**
 * Shared SELECT for product cards. Products with active variants are priced from
 * their cheapest variant and stocked by the sum of variant stock.
 */
export const productCardSelect = `
  SELECT p.id, p.slug, p.name, p.short_description, p.is_featured, p.created_at,
         COALESCE(v.min_price, p.price_paise)::integer AS price_paise,
         COALESCE(v.min_mrp, p.mrp_paise, p.price_paise)::integer AS mrp_paise,
         CASE WHEN v.product_id IS NOT NULL THEN COALESCE(v.min_mrp > v.min_price, FALSE)
              ELSE COALESCE(p.mrp_paise, p.price_paise) > p.price_paise END AS has_discount,
         COALESCE((SELECT pi.image_url FROM product_images pi WHERE pi.product_id = p.id ORDER BY pi.sort_order, pi.created_at LIMIT 1), p.image_url) AS image_url,
         COALESCE(sub.name, c.name) AS category_name, COALESCE(sub.slug, c.slug) AS category_slug,
         CASE WHEN v.product_id IS NOT NULL THEN v.stock ELSE COALESCE(i.quantity, 0) END::integer AS stock,
         p.minimum_stock_level,
         (v.product_id IS NOT NULL) AS has_variants,
         COALESCE(s.units_90d, 0)::integer AS units_sold
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN categories sub ON sub.id = p.subcategory_id
    LEFT JOIN inventory i ON i.product_id = p.id
    LEFT JOIN LATERAL (
      SELECT pv.product_id, MIN(pv.price_paise) AS min_price,
             (ARRAY_AGG(pv.mrp_paise ORDER BY pv.price_paise ASC, pv.mrp_paise DESC))[1] AS min_mrp,
             SUM(pv.quantity) AS stock
        FROM product_variants pv WHERE pv.product_id = p.id AND pv.is_active GROUP BY pv.product_id
    ) v ON TRUE
    -- Sales figures come from the maintained summary (migration 022), not order lines at request time.
    LEFT JOIN product_sales_summary s ON s.product_id = p.id`;

/** Visible on the storefront: active, not archived, and its categories (if any) active. */
export const productVisibleWhere = `p.is_active AND p.archived_at IS NULL
  AND (c.id IS NULL OR c.is_active) AND (sub.id IS NULL OR sub.is_active)`;

export type CardRow = Omit<ProductCard, 'stock_status' | 'max_quantity' | 'thumb_url'> & { stock: number; minimum_stock_level: number; units_sold: number; created_at: string };

export function toCard(row: CardRow): ProductCard {
  const stock = Number(row.stock);
  return {
    id: row.id, slug: row.slug, name: row.name, short_description: row.short_description,
    price_paise: Number(row.price_paise), mrp_paise: Math.max(Number(row.mrp_paise), Number(row.price_paise)),
    image_url: row.image_url, thumb_url: thumbOf(row.image_url),
    category_name: row.category_name, category_slug: row.category_slug,
    stock_status: stock <= 0 ? 'out_of_stock' : stock <= Number(row.minimum_stock_level) ? 'low_stock' : 'in_stock',
    max_quantity: Math.max(0, Math.min(stock, MAX_LINE_QUANTITY)),
    has_variants: row.has_variants, is_featured: row.is_featured,
  };
}

export async function queryCardRows(db: Pool | PoolClient, where: string, values: unknown[], orderBy: string, limit: number, offset = 0): Promise<CardRow[]> {
  values.push(limit, offset);
  const result = await db.query<CardRow>(
    `${productCardSelect} WHERE ${productVisibleWhere} AND (${where}) ORDER BY ${orderBy} LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  return result.rows;
}

export async function queryCards(db: Pool | PoolClient, where: string, values: unknown[], orderBy: string, limit: number, offset = 0): Promise<ProductCard[]> {
  return (await queryCardRows(db, where, values, orderBy, limit, offset)).map(toCard);
}
