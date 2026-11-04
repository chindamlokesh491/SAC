// Demo catalogue for local development, QA and client review.
// Uses the client's product photo batch (database/seed/images). Prices, stock and GST
// rates are placeholders that the store owner must confirm before launch.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import sharp from 'sharp';
import { databaseSslOptions } from './lib/db-ssl.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const imagesDir = resolve(here, '../../../database/seed/images');
const mediaDir = process.env.MEDIA_DIR ? (isAbsolute(process.env.MEDIA_DIR) ? process.env.MEDIA_DIR : resolve(process.env.MEDIA_DIR)) : resolve('var/media');

if (process.env.NODE_ENV === 'production' && !process.argv.includes('--allow-production')) {
  console.error('Refusing to seed demo data into a production environment.');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

const highlights = {
  incense: ['Natural Fragrance', 'Long Lasting', 'Premium Quality', 'Traditional Aroma'],
  brass: ['Premium Quality', 'Traditional Design', 'Long Lasting', 'Easy to Clean'],
  flowers: ['Farm Fresh', 'Hand Picked', 'Pooja Ready', 'Delivered Fresh'],
  powder: ['Pure & Natural', 'Rich Colour', 'Premium Quality', 'Traditional'],
  kit: ['Complete Set', 'Premium Quality', 'Traditional', 'Pooja Ready'],
  essentials: ['Premium Quality', 'Traditional', 'Daily Use', 'Pooja Ready'],
};

const categories = [
  { slug: 'agarbatti', name: 'Agarbatti', image: 'sandalwood-agarbatti', children: [['incense-sticks', 'Incense Sticks'], ['masala-agarbatti', 'Masala Agarbatti'], ['dhoop-sticks', 'Dhoop Sticks'], ['cones', 'Cones']] },
  { slug: 'kumkum-haldi', name: 'Kumkum & Haldi', image: 'kumkum-powder', children: [['kumkum', 'Kumkum'], ['haldi', 'Haldi'], ['sindoor-chandan', 'Sindoor & Chandan']] },
  { slug: 'pooja-essentials', name: 'Pooja Essentials', image: 'diya-oil-lamp', children: [] },
  { slug: 'flowers', name: 'Flowers', image: 'fresh-marigold-flowers', children: [] },
  { slug: 'pooja-kits', name: 'Pooja Kits', image: 'cat-pooja-kits', children: [] },
  { slug: 'camphor-dhoop', name: 'Camphor & Dhoop', image: 'cat-camphor-dhoop', children: [] },
  { slug: 'idols-decor', name: 'Idols & Decor', image: 'bell-ghanti', children: [] },
  { slug: 'coconut-fruits', name: 'Coconut & Fruits', image: 'cat-coconut-fruits', children: [] },
  { slug: 'festival-items', name: 'Festival Items', image: 'cat-festival-items', children: [] },
];

// [slug, name, short, category, subcategory, price ₹, mrp ₹, gst %, hsn, stock, min, image, highlights, featured, weight g, variants]
const products = [
  ['sandalwood-agarbatti', 'Sandalwood Agarbatti', 'Natural Fragrance', 'agarbatti', 'incense-sticks', 120, 150, 5, '33074100', 45, 10, 'sandalwood-agarbatti', 'incense', true, 100],
  ['rose-agarbatti', 'Rose Agarbatti', 'Floral Aroma', 'agarbatti', 'incense-sticks', 99, 110, 5, '33074100', 4, 10, 'rose-agarbatti', 'incense', false, 100],
  ['jasmine-agarbatti', 'Jasmine Agarbatti', 'Calming Fragrance', 'agarbatti', 'incense-sticks', 99, 99, 5, '33074100', 38, 10, 'jasmine-agarbatti', 'incense', false, 100],
  ['mogra-agarbatti', 'Mogra Agarbatti', 'Fresh Mogra Scent', 'agarbatti', 'incense-sticks', 110, 125, 5, '33074100', 30, 10, 'mogra-agarbatti', 'incense', false, 100],
  ['premium-herbal-agarbatti', 'Premium Herbal Agarbatti', 'Masala Incense', 'agarbatti', 'masala-agarbatti', 150, 180, 5, '33074100', 0, 8, 'premium-herbal-agarbatti', 'incense', false, 120,
    [['50 sticks', 'HERBAL-50', 150, 180, 26], ['100 sticks', 'HERBAL-100', 280, 340, 14]]],
  ['premium-kumkum', 'Premium Kumkum', 'Long-lasting Color', 'kumkum-haldi', 'kumkum', 60, 70, 0, '33049910', 52, 10, 'kumkum-powder', 'powder', true, 50],
  ['organic-haldi', 'Organic Haldi', 'Pure & Natural', 'kumkum-haldi', 'haldi', 70, 80, 5, '09103030', 0, 10, 'turmeric-haldi-powder', 'powder', true, 100,
    [['100 g', 'HALDI-100', 70, 80, 40], ['250 g', 'HALDI-250', 160, 185, 22]]],
  ['sindoor', 'Sindoor', 'Traditional Red', 'kumkum-haldi', 'sindoor-chandan', 50, 60, 0, '33049910', 6, 8, 'sindoor', 'powder', false, 50],
  ['chandan-powder', 'Chandan Powder', 'Pure Sandalwood', 'kumkum-haldi', 'sindoor-chandan', 90, 110, 18, '33049990', 25, 8, 'chandan-powder', 'powder', false, 50],
  ['brass-diya', 'Brass Diya', 'Traditional Brass Lamp', 'pooja-essentials', null, 199, 249, 12, '74182020', 34, 8, 'diya-oil-lamp', 'brass', true, 180],
  ['pooja-thali-set', 'Pooja Thali Set', 'Complete Pooja Essentials', 'pooja-essentials', null, 350, 450, 12, '74182020', 18, 5, 'pooja-thali', 'brass', true, 650],
  ['akshata-turmeric-rice', 'Akshata (Turmeric Rice)', 'Sacred Akshata', 'pooja-essentials', null, 40, 45, 5, '10063090', 60, 10, 'akshata-turmeric-rice', 'essentials', false, 100],
  ['cotton-wicks', 'Cotton Wicks', 'Pure Cotton Batti', 'pooja-essentials', null, 30, 35, 12, '56012100', 80, 15, 'cotton-wicks', 'essentials', false, 40],
  ['pooja-matchbox', 'Pooja Matchbox', 'Safety Matches', 'pooja-essentials', null, 10, 10, 12, '36050010', 0, 20, 'pooja-matchbox', 'essentials', false, 20],
  ['brass-pooja-bell', 'Brass Pooja Bell', 'Ghanti with Nandi', 'idols-decor', null, 249, 299, 12, '83061000', 12, 4, 'bell-ghanti', 'brass', false, 250],
  ['fresh-marigold-flowers', 'Fresh Marigold Flowers', 'Farm Fresh', 'flowers', null, 40, 40, 0, '06031900', 50, 10, 'fresh-marigold-flowers', 'flowers', false, 250],
  ['fresh-jasmine-flowers', 'Fresh Jasmine Flowers', 'Farm Fresh', 'flowers', null, 50, 50, 0, '06031900', 8, 10, 'jasmine-flowers', 'flowers', true, 100],
  ['rose-petals', 'Rose Petals', 'Fresh & Fragrant', 'flowers', null, 60, 60, 0, '06031100', 30, 10, 'rose-petals', 'flowers', false, 100],
  ['daily-pooja-kit', 'Daily Pooja Kit', 'All-in-one Kit', 'pooja-kits', null, 299, 349, 12, '33074100', 20, 5, 'kit-daily', 'kit', true, 500],
  ['ganesh-chaturthi-kit', 'Ganesh Chaturthi Kit', 'Festival Special', 'pooja-kits', null, 499, 599, 12, '33074100', 15, 5, 'kit-ganesh-chaturthi', 'kit', false, 800],
  ['satyanarayana-pooja-kit', 'Satyanarayana Pooja Kit', 'Complete Vratham Kit', 'pooja-kits', null, 599, 699, 12, '33074100', 12, 5, 'kit-satyanarayana', 'kit', false, 900],
  ['navaratri-pooja-kit', 'Navaratri Pooja Kit', 'Nine-day Essentials', 'pooja-kits', null, 749, 899, 12, '33074100', 10, 5, 'kit-navaratri', 'kit', false, 1100],
];

async function storeImage(client, name) {
  const input = await readFile(resolve(imagesDir, `${name}.webp`));
  const id = randomUUID();
  const main = await sharp(input).resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82, alphaQuality: 90 }).toBuffer({ resolveWithObject: true });
  const thumb = await sharp(input).resize({ width: 400, height: 400, fit: 'inside', withoutEnlargement: true }).webp({ quality: 78, alphaQuality: 85 }).toBuffer();
  await mkdir(mediaDir, { recursive: true });
  await writeFile(resolve(mediaDir, `${id}.webp`), main.data);
  await writeFile(resolve(mediaDir, `${id}-sm.webp`), thumb);
  await client.query(`INSERT INTO media_assets (file_name, content_type, byte_size, width, height) VALUES ($1, 'image/webp', $2, $3, $4)`, [`${id}.webp`, main.data.length, main.info.width, main.info.height]);
  return `/media/${id}.webp`;
}

