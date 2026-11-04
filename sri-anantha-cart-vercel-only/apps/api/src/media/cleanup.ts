import type { Pool } from 'pg';
import { type MediaStore, VARIANT_SUFFIXES } from './store.js';

/**
 * Deletes uploaded images that nothing references any more (all three sizes). Images still shown in
 * past orders (order item snapshots) are kept so order history keeps its pictures. Run after the commit.
 */
export async function deleteUnusedMedia(pool: Pool, store: MediaStore, urls: (string | null | undefined)[]): Promise<number> {
  let removed = 0;
  for (const url of new Set(urls.filter((value): value is string => typeof value === 'string'))) {
    const found = store.locate(url);
    if (!found) continue;
    const used = await pool.query(
      `SELECT 1 FROM product_images WHERE image_url = $1
       UNION ALL SELECT 1 FROM products WHERE image_url = $1
       UNION ALL SELECT 1 FROM categories WHERE image_url = $1
       UNION ALL SELECT 1 FROM order_items WHERE image_url_snapshot = $1 LIMIT 1`, [url]);
    if (used.rowCount) continue;
    await store.remove(found.bucket, VARIANT_SUFFIXES.map(suffix => `${found.id}${suffix}.webp`));
    await pool.query('DELETE FROM media_assets WHERE file_name = $1', [`${found.id}.webp`]);
    removed++;
  }
  return removed;
}
