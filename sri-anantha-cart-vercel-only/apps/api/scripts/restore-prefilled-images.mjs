// Restore the original demo catalogue photos into staging Supabase Storage.
// Safe/idempotent: preserves custom uploaded images, only replaces legacy GitHub or /media URLs,
// and adds the original product photo as an additional gallery image when needed.
// Run from repo root: node apps/api/scripts/restore-prefilled-images.mjs [--apply]
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import sharp from 'sharp';
import { databaseSslOptions } from './lib/db-ssl.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const imagesDir = resolve(root, 'database/seed/images');
const apply = process.argv.includes('--apply');
const { DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required (staging database only).');
if (apply && (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required with --apply.');
if (process.env.NODE_ENV === 'production') throw new Error('Refusing to run when NODE_ENV=production.');
const base = (SUPABASE_URL ?? 'https://staging-project.supabase.co').replace(/\/$/, '');

const products = [
  ['sandalwood-agarbatti','sandalwood-agarbatti'],['rose-agarbatti','rose-agarbatti'],['jasmine-agarbatti','jasmine-agarbatti'],
  ['mogra-agarbatti','mogra-agarbatti'],['premium-herbal-agarbatti','premium-herbal-agarbatti'],
  ['premium-kumkum','kumkum-powder'],['organic-haldi','turmeric-haldi-powder'],['sindoor','sindoor'],['chandan-powder','chandan-powder'],
  ['brass-diya','diya-oil-lamp'],['pooja-thali-set','pooja-thali'],['akshata-turmeric-rice','akshata-turmeric-rice'],
  ['cotton-wicks','cotton-wicks'],['pooja-matchbox','pooja-matchbox'],['brass-pooja-bell','bell-ghanti'],
  ['fresh-marigold-flowers','fresh-marigold-flowers'],['fresh-jasmine-flowers','jasmine-flowers'],['rose-petals','rose-petals'],
  ['daily-pooja-kit','kit-daily'],['ganesh-chaturthi-kit','kit-ganesh-chaturthi'],
  ['satyanarayana-pooja-kit','kit-satyanarayana'],['navaratri-pooja-kit','kit-navaratri'],
];
const categories = [
  ['agarbatti','sandalwood-agarbatti'],['kumkum-haldi','kumkum-powder'],['pooja-essentials','diya-oil-lamp'],
  ['flowers','fresh-marigold-flowers'],['pooja-kits','cat-pooja-kits'],['camphor-dhoop','cat-camphor-dhoop'],
  ['idols-decor','bell-ghanti'],['coconut-fruits','cat-coconut-fruits'],['festival-items','cat-festival-items'],
];
const legacy = url => !url || url.startsWith('https://raw.githubusercontent.com/gagan76565/sri-anantha-cart-dev/') || url.startsWith('/media/');
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2, ...databaseSslOptions() });
const auth = { authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY ?? ''}`, apikey: SUPABASE_SERVICE_ROLE_KEY ?? '' };

function stableUuid(bucket, name) {
  const bytes = createHash('sha256').update(`sri-anantha-cart-staging:${bucket}:${name}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

async function uploadOriginal(name, bucket) {
  const input = await readFile(resolve(imagesDir, `${name}.webp`));
  const id = stableUuid(bucket, name);
  const resize = (size, quality, alphaQuality) => sharp(input, { limitInputPixels: 40_000_000 })
    .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
    .webp({ quality, alphaQuality }).toBuffer({ resolveWithObject: true });
  const [main, medium, thumb] = await Promise.all([resize(1200,82,90),resize(720,80,88),resize(400,78,85)]);
  const files = [[`${id}.webp`,main.data],[`${id}-md.webp`,medium.data],[`${id}-sm.webp`,thumb.data]];
  if (apply) {
    for (const [file,data] of files) {
      const res = await fetch(`${base}/storage/v1/object/${bucket}/${file}`, {
        method:'POST', body:data, headers:{...auth,'content-type':'image/webp','cache-control':'max-age=31536000, immutable','x-upsert':'false'}
      });
      if (!res.ok && res.status !== 409) throw new Error(`Upload failed for ${bucket}/${file}: HTTP ${res.status}`);
      const check = await fetch(`${base}/storage/v1/object/public/${bucket}/${file}`, {method:'HEAD'});
      if (!check.ok || Number(check.headers.get('content-length')) !== data.length) throw new Error(`Verification failed for ${bucket}/${file}`);
    }
  }
  return { id, url: `${base}/storage/v1/object/public/${bucket}/${id}.webp`, bytes:main.data.length, width:main.info.width, height:main.info.height };
}

async function main() {
const report = { created_at:new Date().toISOString(), mode:apply?'apply':'dry-run', products:[], categories:[] };
try {
  for (const [,image] of products) await readFile(resolve(imagesDir, `${image}.webp`));
  for (const [,image] of categories) await readFile(resolve(imagesDir, `${image}.webp`));
  const client = await pool.connect();
  try {
    const productRows = await client.query('SELECT id, slug, image_url FROM products WHERE slug = ANY($1)', [products.map(x=>x[0])]);
    const categoryRows = await client.query('SELECT id, slug, image_url FROM categories WHERE slug = ANY($1)', [categories.map(x=>x[0])]);
    const pBySlug = new Map(productRows.rows.map(x=>[x.slug,x]));
    const cBySlug = new Map(categoryRows.rows.map(x=>[x.slug,x]));
    const missingProducts = products.filter(([slug])=>!pBySlug.has(slug)).map(x=>x[0]);
    const missingCategories = categories.filter(([slug])=>!cBySlug.has(slug)).map(x=>x[0]);
    if (missingProducts.length || missingCategories.length) throw new Error(`Catalogue rows missing. Products: ${missingProducts.join(', ')}. Categories: ${missingCategories.join(', ')}. This restore will not seed catalogue records.`);
    if (!apply) {
      console.log(`Dry run: ${products.length} product photos and ${categories.length} category photos are present locally and mapped to existing staging catalogue records.`);
      console.log('No storage or database changes made. Re-run with --apply to upload and attach them.');
      return;
    }
    const uploadedProducts = [];
    for (const [slug,image] of products) uploadedProducts.push({slug,image,...await uploadOriginal(image,'product-images')});
    const uploadedCategories = [];
    for (const [slug,image] of categories) uploadedCategories.push({slug,image,...await uploadOriginal(image,'category-images')});

    await client.query('BEGIN');
    for (const item of uploadedProducts) {
      const product = pBySlug.get(item.slug);
      const url = item.url;
      const mediaFile = `${item.id}.webp`;
      const mediaExists = await client.query('SELECT 1 FROM media_assets WHERE file_name=$1 LIMIT 1', [mediaFile]);
      if (mediaExists.rowCount === 0) {
        await client.query(
          `INSERT INTO media_assets (file_name,content_type,byte_size,width,height,storage,bucket,public_url)
           VALUES ($1,'image/webp',$2,$3,$4,'supabase','product-images',$5)`,
          [mediaFile,item.bytes,item.width,item.height,url]);
      }
      const currentImages = await client.query('SELECT id,image_url,sort_order FROM product_images WHERE product_id=$1 ORDER BY sort_order,id', [product.id]);
      const alreadyAttached = currentImages.rows.some(x=>x.image_url === url);
      const legacyImage = currentImages.rows.find(x=>legacy(x.image_url));
      if (alreadyAttached) {
        // Safe on retries: this exact restored image is already in the gallery.
      } else if (legacyImage) {
        await client.query('UPDATE product_images SET image_url=$2 WHERE id=$1',[legacyImage.id,url]);
      } else if (currentImages.rowCount === 0) {
        await client.query('INSERT INTO product_images(product_id,image_url,alt_text,sort_order) VALUES($1,$2,$3,0)',[product.id,url,item.slug]);
      } else {
        const nextOrder = Math.max(...currentImages.rows.map(x=>x.sort_order))+1;
        await client.query('INSERT INTO product_images(product_id,image_url,alt_text,sort_order) VALUES($1,$2,$3,$4) ON CONFLICT(product_id,sort_order) DO NOTHING',[product.id,url,item.slug,nextOrder]);
      }
      if (legacy(product.image_url)) await client.query('UPDATE products SET image_url=$2,updated_at=now() WHERE id=$1',[product.id,url]);
      report.products.push({slug:item.slug,url});
    }
    for (const item of uploadedCategories) {
      const category = cBySlug.get(item.slug);
      const mediaFile = `${item.id}.webp`;
      const mediaExists = await client.query('SELECT 1 FROM media_assets WHERE file_name=$1 LIMIT 1', [mediaFile]);
      if (mediaExists.rowCount === 0) {
        await client.query(
          `INSERT INTO media_assets (file_name,content_type,byte_size,width,height,storage,bucket,public_url)
           VALUES ($1,'image/webp',$2,$3,$4,'supabase','category-images',$5)`,
          [mediaFile,item.bytes,item.width,item.height,item.url]);
      }
      if (legacy(category.image_url)) await client.query('UPDATE categories SET image_url=$2,updated_at=now() WHERE id=$1',[category.id,item.url]);
      report.categories.push({slug:item.slug,url:item.url});
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(()=>{});
    throw error;
  } finally { client.release(); }
  const manifest = resolve(root,`prefilled-image-restore-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
  await writeFile(manifest,JSON.stringify(report,null,2));
  console.log(`Restored ${report.products.length} product photos and ${report.categories.length} category photos. Manifest: ${manifest}`);
  console.log('Existing custom uploaded product images were preserved; original images were added only as missing/legacy gallery entries.');
} finally { await pool.end(); }
}
await main();
