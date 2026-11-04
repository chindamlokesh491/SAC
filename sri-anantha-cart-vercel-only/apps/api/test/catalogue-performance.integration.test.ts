import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createHarness, skipReason, type Harness } from './support/harness.js';

describe('product sales summary and cursor pagination (integration)', { skip: skipReason }, () => {
  let h: Harness;
  let categoryId: string;
  before(async () => {
    h = await createHarness();
    categoryId = await h.seed.category('Lamps');
    await h.seed.zone();
  });
  after(async () => { await h?.close(); });

  const summary = async (productId: string) => {
    const row = await h.pool.query('SELECT units_total, units_90d, revenue_total_paise FROM product_sales_summary WHERE product_id = $1', [productId]);
    return row.rows[0] ? { total: Number(row.rows[0].units_total), recent: Number(row.rows[0].units_90d), revenue: Number(row.rows[0].revenue_total_paise) } : { total: 0, recent: 0, revenue: 0 };
  };

  it('counts placed orders, removes cancelled ones, and matches a full rebuild', async () => {
    const lamp = await h.seed.product({ categoryId, price: 10000, stock: 50, name: 'Summary Lamp' });
    const customer = await h.login('9800000101');
    const admin = await h.login('9800000102', 'admin');
    const address = await h.seed.address(customer.token);

    const first = await h.placeOrder(customer.token, address, [{ product_id: lamp.id, quantity: 3 }]);
    assert.equal(first.status, 201, first.body);
    assert.deepEqual(await summary(lamp.id), { total: 3, recent: 3, revenue: 30000 });

    const second = await h.placeOrder(customer.token, address, [{ product_id: lamp.id, quantity: 2 }]);
    assert.equal(second.status, 201, second.body);
    assert.equal((await summary(lamp.id)).total, 5);

    // Moving between counted states changes nothing; leaving them removes the sale exactly once.
    const orderId = second.json.data.order_id;
    assert.equal((await h.request('PATCH', `/api/v1/admin/orders/${orderId}/status`, { token: admin.token, body: { status: 'accepted' } })).status, 200);
    assert.equal((await summary(lamp.id)).total, 5);
    const cancelled = await h.request('POST', `/api/v1/admin/orders/${orderId}/cancel`, { token: admin.token, body: { reason: 'Customer changed their mind' } });
    assert.equal(cancelled.status, 200, cancelled.body);
    assert.deepEqual(await summary(lamp.id), { total: 3, recent: 3, revenue: 30000 });

    // The incremental figures equal a recomputation from order history.
    const before = await h.pool.query('SELECT product_id, units_total, units_90d, revenue_total_paise FROM product_sales_summary ORDER BY product_id');
    await h.pool.query('SELECT rebuild_product_sales()');
    const rebuilt = await h.pool.query('SELECT product_id, units_total, units_90d, revenue_total_paise FROM product_sales_summary ORDER BY product_id');
    assert.deepEqual(rebuilt.rows, before.rows);
  });

  it('the 90-day window drops old sales on refresh while lifetime totals stay', async () => {
    const old = await h.seed.product({ categoryId, price: 5000, stock: 10, name: 'Old Seller' });
    await h.pool.query(`INSERT INTO product_sales_daily (product_id, sales_date, units, revenue_paise) VALUES ($1, current_date - 120, 7, 35000)`, [old.id]);
    await h.pool.query(`INSERT INTO product_sales_summary (product_id, units_total, units_90d, revenue_total_paise) VALUES ($1, 7, 7, 35000)`, [old.id]);
    await h.pool.query('SELECT refresh_product_sales_summary()');
    assert.deepEqual(await summary(old.id), { total: 7, recent: 0, revenue: 35000 });
  });

  it('cursor pages cover every product exactly once, in the same order as one big page', async () => {
    for (let i = 0; i < 9; i++) await h.seed.product({ categoryId, price: 1000 + (i % 3) * 100, stock: 5, name: `Cursor Item ${String.fromCharCode(65 + i)}` });
    for (const sort of ['popular', 'newest', 'price_asc', 'price_desc', 'name_asc']) {
      const all = await h.request('GET', `/api/v1/products?category=lamps&sort=${sort}&limit=48`);
      assert.equal(all.status, 200, all.body);
      const expected = all.json.data.map((p: { id: string }) => p.id);
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: { status: number; body: string; json: any } = await h.request('GET', `/api/v1/products?category=lamps&sort=${sort}&limit=4${cursor ? `&cursor=${cursor}` : ''}`);
        assert.equal(page.status, 200, page.body);
        seen.push(...page.json.data.map((p: { id: string }) => p.id));
        cursor = page.json.pagination.next_cursor;
      } while (cursor && seen.length < 100);
      assert.deepEqual(seen, expected, `${sort}: cursor pages match`);
    }
  });

  it('rejects tampered cursors and cursors on best-match search', async () => {
    assert.equal((await h.request('GET', '/api/v1/products?cursor=bm90LWEtY3Vyc29y')).status, 400);
    const forged = Buffer.from(JSON.stringify(['popular', "1; DROP TABLE products", true, 'x', 'y'])).toString('base64url');
    assert.equal((await h.request('GET', `/api/v1/products?cursor=${forged}`)).status, 400);
    const page = await h.request('GET', '/api/v1/products?limit=1');
    assert.equal((await h.request('GET', `/api/v1/products?q=lamp&cursor=${page.json.pagination.next_cursor}`)).status, 400);
  });

  it('the home page never sorts the catalogue with random()', async () => {
    const statements: string[] = [];
    const original = h.appPool.query.bind(h.appPool);
    (h.appPool as any).query = (text: any, ...rest: any[]) => { statements.push(typeof text === 'string' ? text : text.text); return (original as any)(text, ...rest); };
    try { assert.equal((await h.request('GET', '/api/v1/home')).status, 200); } finally { (h.pool as any).query = original; }
    assert.ok(statements.length > 0, 'queries were captured');
    assert.deepEqual(statements.filter(sql => /random\(\)/i.test(sql)), [], 'no ORDER BY random()');
    assert.deepEqual(statements.filter(sql => /FROM order_items/i.test(sql)), [], 'catalogue reads never aggregate order_items');
  });
});
