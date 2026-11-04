import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { searchTerms } from '../src/catalog/search.js';
import { createHarness, skipReason, type Harness } from './support/harness.js';

describe('search terms', () => {
  it('lower-cases, singularises and strips punctuation so no SQL metacharacters remain', () => {
    assert.deepEqual(searchTerms('  Brass  DIYAS ').words, ['brass', 'diya']);
    assert.deepEqual(searchTerms("100% kumkum_'; DROP").words, ['100', 'kumkum', 'drop']);
    assert.deepEqual(searchTerms('glass').words, ['glass'], 'double-s words keep their s');
  });
});

describe('search relevance (integration)', { skip: skipReason }, () => {
  let h: Harness;
  const names = async (q: string) => {
    const response = await h.request('GET', `/api/v1/products?q=${encodeURIComponent(q)}`);
    assert.equal(response.status, 200, response.body);
    return { exact: response.json.data.map((p: { name: string }) => p.name) as string[], similar: response.json.similar.map((p: { name: string }) => p.name) as string[] };
  };
  before(async () => {
    h = await createHarness();
    const essentials = await h.seed.category('Pooja Essentials');
    const kumkumHaldi = await h.seed.category('Kumkum & Haldi');
    const flowers = await h.seed.category('Flowers');
    const product = async (name: string, categoryId: string, description = 'Traditional item for daily pooja.') => {
      const created = await h.seed.product({ categoryId, price: 5000, stock: 5, name });
      await h.pool.query('UPDATE products SET description = $2 WHERE id = $1', [created.id, description]);
    };
    await product('Brass Diya', essentials);
    await product('Diya Stand Large', essentials);
    await product('Cotton Wicks', essentials, 'Soft cotton wicks for your diya and lamps.');
    await product('Pooja Matchbox', essentials, 'Light the diya safely.');
    await product('Premium Kumkum', kumkumHaldi);
    await product('Organic Haldi', kumkumHaldi);
    await product('Rose Petals', flowers, 'Fresh petals to place near the diya.');
    const discounted = await h.seed.product({ categoryId: flowers, price: 5000, mrp: 7000, stock: 5, name: 'Discounted Flower Plate' });
    await h.pool.query('UPDATE products SET is_featured = TRUE WHERE id = $1', [discounted.id]);
    await h.seed.product({ categoryId: flowers, price: 9000, mrp: 9000, stock: 0, name: 'Out Of Stock Flower Bowl' });
    const variantDiscount = await h.seed.product({ categoryId: flowers, price: 10000, stock: 0, name: 'Discounted Variant Plate' });
    const discountedVariant = await h.seed.variant(variantDiscount.id, { label: 'Small', price: 5000, stock: 2 });
    await h.pool.query('UPDATE product_variants SET mrp_paise = 7000 WHERE id = $1', [discountedVariant]);
    const variantNoDiscount = await h.seed.product({ categoryId: flowers, price: 10000, stock: 0, name: 'Regular Variant Plate' });
    const regularVariant = await h.seed.variant(variantNoDiscount.id, { label: 'Small', price: 5000, stock: 2 });
    await h.pool.query('UPDATE product_variants SET mrp_paise = 5000 WHERE id = $1', [regularVariant]);
    const saleVariant = await h.seed.variant(variantNoDiscount.id, { label: 'Large', price: 7000, stock: 2 });
    await h.pool.query('UPDATE product_variants SET mrp_paise = 9000 WHERE id = $1', [saleVariant]);
  });
  after(async () => { await h?.close(); });

  it('shows exact name matches first, best match on top, and ignores mere mentions in descriptions', async () => {
    const { exact, similar } = await names('diya');
    assert.deepEqual(exact, ['Diya Stand Large', 'Brass Diya'], 'a name starting with the query ranks above a name containing it');
    assert.ok(!exact.includes('Cotton Wicks') && !exact.includes('Rose Petals'), 'description mentions are not matches');
    assert.ok(similar.includes('Cotton Wicks'), 'same-category items appear as similar');
    assert.ok(!similar.includes('Rose Petals') && !similar.includes('Premium Kumkum'), 'unrelated categories never appear');
    assert.ok(similar.length <= 6, 'the similar list is short');
  });

  it('matches plurals, multiple words in any order, and typos', async () => {
    assert.deepEqual((await names('diyas')).exact.sort(), ['Brass Diya', 'Diya Stand Large']);
    assert.deepEqual((await names('diya brass')).exact, ['Brass Diya']);
    const typo = await names('diyaa');
    assert.deepEqual(typo.exact, []);
    assert.ok(typo.similar.includes('Brass Diya'), 'close spellings are offered as similar');
  });

  it('category words: products by name first, siblings as similar; an exact category name lists the category', async () => {
    const kumkum = await names('kumkum');
    assert.deepEqual(kumkum.exact, ['Premium Kumkum']);
    assert.deepEqual(kumkum.similar, ['Organic Haldi']);
    const category = await names('pooja essentials');
    assert.ok(['Brass Diya', 'Cotton Wicks', 'Diya Stand Large', 'Pooja Matchbox'].every(name => category.exact.includes(name)));
    assert.ok(!category.exact.includes('Rose Petals'));
  });

  it('returns nothing for unrelated words and is safe with odd input', async () => {
    assert.deepEqual(await names('xyzzy'), { exact: [], similar: [] });
    const countBefore = Number((await h.pool.query('SELECT COUNT(*) FROM products')).rows[0].count);
    for (const q of ["'; DROP TABLE products; --", '%%%', '\\', '((', 'a'.repeat(200)]) {
      const response = await h.request('GET', `/api/v1/products?q=${encodeURIComponent(q.slice(0, 100))}`);
      assert.ok(response.status < 500, `${q} → ${response.status}`);
    }
    assert.equal(Number((await h.pool.query('SELECT COUNT(*) FROM products')).rows[0].count), countBefore, 'odd search input must not modify the product table');
  });


  it('applies price, availability, featured and discount filters to product results', async () => {
    const slug = (await h.pool.query("SELECT slug FROM categories WHERE name = 'Flowers' LIMIT 1")).rows[0].slug as string;
    const discounted = await h.request('GET', `/api/v1/products?category=${slug}&discount_only=true`);
    assert.equal(discounted.status, 200, discounted.body);
    assert.deepEqual(discounted.json.data.map((item: { name: string }) => item.name).sort(), ['Discounted Flower Plate', 'Discounted Variant Plate'].sort());
    assert.ok(!discounted.json.data.some((item: { name: string }) => item.name === 'Regular Variant Plate'), 'a discount on a more expensive variant must not mark the displayed cheapest variant as discounted');

    const featured = await h.request('GET', `/api/v1/products?category=${slug}&featured=true`);
    assert.equal(featured.status, 200, featured.body);
    assert.deepEqual(featured.json.data.map((item: { name: string }) => item.name), ['Discounted Flower Plate']);

    const available = await h.request('GET', `/api/v1/products?category=${slug}&in_stock=true&min_price=5000&max_price=5000`);
    assert.equal(available.status, 200, available.body);
    assert.ok(available.json.data.every((item: { name: string }) => item.name !== 'Out Of Stock Flower Bowl'));
  });

  it('scopes filter facets to the same exact search result set', async () => {
    const kumkum = await h.request('GET', '/api/v1/products/filters?q=kumkum');
    assert.equal(kumkum.status, 200, kumkum.body);
    assert.equal(kumkum.json.data.counts.total, 1);
    assert.equal(kumkum.json.data.price_min_paise, 5000);
    assert.equal(kumkum.json.data.price_max_paise, 5000);

    const category = await h.request('GET', '/api/v1/products/filters?q=pooja%20essentials');
    assert.equal(category.status, 200, category.body);
    assert.equal(category.json.data.counts.total, 4);

    const diya = await h.request('GET', '/api/v1/products/filters?q=diya');
    assert.equal(diya.status, 200, diya.body);
    assert.equal(diya.json.data.counts.total, 2);
  });

  it('rejects malformed facet queries without executing them', async () => {
    const tooLong = await h.request('GET', `/api/v1/products/filters?q=${'a'.repeat(101)}`);
    assert.equal(tooLong.status, 400);
    const countBefore = Number((await h.pool.query('SELECT COUNT(*) FROM products')).rows[0].count);
    const odd = await h.request('GET', `/api/v1/products/filters?q=${encodeURIComponent("'; DROP TABLE products; --")}`);
    assert.equal(odd.status, 200, odd.body);
    assert.equal(Number((await h.pool.query('SELECT COUNT(*) FROM products')).rows[0].count), countBefore, 'malformed facet input must not modify the product table');
  });

  it('suggestions use the same ranking', async () => {
    const suggest = (await h.request('GET', '/api/v1/search/suggest?q=kum')).json.data;
    assert.deepEqual(suggest.products.map((p: { name: string }) => p.name), ['Premium Kumkum']);
    assert.deepEqual(suggest.categories.map((c: { name: string }) => c.name), ['Kumkum & Haldi']);
  });
});

