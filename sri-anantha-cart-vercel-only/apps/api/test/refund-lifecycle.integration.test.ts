import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createHarness, skipReason, type Harness } from './support/harness.js';

/** Refund lifecycle for a delivered (paid) order: idempotency, caps, failure and retry, final states, permissions. */
describe('refund lifecycle (integration)', { skip: skipReason }, () => {
  let h: Harness;
  let admin: { token: string; userId: string };
  let orderId = '';
  let total = 0;
  const refund = (key: string, amount: number, reason = 'Damaged lamp refund', token = admin.token) =>
    h.request('POST', `/api/v1/admin/orders/${orderId}/refunds`, { token, headers: { 'idempotency-key': key }, body: { amount_paise: amount, reason } });
  const setStatus = (id: string, status: string) => h.request('PATCH', `/api/v1/admin/refunds/${id}/status`, { token: admin.token, body: { status } });
  const refundRows = async () => (await h.pool.query<{ status: string; amount_paise: number }>('SELECT status, amount_paise FROM refunds WHERE order_id = $1 ORDER BY created_at', [orderId])).rows;

  before(async () => {
    h = await createHarness();
    admin = await h.login('9100000601', 'admin');
    const categoryId = await h.seed.category();
    await h.seed.zone({ postal: ['517501'], cod: true });
    const customer = await h.login('9100000602');
    const product = await h.seed.product({ categoryId, price: 20000, stock: 5 });
    const address = await h.seed.address(customer.token);
    const placed = await h.placeOrder(customer.token, address, [{ product_id: product.id, quantity: 1 }]);
    orderId = placed.json.data.order_id as string;
    for (const status of ['accepted', 'packed', 'dispatched', 'delivered'] as const) assert.equal((await h.fulfil(orderId, status, admin)).status, 200, status);
    total = Number((await h.pool.query('SELECT total_paise FROM orders WHERE id = $1', [orderId])).rows[0].total_paise);
  });
  after(async () => { await h?.close(); });

  it('only admins can record refunds, and an idempotency key is required', async () => {
    const operator = await h.login('9100000603', 'operator');
    assert.equal((await refund('refund-op-0001', 1000, 'Operator attempt', operator.token)).status, 403);
    const noKey = await h.request('POST', `/api/v1/admin/orders/${orderId}/refunds`, { token: admin.token, body: { amount_paise: 1000, reason: 'No key' } });
    assert.equal(noKey.status, 400);
    assert.equal(noKey.json.error, 'IDEMPOTENCY_KEY_REQUIRED');
    assert.deepEqual(await refundRows(), []);
  });

  it('a retried request with the same key never creates a second refund', async () => {
    const first = await refund('refund-key-0001', 5000);
    assert.equal(first.status, 201, first.body);
    assert.equal(first.json.data.method, 'manual', 'gateway refunds stay disabled (RAZORPAY_REFUNDS_ENABLED unset)');
    const replay = await refund('refund-key-0001', 5000);
    assert.equal(replay.status, 200);
    assert.equal(replay.json.data.id, first.json.data.id);
    const reused = await refund('refund-key-0001', 6000);
    assert.equal(reused.status, 409);
    assert.equal(reused.json.error, 'IDEMPOTENCY_KEY_REUSED');
    assert.equal((await refundRows()).length, 1);
  });

  it('outstanding refunds cannot exceed the order total', async () => {
    const tooMuch = await refund('refund-key-0002', total - 5000 + 1);
    assert.equal(tooMuch.status, 409);
    assert.equal(tooMuch.json.error, 'REFUND_EXCEEDS_ORDER_TOTAL');
  });

  it('a failed refund is final, frees its amount, and can be retried with a new request', async () => {
    const [pending] = (await h.pool.query<{ id: string }>(`SELECT id FROM refunds WHERE order_id = $1`, [orderId])).rows;
    assert.equal((await setStatus(pending!.id, 'failed')).status, 200);
    const again = await setStatus(pending!.id, 'completed');
    assert.equal(again.status, 409);
    assert.equal(again.json.error, 'REFUND_ALREADY_FINAL');

    const retry = await refund('refund-key-0003', total);
    assert.equal(retry.status, 201, 'the failed amount no longer counts against the cap');
    assert.equal((await setStatus(retry.json.data.id, 'completed')).status, 200);
    const order = (await h.pool.query<{ payment_status: string }>('SELECT payment_status FROM orders WHERE id = $1', [orderId])).rows[0]!;
    assert.equal(order.payment_status, 'refunded');
    assert.deepEqual((await refundRows()).map(row => row.status), ['failed', 'completed']);
    const extra = await refund('refund-key-0004', 100);
    assert.equal(extra.status, 409, 'nothing more can be refunded once the total is refunded');

    const audits = (await h.pool.query<{ action: string }>(`SELECT action FROM admin_audit_logs WHERE resource_id = $1 OR (resource_type = 'refund')`, [orderId])).rows.map(row => row.action);
    assert.ok(audits.includes('refund.recorded') && audits.includes('refund.status_changed'));
  });
});
