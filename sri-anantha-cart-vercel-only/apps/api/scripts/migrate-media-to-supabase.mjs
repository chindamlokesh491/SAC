// Moves product/category images from the API's local disk to Supabase Storage without breaking any link.
//
//   node scripts/migrate-media-to-supabase.mjs                 dry run: lists what would move, changes nothing
//   node scripts/migrate-media-to-supabase.mjs --apply         upload, verify, then switch references
//   node scripts/migrate-media-to-supabase.mjs --rollback <manifest.json>   point references back to local files
//
// Needs DATABASE_URL (owner or runtime role), MEDIA_DIR, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
// Safety:
//   * Local files are never deleted; rolling back only rewrites the database references.
//   * Every object is verified (public URL answers 200 with the same byte size) before any reference changes.
//   * All references (products, product_images, categories, order_items snapshots, media_assets) switch in ONE
//     transaction, after a manifest of every old -> new URL is written to disk for rollback.
//   * Re-running is safe: objects already uploaded with the same size are accepted, not duplicated.
import { existsSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import pg from 'pg';
import sharp from 'sharp';
import { databaseSslOptions } from './lib/db-ssl.mjs';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const rollbackFile = args.includes('--rollback') ? args[args.indexOf('--rollback') + 1] : null;
const { DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
const mediaDir = resolve(process.env.MEDIA_DIR ?? 'var/media');
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
const ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const LOCAL = new RegExp(`^/media/(${ID})\\.webp$`);
const REFERENCES = [
  ['products', 'image_url'], ['product_images', 'image_url'], ['categories', 'image_url'], ['order_items', 'image_url_snapshot'], ['media_assets', 'public_url'],
];

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2, ...databaseSslOptions() });

async function switchReferences(client, mapping) {
  let changed = 0;
  for (const [table, column] of REFERENCES) {
    for (const [from, to] of mapping) {
      const result = await client.query(`UPDATE ${table} SET ${column} = $2 WHERE ${column} = $1`, [from, to.url]);
      changed += result.rowCount;
    }
  }
  return changed;
}

if (rollbackFile) {
  const manifest = JSON.parse(await readFile(rollbackFile, 'utf8'));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const back = manifest.items.map(item => [item.to, { url: item.from }]);
    const changed = await switchReferences(client, back);
    await client.query(`UPDATE media_assets SET storage = 'local', bucket = NULL WHERE public_url LIKE '/media/%'`);
    await client.query('COMMIT');
    console.log(`Rolled back ${changed} references to local /media URLs.`);
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); await pool.end(); }
  process.exit(0);
}

