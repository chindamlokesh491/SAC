// Browser end-to-end test of local self-delivery with the delivery-partner PWA (/partner on the admin app):
// the store assigns a COD order, the partner signs in on a phone-sized screen, accepts, picks up, verifies the
// customer's delivery code (read from the customer's own order page) and records the cash.
//
//   E2E_BASE_URL / E2E_ADMIN_URL   storefront and admin origins (defaults http://localhost:3000 / :3001)
//   E2E_OTP_OUTBOX                 the API's OTP_DEV_OUTBOX file (API must run with OTP_PROVIDER=dev-outbox)
//   E2E_DELIVERY_PARTNER_PHONE     10-digit number provisioned as delivery_partner (staff:grant ... delivery_partner)
//   E2E_OPERATOR_PHONE / E2E_OPERATOR_PASSWORD
//                                  an operator with a temporary password (staff:grant ... operator). This test sets
//                                  its own new password, so re-run staff:grant before each local run. A separate account
//                                  from E2E_ADMIN_PHONE keeps this file independent of storefront-admin.e2e.cjs.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { after, before, describe, it } = require('node:test');
const { chromium } = require('playwright');

const base = (process.env.E2E_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminBase = (process.env.E2E_ADMIN_URL || 'http://localhost:3001').replace(/\/$/, '');
const outbox = process.env.E2E_OTP_OUTBOX;
const partnerPhone = process.env.E2E_DELIVERY_PARTNER_PHONE;
const operatorPhone = process.env.E2E_OPERATOR_PHONE;
const operatorPassword = process.env.E2E_OPERATOR_PASSWORD;
const skip = !outbox || !partnerPhone || !operatorPhone || !operatorPassword
  ? 'Set E2E_OTP_OUTBOX, E2E_DELIVERY_PARTNER_PHONE, E2E_OPERATOR_PHONE and E2E_OPERATOR_PASSWORD to run the delivery-partner E2E test' : false;
const customerPhone = `96${String(Date.now()).slice(-8)}`;

async function latestOtp(phone10, notBefore) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const lines = fs.existsSync(outbox) ? fs.readFileSync(outbox, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    const match = lines.filter(line => line.phone === `+91${phone10}` && (!line.at || Date.parse(line.at) >= notBefore - 1000)).at(-1);
    if (match) return match.code;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`No OTP was delivered to ${phone10}`);
}

