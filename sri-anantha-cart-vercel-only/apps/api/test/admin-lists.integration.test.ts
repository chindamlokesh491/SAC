import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createHarness, skipReason, type Harness } from './support/harness.js';

/** Results of the paged admin order and customer lists (queries rewritten for deep-page performance). */
describe('admin order and customer lists (integration)', { skip: skipReason }, () => {
  let h: Harness;
  let admin: { token: string; userId: string };
  const orders: { id: string; number: number; display: string }[] = [];
  let buyerId = '';

  before(async () => {
    h = await createHarness();
    admin = await h.login('9100000701', 'admin');
    const categoryId = await h.seed.category();
    await h.seed.zone({ postal: ['517501'], cod: true });
    const product = await h.seed.product({ categoryId, price: 10000, stock: 50 });
    const buyer = await h.login('9100000702');
    buyerId = buyer.userId;
    await h.request('PATCH', '/api/v1/me', { token: buyer.token, body: { display_name: 'Lakshmi Devi' } });
    const address = await h.seed.address(buyer.token);
    for (const quantity of [1, 2, 3]) {
      const placed = await h.placeOrder(buyer.token, address, [{ product_id: product.id, quantity }]);
      assert.equal(placed.status, 201, placed.body);
      const row = (await h.pool.query<{ order_number: number }>('SELECT order_number FROM orders WHERE id = $1', [placed.json.data.order_id])).rows[0]!;
      orders.push({ id: placed.json.data.order_id, number: row.order_number, display: `SA${row.order_number + 10_000}` });
    }
    for (const status of ['accepted', 'packed', 'dispatched', 'delivered'] as const) await h.fulfil(orders[0]!.id, status, admin);
    await h.login('9100000703'); // a customer with no orders
  });
  after(async () => { await h?.close(); });

  it('pages orders newest first with correct item counts', async () => {
    const list = (path: string) => h.request('GET', path, { token: admin.token });
    const page1 = await list('/api/v1/admin/orders?limit=2&offset=0');
    assert.equal(page1.status, 200, page1.body);
    assert.equal(page1.json.pagination.total, 3);
    assert.deepEqual(page1.json.data.map((o: { id: string }) => o.id), [orders[2]!.id, orders[1]!.id]);
    assert.deepEqual(page1.json.data.map((o: { item_count: number }) => o.item_count), [3, 2]);
    const page2 = await list('/api/v1/admin/orders?limit=2&offset=2');
    assert.deepEqual(page2.json.data.map((o: { id: string; item_count: number }) => [o.id, o.item_count]), [[orders[0]!.id, 1]]);
    assert.deepEqual((await list('/api/v1/admin/orders?limit=2&offset=50')).json.data, []);
  });

  it('finds an order by its reference exactly, and bare digits still search phone numbers', async () => {
    const search = async (term: string) => (await h.request('GET', `/api/v1/admin/orders?search=${encodeURIComponent(term)}`, { token: admin.token })).json.data.map((o: { id: string }) => o.id);
    assert.deepEqual(await search(orders[1]!.display), [orders[1]!.id]);
    assert.deepEqual(await search(`#${orders[1]!.number + 10_000}`), [orders[1]!.id]);
    assert.deepEqual(await search(orders[1]!.display.toLowerCase()), [orders[1]!.id]);
    assert.equal((await search('91000007020')).length, 0, 'not a valid reference and not a phone fragment');
    assert.equal((await search('00702')).length, 3, 'bare digits match the customer phone');
    assert.equal((await search('Lakshmi')).length, 3);
  });

  it('shows the audit trail to admins only, filtered by order reference, action and actor', async () => {
    const audit = (query: string, token = admin.token) => h.request('GET', `/api/v1/admin/audit-logs?${query}`, { token });
    const operator = await h.login('9100000704', 'operator');
    assert.equal((await audit('', operator.token)).status, 403);
    const customer = await h.login('9100000705');
    assert.equal((await audit('', customer.token)).status, 403);

    const forOrder = await audit(`resource=${orders[0]!.display}`);
    assert.equal(forOrder.status, 200, forOrder.body);
    const actions = forOrder.json.data.map((entry: { action: string }) => entry.action);
    for (const action of ['order.status_changed', 'delivery_assignment.accepted', 'delivery.picked_up', 'order.delivery_otp_verified', 'order.cod_collected']) {
      assert.ok(actions.includes(action), `${action} in ${actions.join(',')}`);
    }
    assert.ok(forOrder.json.data.every((entry: { resource_id: string }) => entry.resource_id === orders[0]!.id));
    assert.equal(forOrder.json.data[0].order_display_number, orders[0]!.display);
    const accepted = forOrder.json.data.find((entry: { action: string; metadata: { to?: string } }) => entry.action === 'order.status_changed' && entry.metadata.to === 'accepted');
    assert.equal(accepted.actor.phone, '+919100000701', 'the admin who accepted the order is shown');
    const times = forOrder.json.data.map((entry: { created_at: string }) => Date.parse(entry.created_at));
    assert.deepEqual(times, [...times].sort((a, b) => b - a), 'newest first');

    const prefix = await audit('action=order.&limit=100');
    assert.ok(prefix.json.data.length > 0 && prefix.json.data.every((entry: { action: string }) => entry.action.startsWith('order.')));
    const delivery = await audit('action=delivery*&limit=100');
    const deliveryActions = new Set(delivery.json.data.map((entry: { action: string }) => entry.action.split('.')[0]));
    assert.ok(deliveryActions.has('delivery') && deliveryActions.has('delivery_assignment') && deliveryActions.size === 2, [...deliveryActions].join(','));
    const exact = await audit(`action=order.cod_collected&resource=${orders[0]!.id}`);
    assert.equal(exact.json.data.length, 1);
    const byActor = await audit('actor=9100000701&limit=100');
    assert.ok(byActor.json.data.length > 0 && byActor.json.data.every((entry: { actor: { phone: string } }) => entry.actor.phone === '+919100000701'));
    assert.equal((await audit("action=order';drop")).status, 400);
    assert.equal((await audit('resource=SA99999999')).json.data.length, 0);
    const page = await audit('limit=2&offset=0');
    assert.equal(page.json.data.length, 2);
    assert.equal(page.json.pagination.total, Number((await h.pool.query('SELECT count(*) AS n FROM admin_audit_logs')).rows[0].n));
  });

  it('lists customers with per-customer order statistics', async () => {
    const result = await h.request('GET', '/api/v1/admin/customers?limit=10', { token: admin.token });
    assert.equal(result.status, 200, result.body);
    const buyer = result.json.data.find((c: { id: string }) => c.id === buyerId);
    assert.equal(buyer.order_count, 3);
    const paid = Number((await h.pool.query(`SELECT COALESCE(SUM(total_paise), 0) AS s FROM orders WHERE user_id = $1 AND payment_status = 'paid'`, [buyerId])).rows[0].s);
    assert.ok(paid > 0);
    assert.equal(Number(buyer.total_spent_paise), paid);
    assert.ok(buyer.last_order_at);
    const idle = result.json.data.find((c: { phone_e164: string }) => c.phone_e164 === '+919100000703');
    assert.deepEqual([idle.order_count, Number(idle.total_spent_paise), idle.last_order_at], [0, 0, null]);
    assert.ok(result.json.data.every((c: { phone_e164: string }) => !['+919100000701'].includes(c.phone_e164)), 'staff are not listed as customers');
    const created = result.json.data.map((c: { created_at: string }) => Date.parse(c.created_at));
    assert.deepEqual(created, [...created].sort((a, b) => b - a), 'newest customers first');
  });
});