const describe = (name, short, kind) => ({
  incense: `${name} is a superior quality incense made from natural herbs, resins and essential oils. It creates a calm and divine atmosphere, ideal for daily worship, meditation and festive occasions.`,
  brass: `Beautiful traditional ${name.toLowerCase()}, perfect for daily pooja and festive occasions. Made from high quality brass with a fine finish that lasts for years.`,
  flowers: `${name} sourced fresh every morning from local farms around Tirupati. ${short}, carefully packed so they reach your home altar fresh.`,
  powder: `${name} prepared the traditional way for daily pooja, tilak and auspicious occasions. ${short} and long lasting.`,
  kit: `${name} brings together every essential you need for the pooja in one box — carefully selected, authentic items so you never miss a thing.`,
  essentials: `${name} for your everyday pooja. ${short}, selected for quality and purity.`,
}[kind]);

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ...databaseSslOptions() });
await client.connect();
try {
  const existing = await client.query('SELECT COUNT(*)::integer AS count FROM products');
  if (existing.rows[0].count > 0 && !process.argv.includes('--force')) {
    console.log('Products already exist; skipping demo catalogue (use --force to add anyway).');
  } else {
    await client.query('BEGIN');
    const categoryIds = {};
    for (const [index, category] of categories.entries()) {
      const image = await storeImage(client, category.image);
      const row = await client.query(
        `INSERT INTO categories (name, slug, image_url, sort_order, is_active) VALUES ($1, $2, $3, $4, TRUE)
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, image_url = EXCLUDED.image_url RETURNING id`,
        [category.name, category.slug, image, index + 1]);
      categoryIds[category.slug] = row.rows[0].id;
      for (const [childIndex, [slug, name]] of category.children.entries()) {
        const child = await client.query(
          `INSERT INTO categories (name, slug, parent_category_id, sort_order, is_active) VALUES ($1, $2, $3, $4, TRUE)
           ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, parent_category_id = EXCLUDED.parent_category_id RETURNING id`,
          [name, slug, row.rows[0].id, childIndex + 1]);
        categoryIds[slug] = child.rows[0].id;
      }
    }
    for (const [slug, name, short, category, subcategory, price, mrp, gst, hsn, stock, min, image, kind, featured, weight, variants = []] of products) {
      const url = await storeImage(client, image);
      const created = await client.query(
        `INSERT INTO products (category_id, subcategory_id, sku, slug, name, short_description, description, price_paise, mrp_paise, gst_rate_basis_points,
                               hsn_code, minimum_stock_level, weight_grams, highlights, is_featured, image_url, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,TRUE) ON CONFLICT (slug) DO NOTHING RETURNING id`,
        [categoryIds[category], subcategory ? categoryIds[subcategory] : null, slug.toUpperCase().slice(0, 40), slug, name, short, describe(name, short, kind),
          price * 100, mrp * 100, gst * 100, hsn, min, weight, highlights[kind], featured, url]);
      if (!created.rowCount) continue;
      const productId = created.rows[0].id;
      await client.query('INSERT INTO product_images (product_id, image_url, alt_text, sort_order) VALUES ($1, $2, $3, 0)', [productId, url, name]);
      await client.query('INSERT INTO inventory (product_id, quantity) VALUES ($1, $2)', [productId, variants.length ? 0 : stock]);
      if (!variants.length && stock > 0) await client.query(`INSERT INTO inventory_movements (product_id, quantity_delta, reason) VALUES ($1, $2, 'initial_stock')`, [productId, stock]);
      for (const [index, [label, sku, vPrice, vMrp, vStock]] of variants.entries()) {
        const variant = await client.query(
          `INSERT INTO product_variants (product_id, label, sku, price_paise, mrp_paise, quantity, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [productId, label, sku, vPrice * 100, vMrp * 100, vStock, index]);
        await client.query(`INSERT INTO inventory_movements (product_id, variant_id, quantity_delta, reason) VALUES ($1, $2, $3, 'initial_stock')`, [productId, variant.rows[0].id, vStock]);
      }
    }
    const zone = await client.query(
      `INSERT INTO delivery_zones (name, postal_codes, delivery_fee_paise, minimum_order_paise, estimated_minutes, is_active, cod_enabled, cod_limit_paise)
       SELECT 'Tirupati City', ARRAY['517501','517502','517503','517504','517505','517506','517507','517520'], 3000, 9900, 30, TRUE, TRUE, 200000
        WHERE NOT EXISTS (SELECT 1 FROM delivery_zones WHERE name = 'Tirupati City') RETURNING id`);
    if (zone.rowCount) {
      const slots = [['Deliver Now', '06:00', '21:30', false, 0], ['Morning', '07:00', '10:00', true, 1], ['Afternoon', '12:00', '15:00', true, 2], ['Evening', '17:00', '20:00', true, 3]];
      for (const [name, start, end, scheduled, order] of slots) {
        await client.query(`INSERT INTO delivery_time_slots (zone_id, name, starts_at, ends_at, is_scheduled, is_active, sort_order) VALUES (NULL, $1, $2, $3, $4, TRUE, $5) ON CONFLICT DO NOTHING`, [name, start, end, scheduled, order]);
      }
    }
    await client.query('COMMIT');
    console.log(`Seeded ${categories.length} categories, ${products.length} products, delivery zone and slots. Media stored in ${mediaDir}.`);
    console.log("Next: create an admin with  pnpm --filter @sac/api staff:grant -- 9000000000 admin  (it prints a temporary password).");
  }
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('Seeding failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await client.end();
}