/** JSON API call through the storefront origin (same rewrite the browser uses), bearer-authenticated. */
async function call(method, path, { token, body, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { /* non-JSON */ }
  return { status: response.status, json, text };
}

async function customerSession() {
  const sentAt = Date.now();
  const requested = await call('POST', '/api/v1/auth/otp/request', { body: { phone: customerPhone } });
  assert.equal(requested.status, 202, requested.text);
  const verified = await call('POST', '/api/v1/auth/otp/verify', { body: { phone: customerPhone, code: await latestOtp(customerPhone, sentAt) } });
  assert.equal(verified.status, 200, verified.text);
  return verified.json.data.accessToken;
}

async function operatorSession() {
  const login = await call('POST', '/api/v1/auth/staff/login', { body: { phone: operatorPhone, password: operatorPassword } });
  assert.equal(login.status, 200, `operator login failed (re-run staff:grant for ${operatorPhone}): ${login.text}`);
  const token = login.json.data.accessToken;
  if (login.json.data.user.must_change_password) {
    const changed = await call('POST', '/api/v1/auth/staff/password', { token, body: { current_password: operatorPassword, new_password: `Op-${crypto.randomBytes(12).toString('hex')}-Zz9` } });
    assert.equal(changed.status, 200, changed.text);
  }
  return token;
}

async function placeCodOrder(token) {
  const products = await call('GET', '/api/v1/products?in_stock=true&limit=5', { token });
  const product = products.json.data.find(item => !item.has_variants) ?? products.json.data[0];
  assert.ok(product, 'demo catalogue must contain an in-stock product');
  const address = await call('POST', '/api/v1/addresses', { token, body: { recipient_name: 'E2E Customer', phone_e164: customerPhone, line1: '1 Temple Street', locality: 'Balaji Colony', postal_code: '517501' } });
  assert.equal(address.status, 201, address.text);
  const addressId = address.json.data.id;
  const added = await call('POST', '/api/v1/cart/items', { token, body: { product_id: product.id, variant_id: null, quantity: 2 } });
  assert.equal(added.status, 200, added.text);
  const quote = (await call('GET', `/api/v1/cart?address_id=${addressId}`, { token })).json.data;
  const delivery = quote.delivery.express.available ? { mode: 'express' } : { mode: 'scheduled', slot_id: quote.delivery.scheduled[0].slot_id, date: quote.delivery.scheduled[0].date };
  const checkout = await call('POST', '/api/v1/orders/checkout', {
    token, headers: { 'idempotency-key': `e2e-${crypto.randomUUID()}` },
    body: { address_id: addressId, delivery, payment_method: 'cod', expected_total_paise: quote.total_paise },
  });
  assert.equal(checkout.status, 201, checkout.text);
  return { orderId: checkout.json.data.order_id, totalPaise: quote.total_paise };
}

describe('delivery partner PWA (browser E2E)', { skip }, () => {
  let browser;
  const errors = [];
  const watch = page => {
    page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
    page.on('console', message => { if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) errors.push(`console: ${message.text()}`); });
  };
  before(async () => { browser = await chromium.launch(); });
  after(async () => { await browser?.close(); });

  it('a partner delivers a COD order end to end with the customer delivery code', async () => {
    const customerToken = await customerSession();
    const operatorToken = await operatorSession();
    const { orderId, totalPaise } = await placeCodOrder(customerToken);

    // Store: accept, pack and assign the provisioned partner.
    for (const status of ['accepted', 'packed']) {
      const advanced = await call('PATCH', `/api/v1/admin/orders/${orderId}/status`, { token: operatorToken, body: { status } });
      assert.equal(advanced.status, 200, advanced.text);
    }
    const partners = (await call('GET', '/api/v1/admin/delivery-partners', { token: operatorToken })).json.data;
    const partner = partners.find(item => item.phone_e164 === `+91${partnerPhone}`);
    assert.ok(partner, `E2E_DELIVERY_PARTNER_PHONE ${partnerPhone} must be an active delivery partner`);
    const assigned = await call('POST', `/api/v1/admin/orders/${orderId}/delivery-assignment`, { token: operatorToken, body: { delivery_person_id: partner.id } });
    assert.ok([200, 201].includes(assigned.status), assigned.text);

    // Partner: sign in on a phone-sized screen.
    const partnerContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const rider = await partnerContext.newPage();
    watch(rider);
    await rider.goto(`${adminBase}/partner`, { waitUntil: 'networkidle' });
    await rider.waitForURL(/\/partner\/login/);
    await rider.fill('#partner-phone', partnerPhone);
    let sentAt = Date.now();
    await rider.getByRole('button', { name: 'Send code' }).click();
    const outcome = await Promise.race([
      rider.waitForSelector('#partner-code').then(() => 'sent'),
      rider.waitForSelector('text=/Wait before requesting/i').then(() => 'cooldown'),
    ]);
    if (outcome === 'cooldown') {
      await rider.waitForTimeout(61_000);
      sentAt = Date.now();
      await rider.getByRole('button', { name: 'Send code' }).click();
      await rider.waitForSelector('#partner-code');
    }
    await rider.fill('#partner-code', await latestOtp(partnerPhone, sentAt));
    await rider.getByRole('button', { name: 'Verify and continue' }).click();
    await rider.waitForURL(url => url.pathname === '/partner');

    // The new assignment is listed; open it and accept.
    const card = rider.locator(`a.partner-order[data-order-id="${orderId}"]`);
    await card.waitFor();
    await card.click();
    await rider.waitForURL(new RegExp(`/partner/orders/${orderId}`));
    await rider.getByRole('button', { name: 'Accept order' }).click();
    await rider.getByRole('button', { name: 'Picked up, start delivery' }).click();
    await rider.locator('#delivery-otp').waitFor();
    assert.equal(await rider.locator('body').evaluate(body => body.scrollWidth <= window.innerWidth + 1), true, 'no horizontal scrolling on a phone');

    // Customer: the delivery code is on their own order page.
    const customerContext = await browser.newContext();
    await customerContext.addCookies([{ name: 'sac_session', value: customerToken, url: base }]);
    await customerContext.addInitScript(() => { localStorage.setItem('sac-guest-tour-done', '1'); localStorage.setItem('sac-pin-asked', '1'); });
    const shopper = await customerContext.newPage();
    watch(shopper);
    await shopper.goto(`${base}/account/orders/${orderId}`, { waitUntil: 'networkidle' });
    const codeElement = shopper.getByTestId('delivery-otp');
    await codeElement.waitFor();
    const code = (await codeElement.innerText()).trim();
    assert.match(code, /^\d{6}$/);

    // Partner: a wrong code is refused, the customer's code is accepted, then cash is recorded.
    await rider.fill('#delivery-otp', code === '000000' ? '111111' : '000000');
    await rider.getByRole('button', { name: 'Verify code' }).click();
    await rider.getByRole('alert').filter({ hasText: 'incorrect' }).waitFor();
    await rider.fill('#delivery-otp', code);
    await rider.getByRole('button', { name: 'Verify code' }).click();
    await rider.locator('#cod-amount').waitFor();
    const due = (totalPaise / 100).toFixed(2);
    assert.match(await rider.getByLabel('Amount due').innerText(), new RegExp(due.replace('.', '\\.')));
    await rider.fill('#cod-amount', '1');
    await rider.getByRole('button', { name: 'Cash collected, complete delivery' }).click();
    await rider.getByRole('alert').filter({ hasText: 'exact COD amount' }).waitFor();
    await rider.fill('#cod-amount', due);
    await rider.getByRole('button', { name: 'Cash collected, complete delivery' }).click();
    await rider.getByRole('heading', { name: 'Delivered' }).waitFor();

    // Customer: the order is delivered and the code is gone.
    await shopper.reload({ waitUntil: 'networkidle' });
    await shopper.locator('.account-head').getByText('Delivered').waitFor();
    assert.equal(await shopper.getByTestId('delivery-otp').count(), 0);

    // Partner history shows the completed delivery.
    await rider.goto(`${adminBase}/partner`, { waitUntil: 'networkidle' });
    await rider.getByRole('tab', { name: 'Done' }).click();
    await rider.locator(`a.partner-order[data-order-id="${orderId}"]`).waitFor();
    await partnerContext.close();
    await customerContext.close();
  });

  it('no partner or customer page threw a script error', () => {
    assert.deepEqual(errors, []);
  });
});