if (apply && (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required with --apply');
const base = (SUPABASE_URL ?? 'https://<project-ref>.supabase.co').replace(/\/$/, '');

// 1. Every local image any table points at, and the bucket it belongs in.
const refs = await pool.query(`
  SELECT url, COALESCE(bool_and(kind = 'category') FILTER (WHERE kind <> 'asset'), false) AS category_only FROM (
    SELECT image_url AS url, 'product' AS kind FROM products
    UNION ALL SELECT image_url, 'product' FROM product_images
    UNION ALL SELECT image_url, 'category' FROM categories
    UNION ALL SELECT image_url_snapshot, 'order' FROM order_items
    UNION ALL SELECT public_url, 'asset' FROM media_assets WHERE storage = 'local'
  ) r WHERE url ~ $1 GROUP BY url ORDER BY url`, [LOCAL.source]);

const plan = [];
const missing = [];
for (const row of refs.rows) {
  const id = LOCAL.exec(row.url)[1];
  const bucket = row.category_only ? 'category-images' : 'product-images';
  if (!existsSync(join(mediaDir, `${id}.webp`))) { missing.push(row.url); continue; }
  plan.push({ from: row.url, id, bucket, to: `${base}/storage/v1/object/public/${bucket}/${id}.webp` });
}
console.log(`${plan.length} images to move (${plan.filter(p => p.bucket === 'category-images').length} category, ${plan.filter(p => p.bucket === 'product-images').length} product).`);
if (missing.length) {
  console.error(`STOP: ${missing.length} referenced files are missing from ${mediaDir}:\n  ${missing.join('\n  ')}`);
  await pool.end();
  process.exit(1);
}
if (!apply) {
  for (const item of plan.slice(0, 10)) console.log(`  ${item.from} -> ${item.bucket}/${item.id}.webp`);
  if (plan.length > 10) console.log(`  ... and ${plan.length - 10} more`);
  console.log('Dry run only. Re-run with --apply to upload, verify and switch references.');
  await pool.end();
  process.exit(0);
}

// 2. Upload all three sizes (creating any missing smaller size from the original) and verify each.
const auth = { authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, apikey: SUPABASE_SERVICE_ROLE_KEY };
async function sized(id, suffix) {
  const path = join(mediaDir, `${id}${suffix}.webp`);
  if (existsSync(path)) return readFile(path);
  const size = suffix === '-md' ? 720 : 400;
  return sharp(join(mediaDir, `${id}.webp`)).resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
}
for (const item of plan) {
  for (const suffix of ['', '-md', '-sm']) {
    const data = await sized(item.id, suffix);
    const name = `${item.id}${suffix}.webp`;
    const upload = await fetch(`${base}/storage/v1/object/${item.bucket}/${name}`, {
      method: 'POST', body: data, headers: { ...auth, 'content-type': 'image/webp', 'cache-control': 'max-age=31536000, immutable', 'x-upsert': 'false' },
    });
    if (!upload.ok && upload.status !== 409 && upload.status !== 400) throw new Error(`Upload of ${item.bucket}/${name} failed: HTTP ${upload.status}`);
    const check = await fetch(`${base}/storage/v1/object/public/${item.bucket}/${name}`, { method: 'HEAD' });
    const length = Number(check.headers.get('content-length'));
    if (!check.ok || length !== data.length) throw new Error(`Verification failed for ${item.bucket}/${name}: HTTP ${check.status}, ${length} bytes (expected ${data.length}). Nothing in the database was changed.`);
  }
  process.stdout.write('.');
}
console.log(`\nUploaded and verified ${plan.length * 3} objects.`);

// 3. Manifest first, then switch every reference in one transaction.
const manifestPath = resolve(`media-migration-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
await writeFile(manifestPath, JSON.stringify({ created_at: new Date().toISOString(), supabase_url: base, items: plan.map(({ from, to, bucket }) => ({ from, to, bucket })) }, null, 2));
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const changed = await switchReferences(client, plan.map(item => [item.from, { url: item.to }]));
  for (const item of plan) {
    await client.query(`UPDATE media_assets SET storage = 'supabase', bucket = $2 WHERE file_name = $1`, [`${item.id}.webp`, item.bucket]);
  }
  const left = await client.query(`SELECT
      (SELECT count(*) FROM products WHERE image_url ~ $1) + (SELECT count(*) FROM product_images WHERE image_url ~ $1)
    + (SELECT count(*) FROM categories WHERE image_url ~ $1) + (SELECT count(*) FROM order_items WHERE image_url_snapshot ~ $1) AS n`, [LOCAL.source]);
  if (Number(left.rows[0].n) !== 0) throw new Error(`${left.rows[0].n} local references remain; rolling back`);
  await client.query('COMMIT');
  console.log(`Switched ${changed} references. Manifest for rollback: ${manifestPath}`);
  console.log(`Local files in ${mediaDir} were kept. Remove them only after the storefront has been checked.`);
} catch (error) {
  await client.query('ROLLBACK');
  await unlink(manifestPath).catch(() => undefined); // nothing was switched, so there is nothing to roll back
  throw error;
} finally {
  client.release();
  await pool.end();
}
