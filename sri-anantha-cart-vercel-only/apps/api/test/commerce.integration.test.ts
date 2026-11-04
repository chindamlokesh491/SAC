import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import sharp from 'sharp';
import { createHarness, skipReason, type Harness } from './support/harness.js';

const stockOf = async (h: Harness, productId: string) => Number((await h.pool.query('SELECT quantity FROM inventory WHERE product_id = $1', [productId])).rows[0].quantity);
const variantStockOf = async (h: Harness, variantId: string) => Number((await h.pool.query('SELECT quantity FROM product_variants WHERE id = $1', [variantId])).rows[0].quantity);

/** Cart → checkout → fulfilment → returns, and the admin catalogue, against a real database. */
describe('commerce flows (integration)', { skip: skipReason }, () => {
  let h: Harness;
  let category: string;
  let admin: { token: string; userId: string };
  let phoneSeq = 9200000000;
  const customer = () => h.login(String(++phoneSeq));

  before(async () => {
    h = await createHarness();
    category = await h.seed.category('Pooja Items');
    await h.seed.zone({ postal: ['517501'], fee: 3000 });
    await h.seed.zone({ postal: ['517502'], fee: 3000, cod: false });
    admin = await h.login('9300000001', 'admin');
  });
  after(async () => { await h?.close(); });

  describe('pricing and checkout', () => {
    it('quotes GST-inclusive totals with delivery fee and places a COD order that matches the quote', async () => {
      const product = await h.seed.product({ categoryId: category, price: 11800, mrp: 15000, stock: 10, gst: 1800 });
      const { token } = await customer();
      const address = await h.seed.address(token);
      await h.request('POST', '/api/v1/cart/items', { token, body: { product_id: product.id, quantity: 2 } });
      const quote = (await h.request('GET', `/api/v1/cart?address_id=${address}`, { token })).json.data;
      assert.equal(quote.subtotal_paise, 23600);
      assert.equal(quote.tax_paise, 3600, '18% GST included in ₹236 is ₹36');
      assert.equal(quote.delivery_fee_paise, 3000, 'below the ₹499 free-delivery threshold');
      assert.equal(quote.total_paise, 26600);
      assert.equal(quote.savings_paise, 6400);
      assert.equal(quote.payment_methods.cod.available, true);
      assert.equal(quote.payment_methods.upi.available, false, 'online payment is off until Razorpay test credentials are configured');

      const placed = await h.request('POST', '/api/v1/orders/checkout', {
        token, headers: { 'idempotency-key': `t-${randomUUID()}` },
        body: { address_id: address, delivery: { mode: 'express' }, payment_method: 'cod', expected_total_paise: quote.total_paise },
      });
      assert.equal(placed.status, 201, placed.body);
      assert.equal(placed.json.data.amount_paise, 26600);
      assert.match(placed.json.data.order_number, /^SA\d{5,}$/);
      const order = (await h.request('GET', `/api/v1/orders/${placed.json.data.order_id}`, { token })).json.data;
      assert.equal(order.status, 'placed');
      assert.equal(order.payment_method, 'cod');
      assert.equal(order.total_paise, 26600);
      assert.equal(order.items[0].tax_paise, 3600);
      assert.equal(await stockOf(h, product.id), 8, 'stock is committed when a COD order is placed');
      assert.equal((await h.request('GET', '/api/v1/cart', { token })).json.data.lines.length, 0, 'cart is cleared after ordering');

      const prematureInvoice = await h.request('GET', `/api/v1/orders/${order.id}/invoice`, { token });
      assert.equal(prematureInvoice.status, 404, 'COD invoice must not be issued before cash is collected');

      for (const status of ['accepted', 'packed', 'dispatched', 'delivered'] as const) {
        const advanced = await h.fulfil(order.id, status, admin);
        assert.equal(advanced.status, 200, `COD fulfilment transition to ${status}: ${advanced.body}`);
      }
      const deliveredOrder = (await h.request('GET', `/api/v1/orders/${order.id}`, { token })).json.data;
      assert.equal(deliveredOrder.payment_status, 'paid', 'delivery confirmation records COD collection');
      const invoice = (await h.request('GET', `/api/v1/orders/${order.id}/invoice`, { token })).json.data;
      assert.equal(invoice.supply_type, 'intra_state');
      assert.equal(invoice.payment_status, 'paid');
      assert.equal(invoice.lines[0].cgst_paise + invoice.lines[0].sgst_paise, 3600);
      assert.equal(invoice.lines[0].taxable_value_paise, 20000);
    });

    it('waives delivery at the free-delivery threshold', async () => {
      const product = await h.seed.product({ categoryId: category, price: 50000, stock: 5 });
      const { token } = await customer();
      const address = await h.seed.address(token);
      await h.request('POST', '/api/v1/cart/items', { token, body: { product_id: product.id, quantity: 1 } });
      const quote = (await h.request('GET', `/api/v1/cart?address_id=${address}`, { token })).json.data;
      assert.equal(quote.delivery_fee_paise, 0);
      assert.equal(quote.total_paise, 50000);
    });

    it('rejects a client-side total that does not match the server price (409 PRICE_CHANGED)', async () => {
      const product = await h.seed.product({ categoryId: category, price: 20000, stock: 5 });
      const { token } = await customer();
      const address = await h.seed.address(token);
      await h.request('POST', '/api/v1/cart/items', { token, body: { product_id: product.id, quantity: 1 } });
      const tampered = await h.request('POST', '/api/v1/orders/checkout', {
        token, headers: { 'idempotency-key': `t-${randomUUID()}` },
        body: { address_id: address, delivery: { mode: 'express' }, payment_method: 'cod', expected_total_paise: 100 },
      });
      assert.equal(tampered.status, 409);
      assert.equal(tampered.json.error, 'PRICE_CHANGED');
      const injected = await h.request('POST', '/api/v1/orders/checkout', {
        token, headers: { 'idempotency-key': `t-${randomUUID()}` },
        body: { address_id: address, delivery: { mode: 'express' }, payment_method: 'cod', expected_total_paise: 23000, unit_price_paise: 1, discount_paise: 23000 },
      });
      assert.equal(injected.status, 400, 'price fields from the client are refused outright');
      assert.equal(await stockOf(h, product.id), 5);
    });

    it('replays an idempotent checkout without creating a second order', async () => {
      const product = await h.seed.product({ categoryId: category, price: 10000, stock: 5 });
      const { token, userId } = await customer();
      const address = await h.seed.address(token);
      await h.request('POST', '/api/v1/cart/items', { token, body: { product_id: product.id, quantity: 1 } });
      const total = (await h.request('GET', `/api/v1/cart?address_id=${address}`, { token })).json.data.total_paise;
      const key = `t-${randomUUID()}`;
      const body = { address_id: address, delivery: { mode: 'express' }, payment_method: 'cod', expected_total_paise: total };
      const first = await h.request('POST', '/api/v1/orders/checkout', { token, headers: { 'idempotency-key': key }, body });
      const second = await h.request('POST', '/api/v1/orders/checkout', { token, headers: { 'idempotency-key': key }, body });
      assert.equal(first.status, 201);
      assert.equal(second.status, 200);
      assert.equal(second.json.data.order_id, first.json.data.order_id);
      assert.equal(Number((await h.pool.query('SELECT COUNT(*) FROM orders WHERE user_id = $1', [userId])).rows[0].count), 1);
      assert.equal(await stockOf(h, product.id), 4);
      assert.equal((await h.request('POST', '/api/v1/orders/checkout', { token, body })).status, 400, 'an Idempotency-Key is required');
    });

    it('sells the last unit exactly once under concurrent checkouts', async () => {
      const product = await h.seed.product({ categoryId: category, price: 10000, stock: 1 });
      const buyers = await Promise.all([customer(), customer(), customer(), customer()]);
      const prepared = [];
      for (const buyer of buyers) {
        const address = await h.seed.address(buyer.token);
        assert.equal((await h.request('POST', '/api/v1/cart/items', { token: buyer.token, body: { product_id: product.id, quantity: 1 } })).status, 200);
        const total = (await h.request('GET', `/api/v1/cart?address_id=${address}`, { token: buyer.token })).json.data.total_paise;
        prepared.push({ buyer, address, total });
      }
      const results = await Promise.all(prepared.map(({ buyer, address, total }) => h.request('POST', '/api/v1/orders/checkout', {
        token: buyer.token, headers: { 'idempotency-key': `t-${randomUUID()}` },
        body: { address_id: address, delivery: { mode: 'express' }, payment_method: 'cod', expected_total_paise: total },
      })));
      const statuses = results.map(result => result.status).sort();
      assert.deepEqual(statuses.filter(status => status === 201).length, 1, `statuses: ${statuses}`);
      assert.ok(results.every(result => result.status === 201 || result.status === 409), `statuses: ${statuses}`);
      assert.equal(await stockOf(h, product.id), 0, 'stock never goes negative');
    });

    it('requires a variant for products with options and charges the variant price', async () => {
      const product = await h.seed.product({ categoryId: category, price: 10000, stock: 0 });
      const small = await h.seed.variant(product.id, { label: '50 g', price: 6000, stock: 3 });
      await h.seed.variant(product.id, { label: '100 g', price: 11000, stock: 3 });
      const { token } = await customer();
      const address = await h.seed.address(token);
      const missing = await h.request('POST', '/api/v1/cart/items', { token, body: { product_id: product.id, quantity: 1 } });
      assert.equal(missing.status, 400);
      assert.equal(missing.json.error, 'VARIANT_REQUIRED');
      assert.equal((await h.request('POST', '/api/v1/cart/items', { token, body: { product_id: product.id, variant_id: small, quantity: 4 } })).status, 409, 'variant stock is enforced');
      const placed = await h.placeOrder(token, address, [{ product_id: product.id, variant_id: small, quantity: 2 }]);
      assert.equal(placed.status, 201, placed.body);
      assert.equal(placed.json.data.amount_paise, 12000 + 3000);
      assert.equal(await variantStockOf(h, small), 1);
      const items = (await h.request('GET', `/api/v1/orders/${placed.json.data.order_id}`, { token })).json.data.items;
      assert.equal(items[0].variant_label, '50 g');
    });

    it('refuses undeliverable PIN codes, COD where disabled, online payment without a gateway, and invalid slots', async () => {
      const product = await h.seed.product({ categoryId: category, price: 10000, stock: 10 });
      const { token } = await customer();
      const far = await h.seed.address(token, '110001');
      const noCod = await h.seed.address(token, '517502');
      const local = await h.seed.address(token, '517501');
      await h.request('POST', '/api/v1/cart/items', { token, body: { product_id: product.id, quantity: 1 } });
      const checkout = (address: string, extra: Record<string, unknown>) => h.request('POST', '/api/v1/orders/checkout', {
        token, headers: { 'idempotency-key': `t-${randomUUID()}` },
        body: { address_id: address, delivery: { mode: 'express' }, payment_method: 'cod', expected_total_paise: 13000, ...extra },
      });
      const farQuote = (await h.request('GET', `/api/v1/cart?address_id=${far}`, { token })).json.data;
      assert.ok(farQuote.problems.includes('DELIVERY_UNAVAILABLE'));
      assert.equal((await checkout(far, {})).status, 409);
      const codQuote = (await h.request('GET', `/api/v1/cart?address_id=${noCod}`, { token })).json.data;
      assert.equal(codQuote.payment_methods.cod.available, false);
      assert.equal((await checkout(noCod, {})).status, 409);
      const online = await checkout(local, { payment_method: 'upi', email: 'a@example.com' });
      assert.equal(online.status, 409);
      assert.equal(online.json.error, 'PAYMENT_METHOD_UNAVAILABLE');
      const badSlot = await checkout(local, { delivery: { mode: 'scheduled', slot_id: randomUUID(), date: '2020-01-01' } });
      assert.equal(badSlot.status, 409);
      assert.equal(await stockOf(h, product.id), 10, 'failed checkouts do not touch stock');
    });

    it('books a scheduled slot that the quote offered', async () => {
      const slot = await h.seed.scheduledSlot('18:00', '20:00');
      const product = await h.seed.product({ categoryId: category, price: 10000, stock: 10 });
      const { token } = await customer();
      const address = await h.seed.address(token);
      await h.request('POST', '/api/v1/cart/items', { token, body: { product_id: product.id, quantity: 1 } });
      const quote = (await h.request('GET', `/api/v1/cart?address_id=${address}`, { token })).json.data;
      const option = quote.delivery.scheduled.find((entry: { slot_id: string }) => entry.slot_id === slot);
      assert.ok(option, 'the slot is offered in the next days');
      const placed = await h.request('POST', '/api/v1/orders/checkout', {
        token, headers: { 'idempotency-key': `t-${randomUUID()}` },
        body: { address_id: address, delivery: { mode: 'scheduled', slot_id: slot, date: option.date }, payment_method: 'cod', expected_total_paise: quote.total_paise },
      });
      assert.equal(placed.status, 201, placed.body);
      const order = (await h.request('GET', `/api/v1/orders/${placed.json.data.order_id}`, { token })).json.data;
      assert.equal(order.delivery_mode, 'scheduled');
      assert.equal(new Date(order.delivery_slot_start).toISOString(), option.starts_at);
      await h.pool.query('UPDATE delivery_time_slots SET is_active = FALSE WHERE id = $1', [slot]);
    });

    it('drops unavailable items from the total and blocks checkout until they are removed', async () => {
      const product = await h.seed.product({ categoryId: category, price: 10000, stock: 10 });
      const { token } = await customer();
      const address = await h.seed.address(token);
      await h.request('POST', '/api/v1/cart/items', { token, body: { product_id: product.id, quantity: 1 } });
      await h.pool.query('UPDATE products SET is_active = FALSE WHERE id = $1', [product.id]);
      const quote = (await h.request('GET', `/api/v1/cart?address_id=${address}`, { token })).json.data;
      assert.equal(quote.lines[0].issue, 'unavailable');
      assert.equal(quote.subtotal_paise, 0);
      const attempt = await h.request('POST', '/api/v1/orders/checkout', {
        token, headers: { 'idempotency-key': `t-${randomUUID()}` },
        body: { address_id: address, delivery: { mode: 'express' }, payment_method: 'cod', expected_total_paise: quote.total_paise },
      });
      assert.equal(attempt.status, 409);
    });
  });

  describe('fulfilment, cancellation and returns', () => {
    // Staff accept and pack; the assigned delivery partner dispatches (pickup) and delivers (customer code).
    const advance = async (orderId: string, status: string, staff: { token: string; userId: string } = admin) =>
      h.fulfil(orderId, status as 'accepted' | 'packed' | 'dispatched' | 'delivered', staff);

    it('moves a COD order through each stage, records cash on delivery, and refuses skipped stages', async () => {
      const product = await h.seed.product({ categoryId: category, price: 10000, stock: 10 });
      const { token } = await customer();
      const address = await h.seed.address(token);
      const placed = await h.placeOrder(token, address, [{ product_id: product.id, quantity: 1 }]);
      const orderId = placed.json.data.order_id as string;
      assert.equal((await h.request('GET', `/api/v1/orders/${orderId}/invoice`, { token })).status, 404,
        'a COD tax invoice must not be available before cash is collected');
      // Deliberately bypass the helper here: an invalid early dispatch must not
      // create an assignment as a side effect of the test fixture.
      const skipped = await h.request('PATCH', `/api/v1/admin/orders/${orderId}/status`, {
        token: admin.token, body: { status: 'dispatched' },
      });
      assert.equal(skipped.status, 409);
      assert.equal(skipped.json.error, 'INVALID_ORDER_TRANSITION');
      const operator = await h.login('9300000002', 'operator');
      for (const status of ['accepted', 'packed', 'dispatched']) assert.equal((await advance(orderId, status, operator)).status, 200, status);
      const delivered = await advance(orderId, 'delivered');
      assert.equal(delivered.status, 200, delivered.body);
      assert.equal(delivered.json.data.delivered, true, 'cash recorded by the partner completes the delivery');
      const detail = (await h.request('GET', `/api/v1/orders/${orderId}`, { token })).json.data;
      assert.equal(detail.status, 'delivered');
      assert.equal(detail.payment_status, 'paid');
      assert.equal((await h.request('GET', `/api/v1/orders/${orderId}/invoice`, { token })).status, 200,
        'the COD invoice becomes available after delivery records cash collection');
      assert.equal(detail.can_request_return, true);
      assert.deepEqual(detail.timeline.map((entry: { status: string }) => entry.status), ['placed', 'accepted', 'packed', 'dispatched', 'delivered']);
      const payment = (await h.pool.query(`SELECT status, collected_by FROM payments WHERE order_id = $1`, [orderId])).rows[0];
      assert.equal(payment.status, 'succeeded');
      assert.ok(payment.collected_by);
      assert.notEqual((await advance(orderId, 'delivered')).status, 200, 'cannot deliver twice');
      assert.equal((await h.request('PATCH', `/api/v1/admin/orders/${orderId}/status`, { token: admin.token, body: { status: 'delivered' } })).status, 409, 'staff cannot re-deliver either');
      assert.equal((await h.request('POST', `/api/v1/admin/orders/${orderId}/cancel`, { token: admin.token, body: { reason: 'Too late' } })).status, 409);
    });

    it('cancelling before dispatch restores stock and closes COD without issuing an invoice', async () => {
      const product = await h.seed.product({ categoryId: category, price: 10000, stock: 10 });
      const { token } = await customer();
      const address = await h.seed.address(token);
      const placed = await h.placeOrder(token, address, [{ product_id: product.id, quantity: 3 }]);
      const orderId = placed.json.data.order_id as string;
      assert.equal(await stockOf(h, product.id), 7);
      await advance(orderId, 'accepted');
      const cancelled = await h.request('POST', `/api/v1/admin/orders/${orderId}/cancel`, { token: admin.token, body: { reason: 'Customer called to cancel' } });
      assert.equal(cancelled.status, 200, cancelled.body);
      assert.equal(cancelled.json.data.inventory_units_restored, 3);
      assert.equal(await stockOf(h, product.id), 10);
      const order = (await h.request('GET', `/api/v1/orders/${orderId}`, { token })).json.data;
      assert.equal(order.status, 'cancelled');
      assert.equal(order.payment_status, 'cancelled');
      assert.equal((await h.request('GET', `/api/v1/orders/${orderId}/invoice`, { token })).status, 404, 'cancelled COD orders never collected cash and must not receive a tax invoice');
    });

    it('keeps return evidence private and requires pickup receipt before refund', async () => {
      const product = await h.seed.product({ categoryId: category, price: 10000, stock: 10 });
      const { token } = await customer();
      const address = await h.seed.address(token);
      const placed = await h.placeOrder(token, address, [{ product_id: product.id, quantity: 1 }]);
      const orderId = placed.json.data.order_id as string;
      assert.equal((await h.request('POST', '/api/v1/orders/' + orderId + '/return-request', { token, body: { reason: 'Damaged lamp' } })).status, 409, 'only delivered orders can be returned');
      for (const status of ['accepted', 'packed', 'dispatched', 'delivered']) await advance(orderId, status);
      await h.pool.query("UPDATE orders SET payment_status = 'pending' WHERE id = $1", [orderId]);
      const unpaidReturn = await h.request('POST', '/api/v1/orders/' + orderId + '/return-request', { token, body: { reason: 'Damaged lamp' } });
      assert.equal(unpaidReturn.status, 409);
      assert.equal(unpaidReturn.json.error, 'ORDER_PAYMENT_NOT_SETTLED');
      await h.pool.query("UPDATE orders SET payment_status = 'paid' WHERE id = $1", [orderId]);

      const requested = await h.request('POST', '/api/v1/orders/' + orderId + '/return-request', { token, body: { reason: 'Damaged lamp' } });
      assert.equal(requested.status, 201, requested.body);
      assert.equal(requested.json.data.status, 'requested');
      assert.equal((await h.request('GET', '/api/v1/orders/' + orderId, { token })).json.data.can_request_return, false,
        'a return cannot be opened twice for the same order');
      const duplicateRequest = await h.request('POST', '/api/v1/orders/' + orderId + '/return-request', { token, body: { reason: 'Second attempt' } });
      assert.equal(duplicateRequest.status, 409);
      assert.equal(duplicateRequest.json.error, 'RETURN_ALREADY_EXISTS');
      const returnId = requested.json.data.return_id as string;

      const boundary = '----sac' + randomUUID().replaceAll('-', '');
      const png = await sharp({ create: { width: 96, height: 72, channels: 3, background: '#c0392b' } }).png().toBuffer();
      const payload = Buffer.concat([
        Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="damage.png"\r\nContent-Type: image/png\r\n\r\n'),
        png,
        Buffer.from('\r\n--' + boundary + '--\r\n'),
      ]);
      const uploaded = await h.app.inject({
        method: 'POST', url: '/api/v1/orders/' + orderId + '/return-evidence',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'multipart/form-data; boundary=' + boundary },
        payload,
      });
      assert.equal(uploaded.statusCode, 201, uploaded.body);
      const evidence = JSON.parse(uploaded.body).data;
      assert.equal(evidence.content_type, 'image/webp');
      assert.ok(!JSON.stringify(evidence).includes('storage_key'));
      const ownerRead = await h.request('GET', '/api/v1/orders/' + orderId + '/return-evidence/' + evidence.id, { token });
      assert.equal(ownerRead.status, 200);
      assert.equal(ownerRead.headers['content-type'], 'image/webp');
      const otherCustomer = await h.login('9700000999');
      assert.equal((await h.request('GET', '/api/v1/orders/' + orderId + '/return-evidence/' + evidence.id, { token: otherCustomer.token })).status, 404);
      assert.equal((await h.request('GET', '/api/v1/orders/' + orderId + '/return-evidence/' + evidence.id, { token: admin.token })).status, 200);

      const queue = await h.request('GET', '/api/v1/admin/returns?status=requested', { token: admin.token });
      assert.equal(queue.status, 200);
      assert.ok(queue.json.data.some((row: { id: string }) => row.id === returnId));
      const adminDetail = await h.request('GET', '/api/v1/admin/orders/' + orderId + '/return', { token: admin.token });
      assert.equal(adminDetail.status, 200);
      assert.equal(adminDetail.json.data.evidence.length, 1);
      const customerDetail = await h.request('GET', '/api/v1/orders/' + orderId + '/return', { token });
      assert.equal(customerDetail.status, 200);
      assert.equal(customerDetail.json.data.timeline[0].to_status, 'requested');

      const approved = await h.request('PATCH', '/api/v1/admin/orders/' + orderId + '/return-decision', { token: admin.token, body: { decision: 'approve', reason: 'Evidence reviewed' } });
      assert.equal(approved.status, 200, approved.body);
      assert.equal(approved.json.data.status, 'accepted');
      assert.equal(approved.json.data.refund_required, false);
      const blockedRefund = await h.request('POST', '/api/v1/admin/orders/' + orderId + '/refunds', {
        token: admin.token, headers: { 'idempotency-key': 'return-too-early-01' },
        body: { amount_paise: Number(placed.json.data.amount_paise), reason: 'Return refund before receipt' },
      });
      assert.equal(blockedRefund.status, 409);
      assert.equal(blockedRefund.json.error, 'RETURN_NOT_RECEIVED');

      const wrongStage = await h.request('PATCH', '/api/v1/admin/orders/' + orderId + '/return-status', { token: admin.token, body: { status: 'received' } });
      assert.equal(wrongStage.status, 409);
      const scheduled = await h.request('PATCH', '/api/v1/admin/orders/' + orderId + '/return-status', {
        token: admin.token, body: { status: 'pickup_scheduled', pickup_method: 'self_dropoff', note: 'Customer drop-off approved' },
      });
      assert.equal(scheduled.status, 200, scheduled.body);
      assert.equal(scheduled.json.data.status, 'pickup_scheduled');
      const pickedUp = await h.request('PATCH', '/api/v1/admin/orders/' + orderId + '/return-status', {
        token: admin.token, body: { status: 'picked_up', pickup_reference: 'DROP-OFF-001' },
      });
      assert.equal(pickedUp.status, 200);
      const received = await h.request('PATCH', '/api/v1/admin/orders/' + orderId + '/return-status', {
        token: admin.token, body: { status: 'received', note: 'Item inspected and received' },
      });
      assert.equal(received.status, 200);
      const orderAfterReceipt = (await h.request('GET', '/api/v1/orders/' + orderId, { token })).json.data;
      assert.equal(orderAfterReceipt.status, 'refund_initiated');

      const total = Number(placed.json.data.amount_paise);
      const tooMuch = await h.request('POST', '/api/v1/admin/orders/' + orderId + '/refunds', {
        token: admin.token, headers: { 'idempotency-key': 'return-too-much-001' },
        body: { amount_paise: total + 1, reason: 'Damaged' },
      });
      assert.equal(tooMuch.status, 409);
      const refund = await h.request('POST', '/api/v1/admin/orders/' + orderId + '/refunds', {
        token: admin.token, headers: { 'idempotency-key': 'return-refund-001' },
        body: { amount_paise: total, reason: 'Damaged on arrival' },
      });
      assert.equal(refund.status, 201, refund.body);
      assert.equal(refund.json.data.method, 'manual');
      const returnDuringRefund = await h.request('GET', '/api/v1/admin/orders/' + orderId + '/return', { token: admin.token });
      assert.equal(returnDuringRefund.json.data.status, 'refund_pending');
      const completed = await h.request('PATCH', '/api/v1/admin/refunds/' + refund.json.data.id + '/status', {
        token: admin.token, body: { status: 'completed', provider_transaction_id: 'UPI-REF-1234' },
      });
      assert.equal(completed.status, 200, completed.body);
      const order = (await h.request('GET', '/api/v1/orders/' + orderId, { token })).json.data;
      assert.equal(order.payment_status, 'refunded');
      assert.equal(order.status, 'refunded');
      assert.equal(order.refunds[0].status, 'completed');
      const finalReturn = await h.request('GET', '/api/v1/orders/' + orderId + '/return', { token });
      assert.equal(finalReturn.json.data.status, 'refunded');
      assert.deepEqual(finalReturn.json.data.timeline.map((event: { to_status: string }) => event.to_status), [
        'requested', 'accepted', 'pickup_scheduled', 'picked_up', 'received', 'refund_pending', 'refunded',
      ]);
    });

    it('accepts customer courier tracking and lets staff confirm receipt', async () => {
      const product = await h.seed.product({ categoryId: category, price: 12000, stock: 8 });
      const { token } = await customer();
      const address = await h.seed.address(token);
      const placed = await h.placeOrder(token, address, [{ product_id: product.id, quantity: 1 }]);
      const orderId = placed.json.data.order_id as string;
      for (const status of ['accepted', 'packed', 'dispatched', 'delivered']) await advance(orderId, status);
      assert.equal((await h.request('POST', '/api/v1/orders/' + orderId + '/return-request', { token, body: { reason: 'Wrong item received' } })).status, 201);
      assert.equal((await h.request('PATCH', '/api/v1/admin/orders/' + orderId + '/return-decision', { token: admin.token, body: { decision: 'approve' } })).status, 200);
      const scheduled = await h.request('PATCH', '/api/v1/admin/orders/' + orderId + '/return-status', {
        token: admin.token, body: { status: 'pickup_scheduled', pickup_method: 'courier', pickup_reference: 'Awaiting customer shipment' },
      });
      assert.equal(scheduled.status, 200, scheduled.body);
      const invalidStaffPickup = await h.request('PATCH', '/api/v1/admin/orders/' + orderId + '/return-status', {
        token: admin.token, body: { status: 'picked_up' },
      });
      assert.equal(invalidStaffPickup.status, 409, 'courier returns require customer tracking details instead of staff pickup confirmation');

      const shipment = await h.request('PATCH', '/api/v1/orders/' + orderId + '/return-shipment', {
        token, body: { carrier: 'India Post', tracking_reference: 'RT123456789IN', parcel_description: 'One sealed pooja lamp in protective packaging' },
      });
      assert.equal(shipment.status, 200, shipment.body);
      assert.equal(shipment.json.data.status, 'in_transit');
      const transitQueue = await h.request('GET', '/api/v1/admin/returns?status=in_transit', { token: admin.token });
      assert.equal(transitQueue.status, 200, 'in-transit returns must be filterable in the admin queue');
      assert.ok(transitQueue.json.data.some((row: { order_id: string }) => row.order_id === orderId));
      const detail = await h.request('GET', '/api/v1/admin/orders/' + orderId + '/return', { token: admin.token });
      assert.equal(detail.json.data.return_carrier, 'India Post');
      assert.equal(detail.json.data.pickup_reference, 'RT123456789IN');
      assert.match(detail.json.data.parcel_description, /protective packaging/);

      const received = await h.request('PATCH', '/api/v1/admin/orders/' + orderId + '/return-status', {
        token: admin.token, body: { status: 'received', note: 'Parcel received and item inspected' },
      });
      assert.equal(received.status, 200, received.body);
      const final = await h.request('GET', '/api/v1/orders/' + orderId + '/return', { token });
      assert.equal(final.json.data.status, 'received');
      assert.equal(final.json.data.timeline.at(-1).to_status, 'received');
    });

    it('allows a customer to cancel a return before pickup and preserves its history', async () => {
      const product = await h.seed.product({ categoryId: category, price: 10000, stock: 10 });
      const { token } = await customer();
      const address = await h.seed.address(token);
      const placed = await h.placeOrder(token, address, [{ product_id: product.id, quantity: 1 }]);
      const orderId = placed.json.data.order_id as string;
      for (const status of ['accepted', 'packed', 'dispatched', 'delivered']) await advance(orderId, status);
      const requested = await h.request('POST', '/api/v1/orders/' + orderId + '/return-request', { token, body: { reason: 'Wrong item received' } });
      assert.equal(requested.status, 201, requested.body);
      const cancelled = await h.request('POST', '/api/v1/orders/' + orderId + '/return-cancel', { token });
      assert.equal(cancelled.status, 200, cancelled.body);
      assert.equal(cancelled.json.data.status, 'cancelled');
      const order = (await h.request('GET', '/api/v1/orders/' + orderId, { token })).json.data;
      assert.equal(order.status, 'delivered');
      const details = await h.request('GET', '/api/v1/orders/' + orderId + '/return', { token });
      assert.equal(details.json.data.status, 'cancelled');
      assert.equal(details.json.data.timeline.at(-1).to_status, 'cancelled');
      const duplicate = await h.request('POST', '/api/v1/orders/' + orderId + '/return-cancel', { token });
      assert.equal(duplicate.status, 409);
    });

    it('supports returning selected quantities and calculates a proportional line refund', async () => {
      const product = await h.seed.product({ categoryId: category, price: 10000, stock: 10 });
      const { token } = await customer();
      const address = await h.seed.address(token);
      const placed = await h.placeOrder(token, address, [{ product_id: product.id, quantity: 3 }]);
      const orderId = placed.json.data.order_id as string;
      for (const status of ['accepted', 'packed', 'dispatched', 'delivered']) await advance(orderId, status);
      const orderItemId = (await h.pool.query('SELECT id FROM order_items WHERE order_id = $1', [orderId])).rows[0].id as string;

      const invalid = await h.request('POST', '/api/v1/orders/' + orderId + '/return-request', {
        token, body: { reason: 'One item damaged', items: [{ order_item_id: orderItemId, quantity: 4 }] },
      });
      assert.equal(invalid.status, 400);
      assert.equal(invalid.json.error, 'INVALID_RETURN_QUANTITY');

      const requested = await h.request('POST', '/api/v1/orders/' + orderId + '/return-request', {
        token, body: { reason: 'One item damaged', items: [{ order_item_id: orderItemId, quantity: 1 }] },
      });
      assert.equal(requested.status, 201, requested.body);
      assert.equal(requested.json.data.items, 1);
      assert.equal(requested.json.data.requested_refund_paise, 10000);
      const details = await h.request('GET', '/api/v1/orders/' + orderId + '/return', { token });
      assert.equal(details.json.data.items.length, 1);
      assert.equal(details.json.data.items[0].quantity, 1);
      assert.equal(details.json.data.items[0].refund_amount_paise, 10000);
    });

    it('prevents a return refund from exceeding the selected item value', async () => {
      const product = await h.seed.product({ categoryId: category, price: 10000, stock: 10 });
      const { token } = await customer();
      const address = await h.seed.address(token);
      const placed = await h.placeOrder(token, address, [{ product_id: product.id, quantity: 2 }]);
      const orderId = placed.json.data.order_id as string;
      for (const status of ['accepted', 'packed', 'dispatched', 'delivered']) await advance(orderId, status);
      const orderItemId = (await h.pool.query('SELECT id FROM order_items WHERE order_id = $1', [orderId])).rows[0].id as string;
      const requested = await h.request('POST', '/api/v1/orders/' + orderId + '/return-request', {
        token, body: { reason: 'One item damaged', items: [{ order_item_id: orderItemId, quantity: 1 }] },
      });
      assert.equal(requested.status, 201, requested.body);
      assert.equal((await h.request('PATCH', '/api/v1/admin/orders/' + orderId + '/return-decision', {
        token: admin.token, body: { decision: 'approve' },
      })).status, 200);
      assert.equal((await h.request('PATCH', '/api/v1/admin/orders/' + orderId + '/return-status', {
        token: admin.token, body: { status: 'pickup_scheduled', pickup_method: 'self_dropoff' },
      })).status, 200);
      assert.equal((await h.request('PATCH', '/api/v1/admin/orders/' + orderId + '/return-status', {
        token: admin.token, body: { status: 'picked_up' },
      })).status, 200);
      assert.equal((await h.request('PATCH', '/api/v1/admin/orders/' + orderId + '/return-status', {
        token: admin.token, body: { status: 'received' },
      })).status, 200);
      const excessive = await h.request('POST', '/api/v1/admin/orders/' + orderId + '/refunds', {
        token: admin.token, headers: { 'idempotency-key': 'partial-return-refund-' + randomUUID() },
        body: { amount_paise: 20000, reason: 'Refund selected returned item' },
      });
      assert.equal(excessive.status, 409);
      assert.equal(excessive.json.error, 'REFUND_EXCEEDS_RETURN_ITEMS');
    });

    it('closes the return window 48 hours after delivery', async () => {
      const product = await h.seed.product({ categoryId: category, price: 10000, stock: 10 });
      const { token } = await customer();
      const address = await h.seed.address(token);
      const placed = await h.placeOrder(token, address, [{ product_id: product.id, quantity: 1 }]);
      const orderId = placed.json.data.order_id as string;
      for (const status of ['accepted', 'packed', 'dispatched', 'delivered']) await advance(orderId, status);
      await h.pool.query(`UPDATE orders SET delivered_at = now() - interval '49 hours' WHERE id = $1`, [orderId]);
      const late = await h.request('POST', `/api/v1/orders/${orderId}/return-request`, { token, body: { reason: 'Changed my mind' } });
      assert.equal(late.status, 409);
      assert.equal(late.json.error, 'RETURN_WINDOW_CLOSED');
    });
  });

  describe('admin catalogue and inventory', () => {
    const pngBytes = () => sharp({ create: { width: 64, height: 64, channels: 3, background: '#c0392b' } }).png().toBuffer();
    const multipart = (name: string, type: string, content: Buffer) => {
      const boundary = `----sac${randomUUID().replaceAll('-', '')}`;
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`),
        content, Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      return { body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
    };
    const upload = async (name: string, type: string, content: Buffer) => {
      const { body, headers } = multipart(name, type, content);
      const response = await h.app.inject({ method: 'POST', url: '/api/v1/admin/media', headers: { ...headers, authorization: `Bearer ${admin.token}` }, payload: body });
      return { status: response.statusCode, json: JSON.parse(response.body) };
    };

    it('uploads a real image as WebP and rejects disguised files', async () => {
      const uploaded = await upload('lamp.png', 'image/png', await pngBytes());
      assert.equal(uploaded.status, 201);
      assert.match(uploaded.json.data.url, /^\/media\/[0-9a-f-]{36}\.webp$/);
      const served = await h.request('GET', uploaded.json.data.url);
      assert.equal(served.status, 200);
      assert.equal(served.headers['content-type'], 'image/webp');
      const fake = await upload('evil.png', 'image/png', Buffer.from('<svg onload="alert(1)"></svg>'));
      assert.equal(fake.status, 400);
      const svg = await upload('logo.svg', 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'));
      assert.equal(svg.status, 400);
    });

    it('creates, edits, archives and restores a product with variants', async () => {
      const image = (await upload('kumkum.png', 'image/png', await pngBytes())).json.data.url as string;
      const sku = `KUM-${randomUUID().slice(0, 6).toUpperCase()}`;
      const input = {
        name: 'Pure Kumkum', slug: `pure-kumkum-${randomUUID().slice(0, 6)}`, sku, description: 'Traditional kumkum for daily pooja.',
        category_id: category, price_paise: 4000, mrp_paise: 5000, gst_rate_basis_points: 500, hsn_code: '3304',
        minimum_stock_level: 5, is_active: true, images: [{ url: image }],
        variants: [{ label: '50 g', sku: `${sku}-50`, price_paise: 4000, mrp_paise: 5000, initial_quantity: 20 }],
      };
      const created = await h.request('POST', '/api/v1/admin/products', { token: admin.token, body: input });
      assert.equal(created.status, 201, created.body);
      const productId = created.json.data.id as string;
      const duplicate = await h.request('POST', '/api/v1/admin/products', { token: admin.token, body: { ...input, slug: `${input.slug}-2`, variants: [] } });
      assert.equal(duplicate.status, 409);
      assert.equal(duplicate.json.error, 'SKU_TAKEN');
      const badMrp = await h.request('POST', '/api/v1/admin/products', { token: admin.token, body: { ...input, sku: `${sku}X`, slug: `${input.slug}-3`, mrp_paise: 100, variants: [] } });
      assert.equal(badMrp.status, 400);
      const external = await h.request('POST', '/api/v1/admin/products', { token: admin.token, body: { ...input, sku: `${sku}Y`, slug: `${input.slug}-4`, images: [{ url: 'javascript:alert(1)' }], variants: [] } });
      assert.equal(external.status, 400, 'image URLs are restricted to uploaded media or https');

      const saved = created.json.data;
      const twice = { ...input, variants: saved.variants.map((variant: Record<string, unknown>) => ({ id: variant.id, label: variant.label, sku: variant.sku, price_paise: 4500, mrp_paise: 5000 })), price_paise: 4500 };
      assert.equal((await h.request('PUT', `/api/v1/admin/products/${productId}`, { token: admin.token, body: twice })).status, 200);
      const again = await h.request('PUT', `/api/v1/admin/products/${productId}`, { token: admin.token, body: twice });
      assert.equal(again.status, 200);
      assert.equal(again.json.data.variants.length, 1, 'saving twice must not duplicate variants');
      assert.equal(again.json.data.variants[0].quantity, 20, 'editing does not reset stock');

      const publicView = await h.request('GET', `/api/v1/products/${input.slug}`);
      assert.equal(publicView.status, 200);
      assert.equal(publicView.json.data.variants[0].price_paise, 4500);
      assert.equal((await h.request('DELETE', `/api/v1/admin/products/${productId}`, { token: admin.token })).status, 204);
      assert.equal((await h.request('GET', `/api/v1/products/${input.slug}`)).status, 404, 'archived products disappear from the store');
      const listing = await h.request('GET', `/api/v1/products?q=Pure%20Kumkum`);
      assert.ok(!listing.json.data.some((card: { id: string }) => card.id === productId));
      assert.equal((await h.request('POST', `/api/v1/admin/products/${productId}/restore`, { token: admin.token })).status, 200);
      assert.equal((await h.request('GET', `/api/v1/products/${input.slug}`)).status, 404, 'restored products come back as hidden drafts');
      assert.equal((await h.request('PATCH', `/api/v1/admin/products/${productId}`, { token: admin.token, body: { is_active: true } })).status, 200);
      assert.equal((await h.request('GET', `/api/v1/products/${input.slug}`)).status, 200);
    });

    it('stock adjustments are recorded and can never make stock negative; the dashboard reports low stock', async () => {
      const product = await h.seed.product({ categoryId: category, price: 10000, stock: 3, min: 5, name: 'Camphor Low' });
      const over = await h.request('POST', '/api/v1/admin/inventory/adjustments', { token: admin.token, body: { product_id: product.id, quantity_delta: -4, reason: 'damaged' } });
      assert.equal(over.status, 409);
      const stockIn = await h.request('POST', '/api/v1/admin/inventory/adjustments', { token: admin.token, body: { product_id: product.id, quantity_delta: 1, reason: 'stock_in', note: 'Invoice 42' } });
      assert.equal(stockIn.status, 200);
      assert.equal(stockIn.json.data.quantity, 4);
      assert.equal((await h.request('POST', '/api/v1/admin/inventory/adjustments', { token: admin.token, body: { product_id: product.id, quantity_delta: 2, reason: 'damaged' } })).status, 400);
      const movements = await h.request('GET', `/api/v1/admin/inventory/${product.id}/movements`, { token: admin.token });
      assert.equal(movements.status, 200);
      assert.ok(movements.json.data.some((entry: { quantity_delta: number }) => entry.quantity_delta === 1));

      const dashboard = await h.request('GET', '/api/v1/admin/dashboard', { token: admin.token });
      assert.equal(dashboard.status, 200, dashboard.body);
      assert.ok(dashboard.json.data.low_stock.some((row: { id: string; product_id?: string }) => (row.product_id ?? row.id) === product.id));
      for (const url of ['/api/v1/admin/reports/summary', '/api/v1/admin/reports/tax', '/api/v1/admin/payments', '/api/v1/admin/notifications', '/api/v1/admin/orders', '/api/v1/admin/customers', '/api/v1/admin/inventory', '/api/v1/admin/settings', '/api/v1/admin/delivery-zones', '/api/v1/admin/delivery-slots', '/api/v1/admin/categories', '/api/v1/admin/refunds', '/api/v1/admin/search?q=Camphor']) {
        assert.equal((await h.request('GET', url, { token: admin.token })).status, 200, url);
      }
      const csv = await h.request('GET', '/api/v1/admin/reports/summary?format=csv', { token: admin.token });
      assert.equal(csv.status, 200);
      assert.match(String(csv.headers['content-type']), /text\/csv/);
    });

    it('settings are validated before being stored', async () => {
      const bad = await h.request('PUT', '/api/v1/admin/settings/delivery', { token: admin.token, body: { free_delivery_threshold_paise: -1 } });
      assert.equal(bad.status, 400);
      const unknown = await h.request('PUT', '/api/v1/admin/settings/secrets', { token: admin.token, body: {} });
      assert.ok(unknown.status === 400 || unknown.status === 404);
    });
  });

  describe('public catalogue', () => {
    it('serves the home page, category tree, filtered listing and search suggestions', async () => {
      const sub = await h.seed.category('Rose Agarbatti', category);
      const rose = await h.seed.product({ categoryId: category, price: 9900, stock: 4, name: 'Rose Incense Sticks' });
      await h.pool.query('UPDATE products SET is_featured = TRUE WHERE id = $1', [rose.id]);
      assert.equal((await h.request('GET', '/api/v1/home')).status, 200);
      const tree = (await h.request('GET', '/api/v1/categories')).json.data;
      const parent = tree.find((node: { id: string }) => node.id === category);
      assert.ok(parent.children.some((child: { id: string }) => child.id === sub));
      const listing = await h.request('GET', '/api/v1/products?q=rose&sort=price_asc&max_price=10000');
      assert.equal(listing.status, 200);
      assert.ok(listing.json.data.some((card: { name: string }) => card.name === 'Rose Incense Sticks'));
      const featuredInStock = await h.request('GET', '/api/v1/products?featured=true&in_stock=true');
      assert.ok(featuredInStock.json.data.some((card: { id: string }) => card.id === rose.id), 'featured and in-stock filters include matching products');
      await h.pool.query('UPDATE inventory SET quantity = 0 WHERE product_id = $1', [rose.id]);
      const inStockOnly = await h.request('GET', '/api/v1/products?in_stock=true');
      assert.ok(!inStockOnly.json.data.some((card: { id: string }) => card.id === rose.id), 'in-stock filter excludes depleted products');
      const suggest = await h.request('GET', '/api/v1/search/suggest?q=ros');
      assert.equal(suggest.status, 200);
      assert.equal((await h.request('GET', '/api/v1/delivery/availability?postal_code=517501')).json.data.serviceable, true);
      assert.equal((await h.request('GET', '/api/v1/delivery/availability?postal_code=110001')).json.data.serviceable, false);
    });
  });
});
