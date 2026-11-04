import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import sharp from 'sharp';
import { createHarness, skipReason, type Harness } from './support/harness.js';

/** Featured limits, category deletion and permanent product deletion. */
describe('admin catalogue rules (integration)', { skip: skipReason }, () => {
  let h: Harness;
  let admin: { token: string; userId: string };
  let category: string;
  before(async () => {
    h = await createHarness();
    admin = await h.login('9500000001', 'admin');
    category = await h.seed.category('Lamps');
    await h.seed.zone({ postal: ['517501'] });
  });
  after(async () => { await h?.close(); });

  const upload = async () => {
    const boundary = `----sac${randomUUID().replaceAll('-', '')}`;
    const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#e5781c' } }).png().toBuffer();
    const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`), png, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const response = await h.app.inject({ method: 'POST', url: '/api/v1/admin/media', headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${admin.token}` }, payload });
    return JSON.parse(response.body).data.url as string;
  };

  describe('featured limit of 8', () => {
    it('refuses a 9th featured product, reports the count, and frees a place when one is removed', async () => {
      const products = await Promise.all(Array.from({ length: 10 }, () => h.seed.product({ categoryId: category, price: 1000, stock: 5 })));
      for (const product of products.slice(0, 8)) {
        assert.equal((await h.request('PATCH', `/api/v1/admin/products/${product.id}`, { token: admin.token, body: { is_featured: true } })).status, 200);
      }
      const ninth = await h.request('PATCH', `/api/v1/admin/products/${products[8]!.id}`, { token: admin.token, body: { is_featured: true } });
      assert.equal(ninth.status, 409);
      assert.equal(ninth.json.error, 'FEATURED_LIMIT');
      assert.match(ninth.json.message, /cannot feature more than 8 products/);
      assert.deepEqual((await h.request('GET', '/api/v1/admin/products?limit=1', { token: admin.token })).json.featured, { count: 8, limit: 8 });
      assert.equal((await h.request('PATCH', `/api/v1/admin/products/${products[0]!.id}`, { token: admin.token, body: { is_featured: false } })).status, 200);
      assert.equal((await h.request('PATCH', `/api/v1/admin/products/${products[8]!.id}`, { token: admin.token, body: { is_featured: true } })).status, 200);
      await h.pool.query('UPDATE products SET is_featured = FALSE');
    });

    it('holds under concurrent requests and even for direct database writes', async () => {
      const products = await Promise.all(Array.from({ length: 12 }, () => h.seed.product({ categoryId: category, price: 1000, stock: 5 })));
      const results = await Promise.all(products.map(product => h.request('PATCH', `/api/v1/admin/products/${product.id}`, { token: admin.token, body: { is_featured: true } })));
      assert.equal(results.filter(result => result.status === 200).length, 8);
      assert.equal(Number((await h.pool.query('SELECT COUNT(*) FROM products WHERE is_featured')).rows[0].count), 8);
      await assert.rejects(h.pool.query('UPDATE products SET is_featured = TRUE WHERE NOT is_featured'), /At most 8 products/);
      await h.pool.query('UPDATE products SET is_featured = FALSE');
    });

    it('applies the same limit to categories', async () => {
      const ids = await Promise.all(Array.from({ length: 9 }, (_, index) => h.seed.category(`Featured ${index} ${randomUUID().slice(0, 4)}`)));
      for (const id of ids.slice(0, 8)) assert.equal((await h.request('PATCH', `/api/v1/admin/categories/${id}`, { token: admin.token, body: { is_featured: true } })).status, 200);
      const ninth = await h.request('PATCH', `/api/v1/admin/categories/${ids[8]}`, { token: admin.token, body: { is_featured: true } });
      assert.equal(ninth.status, 409);
      assert.match(ninth.json.message, /cannot feature more than 8 categories/);
      assert.deepEqual((await h.request('GET', '/api/v1/admin/categories', { token: admin.token })).json.featured, { count: 8, limit: 8 });
      await h.pool.query('UPDATE categories SET is_featured = FALSE');
    });

    it('the home page shows featured items first and fills up to 8 at random', async () => {
      const chosen = await h.seed.product({ categoryId: category, price: 1000, stock: 5, name: 'Chosen Diya' });
      await h.request('PATCH', `/api/v1/admin/products/${chosen.id}`, { token: admin.token, body: { is_featured: true } });
      const featuredCategory = await h.seed.category('Chosen Category');
      await h.seed.product({ categoryId: featuredCategory, price: 1000, stock: 5 });
      await h.request('PATCH', `/api/v1/admin/categories/${featuredCategory}`, { token: admin.token, body: { is_featured: true } });
      const home = (await h.request('GET', '/api/v1/home')).json.data;
      assert.equal(home.popular.length, 8);
      assert.equal(home.popular[0].id, chosen.id, 'featured products come first');
      assert.equal(home.featured_categories[0].id, featuredCategory, 'featured categories come first');
      assert.ok(home.featured_categories.length <= 8);
      assert.ok(home.featured_categories.slice(1).every((item: { product_count: number }) => item.product_count > 0), 'random fill only uses categories that have products');
    });
  });

  describe('deleting categories', () => {
    it('refuses while any product uses the category or subcategory, and when it has subcategories', async () => {
      const parent = await h.seed.category('Parent Cat');
      const child = await h.seed.category('Child Cat', parent);
      const product = await h.seed.product({ categoryId: parent, price: 1000, stock: 1 });
      await h.pool.query('UPDATE products SET subcategory_id = $2 WHERE id = $1', [product.id, child]);
      const blockedChild = await h.request('DELETE', `/api/v1/admin/categories/${child}`, { token: admin.token });
      assert.equal(blockedChild.status, 409);
      assert.equal(blockedChild.json.message, 'Products exists, so it cannot be deleted.');
      await h.pool.query('UPDATE products SET archived_at = now(), is_active = FALSE WHERE id = $1', [product.id]);
      assert.equal((await h.request('DELETE', `/api/v1/admin/categories/${child}`, { token: admin.token })).status, 409, 'archived products still count');
      await h.pool.query('UPDATE products SET subcategory_id = NULL, category_id = $2 WHERE id = $1', [product.id, category]);
      const parentWithChild = await h.request('DELETE', `/api/v1/admin/categories/${parent}`, { token: admin.token });
      assert.equal(parentWithChild.status, 409);
      assert.equal(parentWithChild.json.error, 'CATEGORY_HAS_SUBCATEGORIES');
      assert.equal((await h.request('DELETE', `/api/v1/admin/categories/${child}`, { token: admin.token })).status, 204);
      assert.equal((await h.request('DELETE', `/api/v1/admin/categories/${parent}`, { token: admin.token })).status, 204);
      assert.equal((await h.pool.query('SELECT 1 FROM categories WHERE id = ANY($1)', [[parent, child]])).rowCount, 0);
    });

    it('operators and customers cannot delete categories', async () => {
      const empty = await h.seed.category('Empty Cat');
      const operator = await h.login('9500000002', 'operator');
      const customer = await h.login('9500000003');
      assert.equal((await h.request('DELETE', `/api/v1/admin/categories/${empty}`, { token: operator.token })).status, 403);
      assert.equal((await h.request('DELETE', `/api/v1/admin/categories/${empty}`, { token: customer.token })).status, 403);
    });
  });

  describe('deleting products permanently', () => {
    it('needs the exact name, is refused while an order is open, then removes everything but order history', async () => {
      const image = await upload();
      const product = await h.seed.product({ categoryId: category, price: 15000, stock: 10, name: 'Silver Kalash' });
      await h.pool.query('INSERT INTO product_images (product_id, image_url, sort_order) VALUES ($1, $2, 0)', [product.id, image]);
      await h.pool.query('UPDATE products SET image_url = $2 WHERE id = $1', [product.id, image]);
      const customer = await h.login('9500000010');
      const address = await h.seed.address(customer.token);
      const placed = await h.placeOrder(customer.token, address, [{ product_id: product.id, quantity: 1 }]);
      assert.equal(placed.status, 201, placed.body);
      const orderId = placed.json.data.order_id as string;
      const other = await h.login('9500000011');
      await h.request('POST', '/api/v1/cart/items', { token: other.token, body: { product_id: product.id, quantity: 1 } });
      await h.request('PUT', `/api/v1/wishlist/${product.id}`, { token: other.token });

      const wrongName = await h.request('POST', `/api/v1/admin/products/${product.id}/delete-permanently`, { token: admin.token, body: { confirm_name: 'Silver' } });
      assert.equal(wrongName.status, 400);
      const open = await h.request('POST', `/api/v1/admin/products/${product.id}/delete-permanently`, { token: admin.token, body: { confirm_name: 'Silver Kalash' } });
      assert.equal(open.status, 409);
      assert.equal(open.json.error, 'PRODUCT_IN_OPEN_ORDERS');

      for (const status of ['accepted', 'packed', 'dispatched', 'delivered'] as const) assert.equal((await h.fulfil(orderId, status, admin)).status, 200, status);
      const deleted = await h.request('POST', `/api/v1/admin/products/${product.id}/delete-permanently`, { token: admin.token, body: { confirm_name: 'Silver Kalash' } });
      assert.equal(deleted.status, 200, deleted.body);

      for (const table of ['products', 'inventory', 'product_images', 'product_variants', 'inventory_movements', 'order_inventory_reservations', 'cart_items', 'wishlist_items']) {
        const column = table === 'products' ? 'id' : 'product_id';
        assert.equal((await h.pool.query(`SELECT 1 FROM ${table} WHERE ${column} = $1`, [product.id])).rowCount, 0, `${table} still has rows`);
      }
      assert.equal((await h.request('GET', `/api/v1/products/${product.slug}`)).status, 404);
      assert.equal((await h.request('GET', `/api/v1/admin/products/${product.id}`, { token: admin.token })).status, 404);
      assert.equal((await h.request('GET', '/api/v1/cart', { token: other.token })).json.data.lines.length, 0);
      assert.ok(!(await h.request('GET', '/api/v1/wishlist', { token: other.token })).json.data.product_ids.includes(product.id));

      const order = (await h.request('GET', `/api/v1/orders/${orderId}`, { token: customer.token })).json.data;
      assert.equal(order.items[0].name, 'Silver Kalash', 'the order keeps its own copy');
      assert.equal(order.items[0].unit_price_paise, 15000);
      assert.equal((await h.request('GET', `/api/v1/orders/${orderId}/invoice`, { token: customer.token })).status, 200);
      const file = image.replace('/media/', '');
      assert.equal(existsSync(join(h.mediaDir, file)), true, 'the picture is kept while an old order shows it');
    });

    it('deletes uploaded pictures that nothing uses any more', async () => {
      const image = await upload();
      const product = await h.seed.product({ categoryId: category, price: 1000, stock: 1, name: 'Unused Bell' });
      await h.pool.query('INSERT INTO product_images (product_id, image_url, sort_order) VALUES ($1, $2, 0)', [product.id, image]);
      const deleted = await h.request('POST', `/api/v1/admin/products/${product.id}/delete-permanently`, { token: admin.token, body: { confirm_name: 'Unused Bell' } });
      assert.equal(deleted.json.data.images_removed, 1);
      const file = image.replace('/media/', '');
      assert.equal(existsSync(join(h.mediaDir, file)), false);
      assert.equal(existsSync(join(h.mediaDir, file.replace('.webp', '-sm.webp'))), false);
    });

    it('only admins can delete permanently', async () => {
      const product = await h.seed.product({ categoryId: category, price: 1000, stock: 1, name: 'Guarded' });
      const operator = await h.login('9500000004', 'operator');
      assert.equal((await h.request('POST', `/api/v1/admin/products/${product.id}/delete-permanently`, { token: operator.token, body: { confirm_name: 'Guarded' } })).status, 403);
    });
  });
});
