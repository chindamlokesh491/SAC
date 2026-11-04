import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { createHarness, skipReason, type Harness } from './support/harness.js';

describe('delivery partner portal (integration)', { skip: skipReason }, () => {
  let h: Harness;
  before(async () => { h = await createHarness(); });
  after(async () => { await h?.close(); });

  it('authenticates a provisioned partner and completes COD only after delivery OTP', async () => {
    const customer = await h.login('9100000071');
    const categoryId = await h.seed.category();
    const product = await h.seed.product({ categoryId, price: 12500, stock: 5 });
    await h.seed.zone({ postal: ['517501'], cod: true });
    const addressId = await h.seed.address(customer.token);
    const placed = await h.placeOrder(customer.token, addressId, [{ product_id: product.id, quantity: 1 }]);
    assert.equal(placed.status, 201, placed.body);
    const orderRow = await h.pool.query<{ id: string }>('SELECT id FROM orders WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1', [customer.userId]);
    const orderId = orderRow.rows[0]!.id;
    const admin = await h.login('9100000072', 'admin');
    const assignmentId = await h.seed.assignDeliveryPartner(orderId, admin.userId);
    const partnerRow = await h.pool.query<{ id: string; phone_e164: string }>(
      'SELECT u.id,u.phone_e164 FROM users u JOIN delivery_assignments a ON a.delivery_person_id=u.id WHERE a.id=$1',
      [assignmentId],
    );
    const partner = partnerRow.rows[0]!;
    const phone = partner.phone_e164!.replace(/^\\+91/, '');
    const requested = await h.request('POST', '/api/v1/delivery/auth/request-otp', { body: { phone } });
    assert.equal(requested.status, 202);
    const verified = await h.request('POST', '/api/v1/delivery/auth/verify-otp', { body: { phone, code: h.otpCodes.get(partner.phone_e164!) } });
    assert.equal(verified.status, 200);
    const token = verified.json.data.accessToken as string;

    assert.equal((await h.request('GET', '/api/v1/delivery/me/orders?tab=assigned', { token })).json.data.orders.length, 1);
    assert.equal((await h.request('POST', `/api/v1/delivery/me/orders/${orderId}/accept`, { token, body: {} })).status, 200);
    const reported = await h.request('POST', `/api/v1/delivery/me/orders/${orderId}/report-issue`, {
      token, body: { reason: 'customer_not_available', description: 'Customer asked for a short delay', clientRequestId: '6f3f4f7e-6db9-4a42-9c15-39a3e8d9d5f1' },
    });
    assert.equal(reported.status, 200, reported.body);
    const issueQueue = await h.request('GET', '/api/v1/admin/delivery-issues?status=open', { token: admin.token });
    assert.equal(issueQueue.status, 200, issueQueue.body);
    assert.ok(issueQueue.json.data.some((issue: { id: string }) => issue.id === reported.json.data.issueId));
    const resolved = await h.request('PATCH', `/api/v1/admin/delivery-issues/${reported.json.data.issueId}`, {
      token: admin.token, body: { status: 'resolved', resolution_note: 'Customer confirmed availability' },
    });
    assert.equal(resolved.status, 200, resolved.body);
    // The store must pack the order before the partner can pick it up (state machine).
    const early = await h.request('POST', `/api/v1/delivery/me/orders/${orderId}/pickup`, { token, body: {} });
    assert.equal(early.status, 409, early.body);
    assert.equal(early.json.error, 'ORDER_NOT_READY_FOR_PICKUP');
    for (const status of ['accepted', 'packed']) {
      const advanced = await h.request('PATCH', `/api/v1/admin/orders/${orderId}/status`, { token: admin.token, body: { status } });
      assert.equal(advanced.status, 200, advanced.body);
    }
    const pickup = await h.request('POST', `/api/v1/delivery/me/orders/${orderId}/pickup`, { token, body: {} });
    assert.equal(pickup.status, 200, pickup.body);
    const duplicatePickup = await h.request('POST', `/api/v1/delivery/me/orders/${orderId}/pickup`, { token, body: {} });
    assert.equal(duplicatePickup.status, 409, duplicatePickup.body);
    assert.equal(duplicatePickup.json.error, 'ALREADY_OUT_FOR_DELIVERY');

    const deliveryOtp = h.otpCodes.get('+919876543210');
    assert.ok(deliveryOtp, 'delivery OTP should be sent to the saved customer phone');
    await h.pool.query("UPDATE order_delivery_verifications SET expires_at=now()-interval '1 minute' WHERE order_id=$1", [orderId]);
    const expired = await h.request('POST', `/api/v1/delivery/me/orders/${orderId}/verify-otp`, { token, body: { otp: deliveryOtp } });
    assert.equal(expired.status, 410, expired.body);
    await h.pool.query("UPDATE order_delivery_verifications SET expires_at=now()+interval '5 minutes' WHERE order_id=$1", [orderId]);
    const wrong = deliveryOtp === '000000' ? '111111' : '000000';
    assert.equal((await h.request('POST', `/api/v1/delivery/me/orders/${orderId}/verify-otp`, { token, body: { otp: wrong } })).status, 400);
    const accepted = await h.request('POST', `/api/v1/delivery/me/orders/${orderId}/verify-otp`, { token, body: { otp: deliveryOtp } });
    assert.equal(accepted.status, 200, accepted.body);
    assert.equal(accepted.json.data.requiresCod, true);

    const total = await h.pool.query<{ total_paise: number }>('SELECT total_paise FROM orders WHERE id=$1', [orderId]);
    const amount = (Number(total.rows[0]!.total_paise) / 100).toFixed(2);
    const collected = await h.request('POST', `/api/v1/delivery/me/orders/${orderId}/cod-collection`, { token, body: { amount } });
    assert.equal(collected.status, 200, collected.body);
    const order = await h.pool.query<{ status: string; payment_status: string }>('SELECT status,payment_status FROM orders WHERE id=$1', [orderId]);
    assert.equal(order.rows[0]!.status, 'delivered');
    assert.equal(order.rows[0]!.payment_status, 'paid');
    const assignment = await h.pool.query<{ status: string }>('SELECT status FROM delivery_assignments WHERE id=$1', [assignmentId]);
    assert.equal(assignment.rows[0]!.status, 'completed');
  });
});
