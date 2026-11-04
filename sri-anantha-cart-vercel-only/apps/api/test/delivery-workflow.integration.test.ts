import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { hashOtp } from '../src/auth/security.js';
import { DELIVERY_OTP_MAX_ATTEMPTS, DELIVERY_OTP_MAX_SENDS, decryptDeliveryOtp, encryptDeliveryOtp } from '../src/delivery/workflow.js';
import { createHarness, skipReason, type Harness } from './support/harness.js';

const CUSTOMER_PHONE = '+919876543210'; // phone on h.seed.address

describe('delivery OTP encryption', () => {
  it('round-trips, is randomised and rejects tampering or a different secret', () => {
    const secret = 'a-session-secret-that-is-long-enough-123456';
    const a = encryptDeliveryOtp('123456', secret);
    assert.notEqual(a, encryptDeliveryOtp('123456', secret));
    assert.equal(decryptDeliveryOtp(a, secret), '123456');
    assert.equal(decryptDeliveryOtp(a, secret + 'x'), null);
    const parts = a.split(':');
    parts[3] = Buffer.from('999999').toString('base64url');
    assert.equal(decryptDeliveryOtp(parts.join(':'), secret), null);
    assert.equal(decryptDeliveryOtp('', secret), null);
  });
});

describe('self-delivery workflow rules (integration)', { skip: skipReason }, () => {
  let h: Harness;
  let admin: { token: string; userId: string };
  let categoryId = '';
  let phoneSeq = 0;

  const partnerLogin = async () => {
    const phone10 = `8${String(Date.now()).slice(-6)}${String(phoneSeq++).padStart(3, '0')}`;
    const created = await h.pool.query<{ id: string }>(`INSERT INTO users(phone_e164, role, display_name) VALUES ($1, 'delivery_partner', 'Rider') RETURNING id`, [`+91${phone10}`]);
    assert.equal((await h.request('POST', '/api/v1/delivery/auth/request-otp', { body: { phone: phone10 } })).status, 202);
    const verified = await h.request('POST', '/api/v1/delivery/auth/verify-otp', { body: { phone: phone10, code: h.otpCodes.get(`+91${phone10}`) } });
    assert.equal(verified.status, 200, verified.body);
    return { id: created.rows[0]!.id, token: verified.json.data.accessToken as string, phone10 };
  };
  const advance = async (orderId: string, ...statuses: string[]) => {
    for (const status of statuses) {
      const response = await h.request('PATCH', `/api/v1/admin/orders/${orderId}/status`, { token: admin.token, body: { status } });
      assert.equal(response.status, 200, `${status}: ${response.body}`);
    }
  };
  const assign = async (orderId: string, partnerId: string) => {
    const response = await h.request('POST', `/api/v1/admin/orders/${orderId}/delivery-assignment`, { token: admin.token, body: { delivery_person_id: partnerId } });
    assert.ok([200, 201].includes(response.status), response.body);
  };
  /** A COD order (customer phone CUSTOMER_PHONE) assigned to a freshly signed-in partner. */
  const assignedOrder = async (options: { prepaid?: boolean } = {}) => {
    const customer = await h.login(`91${String(Date.now()).slice(-6)}${String(phoneSeq++).padStart(2, '0')}`);
    const product = await h.seed.product({ categoryId, price: 15000, stock: 20 });
    const addressId = await h.seed.address(customer.token);
    const placed = await h.placeOrder(customer.token, addressId, [{ product_id: product.id, quantity: 1 }]);
    assert.equal(placed.status, 201, placed.body);
    const orderId = placed.json.data.order_id as string;
    if (options.prepaid) await h.pool.query(`UPDATE orders SET payment_method = 'upi', payment_status = 'paid' WHERE id = $1`, [orderId]);
    const partner = await partnerLogin();
    await assign(orderId, partner.id);
    return { orderId, partner, customer };
  };
  const act = (partner: { token: string }, orderId: string, action: string, body: unknown = {}) =>
    h.request('POST', `/api/v1/delivery/me/orders/${orderId}/${action}`, { token: partner.token, body });
  const auditActions = async (orderId: string) =>
    (await h.pool.query<{ action: string; metadata: Record<string, unknown> }>(`SELECT action, metadata FROM admin_audit_logs WHERE resource_id = $1 ORDER BY created_at, id`, [orderId])).rows;
  /** Pick up a packed order and return the code the customer received. */
  const pickUp = async (partner: { token: string }, orderId: string) => {
    assert.equal((await act(partner, orderId, 'accept')).status, 200);
    const pickup = await act(partner, orderId, 'pickup');
    assert.equal(pickup.status, 200, pickup.body);
    return h.otpCodes.get(CUSTOMER_PHONE)!;
  };

  before(async () => {
    h = await createHarness();
    categoryId = await h.seed.category();
    await h.seed.zone({ postal: ['517501'], cod: true });
    admin = await h.login('9100000501', 'admin');
  });
  after(async () => { await h?.close(); });

  it('migration 035 pins search_path on the delivery partner functions from 032', async () => {
    const rows = (await h.pool.query<{ proname: string; config: string[] | null }>(
      `SELECT p.proname, p.proconfig AS config FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = current_schema() AND p.proname IN ('sac_next_delivery_partner_code', 'sac_assign_delivery_partner_code') ORDER BY 1`)).rows;
    assert.equal(rows.length, 2);
    for (const row of rows) assert.ok(row.config?.some(setting => /^search_path=.+pg_temp$/.test(setting)), `${row.proname}: ${row.config}`);
  });

  it('a partner provisioned with a temporary password can use the portal by SMS code, but no staff route', async () => {
    // Staff provisioning (admin Staff screen, staff:grant) gives partners a temporary password they never use.
    const partner = await partnerLogin();
    await h.pool.query(`UPDATE users SET must_change_password = TRUE WHERE id = $1`, [partner.id]);
    const me = await h.request('GET', '/api/v1/delivery/me', { token: partner.token });
    assert.equal(me.status, 200, me.body);
    assert.equal((await h.request('GET', '/api/v1/delivery/me/orders?tab=assigned', { token: partner.token })).status, 200);
    for (const url of ['/api/v1/admin/orders', '/api/v1/admin/delivery-partners', '/api/v1/admin/delivery-issues']) {
      assert.equal((await h.request('GET', url, { token: partner.token })).status, 403, url);
    }
    // Admin and operator sessions with a temporary password are still held at the change-password step.
    const operator = await h.login('9100000511', 'operator');
    await h.pool.query(`UPDATE users SET must_change_password = TRUE WHERE id = $1`, [operator.userId]);
    const blocked = await h.request('GET', '/api/v1/admin/orders', { token: operator.token });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.json.error, 'PASSWORD_CHANGE_REQUIRED');
  });

  it('only the assigned partner can see or act on an order; customers and admins cannot use partner routes', async () => {
    const { orderId, partner, customer } = await assignedOrder();
    const other = await partnerLogin();
    assert.equal((await h.request('GET', `/api/v1/delivery/me/orders/${orderId}`, { token: other.token })).status, 404);
    for (const action of ['accept', 'reject', 'pickup', 'resend-otp', 'report-issue']) {
      const body = action === 'reject' ? { reason: 'too_far' } : action === 'report-issue' ? { reason: 'customer_not_available', clientRequestId: randomUUID() } : {};
      assert.equal((await act(other, orderId, action, body)).status, 404, action);
    }
    assert.equal((await h.request('GET', '/api/v1/delivery/me/orders?tab=assigned', { token: customer.token })).status, 403);
    assert.equal((await h.request('GET', '/api/v1/delivery/me/orders?tab=assigned', { token: admin.token })).status, 403);
    const own = await h.request('GET', '/api/v1/delivery/me/orders?tab=assigned', { token: partner.token });
    assert.deepEqual(own.json.data.orders.map((o: { orderId: string }) => o.orderId), [orderId]);
  });

  it('pickup follows the order state machine and re-checks payment', async () => {
    const { orderId, partner } = await assignedOrder();
    assert.equal((await act(partner, orderId, 'pickup')).json.error, 'ASSIGNMENT_NOT_ACCEPTED');
    assert.equal((await act(partner, orderId, 'accept')).status, 200);
    for (const status of [null, 'accepted']) {
      if (status) await advance(orderId, status);
      const early = await act(partner, orderId, 'pickup');
      assert.equal(early.status, 409);
      assert.equal(early.json.error, 'ORDER_NOT_READY_FOR_PICKUP');
    }
    assert.equal((await h.pool.query('SELECT status FROM orders WHERE id = $1', [orderId])).rows[0].status, 'accepted', 'a refused pickup changes nothing');
    await advance(orderId, 'packed');
    // Payment changed after assignment (e.g. reconciled as failed): pickup must refuse.
    await h.pool.query(`UPDATE orders SET payment_method = 'upi', payment_status = 'failed' WHERE id = $1`, [orderId]);
    const unpaid = await act(partner, orderId, 'pickup');
    assert.equal(unpaid.status, 409);
    assert.equal(unpaid.json.error, 'ORDER_NOT_PAID');
    await h.pool.query(`UPDATE orders SET payment_method = 'cod', payment_status = 'pending' WHERE id = $1`, [orderId]);
    assert.equal((await act(partner, orderId, 'pickup')).status, 200);
    assert.equal((await h.pool.query('SELECT status FROM orders WHERE id = $1', [orderId])).rows[0].status, 'dispatched');
    const audits = await auditActions(orderId);
    assert.ok(audits.some(a => a.action === 'order.status_changed' && a.metadata.from === 'packed' && a.metadata.to === 'dispatched' && a.metadata.via === 'delivery_partner_pickup'));
    assert.ok(audits.some(a => a.action === 'delivery_assignment.accepted'));
    assert.ok(audits.some(a => a.action === 'delivery.picked_up'));
  });

  it('a partner can reject before pickup; the store reassigns and the new partner continues', async () => {
    const { orderId, partner } = await assignedOrder();
    assert.equal((await act(partner, orderId, 'reject', { reason: 'other' })).json.error, 'NOTE_REQUIRED');
    const rejected = await act(partner, orderId, 'reject', { reason: 'vehicle_unavailable' });
    assert.equal(rejected.status, 200, rejected.body);
    const state = (await h.pool.query(`SELECT o.delivery_exception, a.status, a.rejection_reason FROM orders o JOIN delivery_assignments a ON a.order_id = o.id WHERE o.id = $1`, [orderId])).rows[0];
    assert.deepEqual(state, { delivery_exception: 'reassignment_required', status: 'reassignment_required', rejection_reason: 'vehicle_unavailable' });
    assert.equal((await act(partner, orderId, 'accept')).status, 404, 'a rejected assignment is no longer actionable');
    assert.ok((await auditActions(orderId)).some(a => a.action === 'delivery_assignment.rejected'));

    const replacement = await partnerLogin();
    await assign(orderId, replacement.id);
    assert.equal((await h.pool.query('SELECT delivery_exception FROM orders WHERE id = $1', [orderId])).rows[0].delivery_exception, null);
    await advance(orderId, 'accepted', 'packed');
    await pickUp(replacement, orderId);
    const late = await act(replacement, orderId, 'reject', { reason: 'too_far' });
    assert.equal(late.status, 409);
    assert.equal(late.json.error, 'ALREADY_PICKED_UP');
  });

  it('customer delivery OTP: 10-minute expiry, resend invalidates the old code, cooldown, send cap, attempt limit, one-time use', async () => {
    const { orderId, partner } = await assignedOrder({ prepaid: true });
    await advance(orderId, 'accepted', 'packed');
    const first = await pickUp(partner, orderId);
    const row = (await h.pool.query(`SELECT otp_hash, otp_ciphertext, EXTRACT(EPOCH FROM (expires_at - now())) AS ttl, send_count FROM order_delivery_verifications WHERE order_id = $1`, [orderId])).rows[0];
    assert.ok(Number(row.ttl) > 9 * 60 && Number(row.ttl) <= 10 * 60, `ttl ${row.ttl}`);
    assert.ok(!row.otp_hash.includes(first) && !row.otp_ciphertext.includes(first), 'the code is never stored in plain text');
    assert.equal(Number(row.send_count), 1);

    const cooldown = await act(partner, orderId, 'resend-otp');
    assert.equal(cooldown.status, 429);
    assert.equal(cooldown.json.error, 'OTP_RESEND_COOLDOWN');
    await h.pool.query(`UPDATE order_delivery_verifications SET last_sent_at = now() - interval '2 minutes' WHERE order_id = $1`, [orderId]);
    const resent = await act(partner, orderId, 'resend-otp');
    assert.equal(resent.status, 200, resent.body);
    const second = h.otpCodes.get(CUSTOMER_PHONE)!;
    if (second !== first) {
      const stale = await act(partner, orderId, 'verify-otp', { otp: first });
      assert.equal(stale.status, 400, 'the previous code no longer verifies');
      assert.equal(stale.json.attemptsRemaining, DELIVERY_OTP_MAX_ATTEMPTS - 1);
    }

    // Exhaust the send cap.
    for (let sent = 2; sent < DELIVERY_OTP_MAX_SENDS; sent++) {
      await h.pool.query(`UPDATE order_delivery_verifications SET last_sent_at = now() - interval '2 minutes' WHERE order_id = $1`, [orderId]);
      assert.equal((await act(partner, orderId, 'resend-otp')).status, 200);
    }
    await h.pool.query(`UPDATE order_delivery_verifications SET last_sent_at = now() - interval '2 minutes' WHERE order_id = $1`, [orderId]);
    const capped = await act(partner, orderId, 'resend-otp');
    assert.equal(capped.status, 429);
    assert.equal(capped.json.error, 'OTP_SEND_LIMIT');
    const latest = h.otpCodes.get(CUSTOMER_PHONE)!;

    // Attempt limit on the current code.
    const wrong = latest === '000000' ? '111111' : '000000';
    for (let i = 0; i < DELIVERY_OTP_MAX_ATTEMPTS; i++) assert.equal((await act(partner, orderId, 'verify-otp', { otp: wrong })).status, 400);
    const locked = await act(partner, orderId, 'verify-otp', { otp: latest });
    assert.equal(locked.status, 429, 'even the right code is refused once the attempt limit is reached');
    assert.equal(locked.json.error, 'OTP_ATTEMPTS_EXCEEDED');

    // Expiry.
    await h.pool.query(`UPDATE order_delivery_verifications SET failed_attempts = 0, expires_at = now() - interval '1 second' WHERE order_id = $1`, [orderId]);
    assert.equal((await act(partner, orderId, 'verify-otp', { otp: latest })).status, 410);

    // Valid code: delivered (prepaid), one-time use, ciphertext erased, audited.
    await h.pool.query(`UPDATE order_delivery_verifications SET expires_at = now() + interval '5 minutes' WHERE order_id = $1`, [orderId]);
    const ok = await act(partner, orderId, 'verify-otp', { otp: latest });
    assert.equal(ok.status, 200, ok.body);
    assert.deepEqual(ok.json.data, { delivered: true, requiresCod: false });
    const after = (await h.pool.query(`SELECT v.verified_at IS NOT NULL AS verified, v.otp_ciphertext, o.status FROM order_delivery_verifications v JOIN orders o ON o.id = v.order_id WHERE v.order_id = $1`, [orderId])).rows[0];
    assert.deepEqual(after, { verified: true, otp_ciphertext: '', status: 'delivered' });
    const reuse = await act(partner, orderId, 'verify-otp', { otp: latest });
    assert.equal(reuse.status, 404, 'a completed assignment cannot verify again');
    const audits = await auditActions(orderId);
    assert.ok(audits.some(a => a.action === 'order.delivery_otp_verified'));
    assert.ok(audits.some(a => a.action === 'order.status_changed' && a.metadata.to === 'delivered' && a.metadata.via === 'delivery_partner_otp'));
  });

  it('the customer sees their delivery code only while their order is out for delivery', async () => {
    const { orderId, partner, customer } = await assignedOrder();
    const view = (token: string) => h.request('GET', `/api/v1/orders/${orderId}/delivery-otp`, { token });
    assert.equal((await view(customer.token)).status, 404, 'no code before pickup');
    await advance(orderId, 'accepted', 'packed');
    const sent = await pickUp(partner, orderId);

    const shown = await view(customer.token);
    assert.equal(shown.status, 200, shown.body);
    assert.equal(shown.json.data.status, 'active');
    assert.equal(shown.json.data.otp, sent, 'the screen shows the same code the customer was sent');
    assert.equal(shown.headers['cache-control'], 'no-store');

    const stranger = await h.login('9100000777');
    assert.equal((await view(stranger.token)).status, 404, 'another customer cannot see it');
    assert.equal((await view(admin.token)).status, 404, 'staff cannot read the code through the customer route');
    assert.equal((await view(partner.token)).status, 404, 'the partner cannot read the code');
    const partnerView = await h.request('GET', `/api/v1/delivery/me/orders/${orderId}`, { token: partner.token });
    assert.equal(partnerView.status, 200, partnerView.body);
    assert.ok(!JSON.stringify(partnerView.json).includes(sent), 'the partner order detail never contains the code');
    const adminView = await h.request('GET', `/api/v1/admin/orders/${orderId}`, { token: admin.token });
    assert.equal(adminView.status, 200, adminView.body);
    assert.ok(!JSON.stringify(adminView.json).includes(sent), 'the admin order detail never contains the code');

    // Expired: no code is shown; the customer can request a new one (subject to the cooldown).
    await h.pool.query(`UPDATE order_delivery_verifications SET expires_at = now() - interval '1 second' WHERE order_id = $1`, [orderId]);
    const expired = await view(customer.token);
    assert.deepEqual([expired.json.data.status, expired.json.data.otp, expired.json.data.can_request_new], ['expired', null, true]);
    const tooSoon = await h.request('POST', `/api/v1/orders/${orderId}/delivery-otp/resend`, { token: customer.token, body: {} });
    assert.equal(tooSoon.status, 429);
    await h.pool.query(`UPDATE order_delivery_verifications SET last_sent_at = now() - interval '2 minutes' WHERE order_id = $1`, [orderId]);
    assert.equal((await h.request('POST', `/api/v1/orders/${orderId}/delivery-otp/resend`, { token: stranger.token, body: {} })).status, 404);
    const renewed = await h.request('POST', `/api/v1/orders/${orderId}/delivery-otp/resend`, { token: customer.token, body: {} });
    assert.equal(renewed.status, 200, renewed.body);
    const fresh = renewed.json.data.otp as string;
    assert.equal(h.otpCodes.get(CUSTOMER_PHONE), fresh, 'the new code is also sent by SMS');
    assert.equal((await view(customer.token)).json.data.otp, fresh);
    assert.ok((await auditActions(orderId)).some(a => a.action === 'order.delivery_otp_resent'));

    // Once used, the code is gone.
    assert.equal((await act(partner, orderId, 'verify-otp', { otp: fresh })).status, 200);
    assert.equal((await view(customer.token)).status, 404);
  });

  it('COD: exact amount only, one collection row, idempotent retry, payment attributed to the partner', async () => {
    const { orderId, partner } = await assignedOrder();
    await advance(orderId, 'accepted', 'packed');
    const code = await pickUp(partner, orderId);
    assert.equal((await act(partner, orderId, 'cod-collection', { amount: '150.00' })).json.error, 'DELIVERY_OTP_REQUIRED');
    const verified = await act(partner, orderId, 'verify-otp', { otp: code });
    assert.equal(verified.json.data.requiresCod, true);
    const total = Number((await h.pool.query('SELECT total_paise FROM orders WHERE id = $1', [orderId])).rows[0].total_paise);
    const short = await act(partner, orderId, 'cod-collection', { amount: ((total - 100) / 100).toFixed(2) });
    assert.equal(short.status, 409);
    assert.equal(short.json.error, 'COD_AMOUNT_MISMATCH');
    const amount = (total / 100).toFixed(2);
    const collected = await act(partner, orderId, 'cod-collection', { amount });
    assert.deepEqual(collected.json.data, { delivered: true, duplicate: false });
    const retry = await act(partner, orderId, 'cod-collection', { amount });
    assert.deepEqual(retry.json.data, { delivered: true, duplicate: true });
    const rows = (await h.pool.query(`SELECT c.amount_paise, c.collected_by, p.status AS payment, p.collected_by AS payment_collector, o.status, o.payment_status
        FROM order_cod_collections c JOIN orders o ON o.id = c.order_id JOIN payments p ON p.order_id = o.id WHERE c.order_id = $1`, [orderId])).rows;
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], { amount_paise: total, collected_by: partner.id, payment: 'succeeded', payment_collector: partner.id, status: 'delivered', payment_status: 'paid' });
    assert.ok((await auditActions(orderId)).some(a => a.action === 'order.cod_collected'));
  });

  it('staff cannot dispatch or deliver a self-delivery order; the partner hand-over is required', async () => {
    const { orderId } = await assignedOrder();
    await advance(orderId, 'accepted', 'packed');
    for (const status of ['dispatched', 'delivered']) {
      const bypass = await h.request('PATCH', `/api/v1/admin/orders/${orderId}/status`, { token: admin.token, body: { status } });
      assert.equal(bypass.status, 409, status);
      assert.equal(bypass.json.error, status === 'dispatched' ? 'DELIVERY_PARTNER_ACTION_REQUIRED' : 'INVALID_ORDER_TRANSITION');
    }
    assert.equal((await h.pool.query('SELECT status FROM orders WHERE id = $1', [orderId])).rows[0].status, 'packed');
  });

  it('an order cannot be reassigned after pickup except through the reassignment-required exception', async () => {
    const { orderId, partner } = await assignedOrder();
    await advance(orderId, 'accepted', 'packed');
    await pickUp(partner, orderId);
    const replacement = await partnerLogin();
    const blocked = await h.request('POST', `/api/v1/admin/orders/${orderId}/delivery-assignment`, { token: admin.token, body: { delivery_person_id: replacement.id } });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.error, 'DELIVERY_ALREADY_PICKED_UP');

    // Exception workflow: the partner reports a problem, an admin marks it reassignment_required.
    const issue = await act(partner, orderId, 'report-issue', { reason: 'other', description: 'Vehicle broke down', clientRequestId: randomUUID() });
    const marked = await h.request('PATCH', `/api/v1/admin/delivery-issues/${issue.json.data.issueId}`, { token: admin.token, body: { status: 'reassignment_required', resolution_note: 'Hand over to another rider' } });
    assert.equal(marked.status, 200, marked.body);
    const reassigned = await h.request('POST', `/api/v1/admin/orders/${orderId}/delivery-assignment`, { token: admin.token, body: { delivery_person_id: replacement.id } });
    assert.equal(reassigned.status, 201, reassigned.body);
    assert.equal((await act(partner, orderId, 'verify-otp', { otp: '123456' })).status, 404, 'the previous partner can no longer act');

    // The new partner takes over: accept, pick up (issues a fresh code) and deliver.
    const code = await pickUp(replacement, orderId);
    assert.equal((await act(replacement, orderId, 'verify-otp', { otp: code })).json.data.requiresCod, true);
    const total = Number((await h.pool.query('SELECT total_paise FROM orders WHERE id = $1', [orderId])).rows[0].total_paise);
    assert.equal((await act(replacement, orderId, 'cod-collection', { amount: (total / 100).toFixed(2) })).status, 200);
    const events = (await h.pool.query<{ event: string }>(`SELECT event FROM delivery_assignment_events WHERE order_id = $1 ORDER BY created_at, id`, [orderId])).rows.map(r => r.event);
    for (const event of ['assigned', 'out_for_delivery', 'issue_reported', 'cancelled', 'delivered']) assert.ok(events.includes(event), `${event} recorded: ${events.join(',')}`);
  });

  it('cancelling an order ends the assignment and invalidates an outstanding delivery code', async () => {
    const { orderId, partner } = await assignedOrder();
    await advance(orderId, 'accepted', 'packed');
    await act(partner, orderId, 'accept');
    // Admin can cancel only before dispatch; simulate a code issued for a packed order then cancelled.
    await h.pool.query(`INSERT INTO order_delivery_verifications(order_id, otp_hash, otp_ciphertext, expires_at) VALUES ($1, repeat('a', 64), 'v1:x:y:z', now() + interval '10 minutes')`, [orderId]);
    const cancelled = await h.request('POST', `/api/v1/admin/orders/${orderId}/cancel`, { token: admin.token, body: { reason: 'Customer called to cancel' } });
    assert.equal(cancelled.status, 200, cancelled.body);
    assert.equal((await act(partner, orderId, 'pickup')).status, 404);
    const otp = (await h.pool.query(`SELECT otp_ciphertext, expires_at <= now() AS expired FROM order_delivery_verifications WHERE order_id = $1`, [orderId])).rows[0];
    assert.deepEqual(otp, { otp_ciphertext: '', expired: true });
  });

  it('a customer sign-in code cannot open a delivery-partner session', async () => {
    const secret = 'integration-test-secret-0123456789abcdef'; // harness SESSION_SECRET
    const phone = '+918000000777';
    await h.pool.query(`INSERT INTO users(phone_e164, role) VALUES ($1, 'delivery_partner')`, [phone]);
    const plant = (hash: string) => h.pool.query(
      `INSERT INTO otp_challenges(phone_e164, code_hash, expires_at) VALUES ($1, $2, now() + interval '5 minutes')`, [phone, hash]);
    // A challenge hashed the way the customer sign-in flow hashes it is refused by the partner endpoint...
    await plant(hashOtp(phone, '246810', secret));
    const customerStyle = await h.request('POST', '/api/v1/delivery/auth/verify-otp', { body: { phone: '8000000777', code: '246810' } });
    assert.equal(customerStyle.status, 401);
    // ...while a partner-subject challenge with the same code is accepted.
    await h.pool.query('DELETE FROM otp_challenges WHERE phone_e164 = $1', [phone]);
    await plant(hashOtp(`delivery-partner-login:${phone}`, '246810', secret));
    const partnerStyle = await h.request('POST', '/api/v1/delivery/auth/verify-otp', { body: { phone: '8000000777', code: '246810' } });
    assert.equal(partnerStyle.status, 200, partnerStyle.body);
  });

  it('partner OTP routes and issue reports are reflected in the admin issue queue', async () => {
    const { orderId, partner } = await assignedOrder();
    assert.equal((await act(partner, orderId, 'report-issue', { reason: 'incorrect_address', clientRequestId: randomUUID() })).json.error, 'ASSIGNMENT_NOT_ACCEPTED');
    await act(partner, orderId, 'accept');
    const requestId = randomUUID();
    const first = await act(partner, orderId, 'report-issue', { reason: 'incorrect_address', clientRequestId: requestId });
    const again = await act(partner, orderId, 'report-issue', { reason: 'incorrect_address', clientRequestId: requestId });
    assert.equal(first.json.data.issueId, again.json.data.issueId, 'a retried report is idempotent');
    const queue = await h.request('GET', '/api/v1/admin/delivery-issues?status=open&limit=5', { token: admin.token });
    assert.equal(queue.status, 200, queue.body);
    assert.ok(queue.json.data.some((issue: { id: string }) => issue.id === first.json.data.issueId));
    assert.ok((await auditActions(orderId)).some(a => a.action === 'delivery.issue_reported'));
  });
});