describe('catalogue filters and facets (integration)', { skip: skipReason }, () => {
  let h: Harness;
  let lampsSlug = '';
  const list = async (query: string) => {
    const response = await h.request('GET', `/api/v1/products?${query}`);
    assert.equal(response.status, 200, response.body);
    return (response.json.data as Array<{ name: string }>).map(p => p.name).sort();
  };
  before(async () => {
    h = await createHarness();
    const lamps = await h.seed.category('Lamps');
    lampsSlug = (await h.pool.query<{ slug: string }>('SELECT slug FROM categories WHERE id = $1', [lamps])).rows[0]!.slug;
    const other = await h.seed.category('Incense');
    await h.seed.product({ categoryId: lamps, name: 'Sale Lamp', price: 8000, mrp: 10000, stock: 4 });
    await h.seed.product({ categoryId: lamps, name: 'Full Price Lamp', price: 12000, stock: 2 });
    await h.seed.product({ categoryId: lamps, name: 'Sold Out Lamp', price: 3000, mrp: 3500, stock: 0 });
    const featured = await h.seed.product({ categoryId: other, name: 'Featured Incense', price: 2000, stock: 9 });
    await h.pool.query('UPDATE products SET is_featured = TRUE WHERE id = $1', [featured.id]);
  });
  after(async () => { await h?.close(); });

  it('discount_only returns exactly the products priced below MRP', async () => {
    assert.deepEqual(await list('discount_only=true'), ['Sale Lamp', 'Sold Out Lamp']);
    assert.deepEqual(await list(`category=${lampsSlug}&discount_only=true&in_stock=true`), ['Sale Lamp']);
    // discount_only=false is a no-op, not an inverse filter.
    assert.equal((await list('discount_only=false')).length, 4);
    const invalid = await h.request('GET', '/api/v1/products?discount_only=yes');
    assert.equal(invalid.status, 400);
  });

  it('category facets agree with the filtered listings', async () => {
    const facets = await h.request('GET', `/api/v1/products/filters?category=${lampsSlug}`);
    assert.equal(facets.status, 200, facets.body);
    const { counts, price_min_paise, price_max_paise } = facets.json.data;
    assert.equal(counts.total, (await list(`category=${lampsSlug}`)).length);
    assert.equal(counts.discounted, (await list(`category=${lampsSlug}&discount_only=true`)).length);
    assert.equal(counts.in_stock, (await list(`category=${lampsSlug}&in_stock=true`)).length);
    assert.equal(counts.featured, 0);
    assert.equal(price_min_paise, 3000);
    assert.equal(price_max_paise, 12000);
  });

  it('global facets include every visible product and reject invalid category slugs', async () => {
    const all = await h.request('GET', '/api/v1/products/filters');
    assert.equal(all.status, 200, all.body);
    assert.equal(all.json.data.counts.total, 4);
    assert.equal(all.json.data.counts.featured, 1);
    const bad = await h.request('GET', '/api/v1/products/filters?category=Not%20A%20Slug');
    assert.equal(bad.status, 400);
    const unknown = await h.request('GET', '/api/v1/products/filters?category=no-such-category');
    assert.equal(unknown.status, 200);
    assert.equal(unknown.json.data.counts.total, 0);
  });
});
