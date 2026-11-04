// Browser end-to-end tests: a real customer order on the web store, fulfilled by staff in the
// admin panel, plus access-control checks. Runs against a live stack (API + web + seeded DB).
//
//   E2E_BASE_URL       storefront origin (default http://localhost:3000)
//   E2E_ADMIN_URL      admin app origin (default http://localhost:3001)
//   E2E_OTP_OUTBOX     the API's OTP_DEV_OUTBOX file (API must run with OTP_PROVIDER=dev-outbox)
//   E2E_ADMIN_PHONE    10-digit staff number, and E2E_ADMIN_PASSWORD its temporary password. Create both with
//                      STAFF_PASSWORD=<password> pnpm --filter @sac/api staff:grant -- <phone> admin
//                      (re-run before each local run: the test replaces the temporary password, as a real owner would).
//
// The database must contain the demo catalogue (pnpm --filter @sac/api seed:demo).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { after, before, describe, it } = require('node:test');
const { chromium } = require('playwright');

const base = (process.env.E2E_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
// The admin panel is a separate app (apps/admin), served on its own origin.
const adminBase = (process.env.E2E_ADMIN_URL || 'http://localhost:3001').replace(/\/$/, '');
const outbox = process.env.E2E_OTP_OUTBOX;
const adminPhone = process.env.E2E_ADMIN_PHONE;
const adminPassword = process.env.E2E_ADMIN_PASSWORD;
// Self-delivery is completed by the assigned partner (pickup + customer delivery code), not from the admin panel.
const partnerPhone = process.env.E2E_DELIVERY_PARTNER_PHONE;
const skip = !outbox || !adminPhone || !adminPassword || !partnerPhone ? 'Set E2E_OTP_OUTBOX, E2E_ADMIN_PHONE, E2E_ADMIN_PASSWORD and E2E_DELIVERY_PARTNER_PHONE to run browser E2E tests' : false;

/** The delivery partner's side of the hand-over, through the partner API (the PWA itself is covered in delivery-partner.e2e.cjs). */
async function partnerDelivers(orderId) {
  const call = async (method, path, token, body) => {
    const response = await fetch(`${base}${path}`, { method, headers: { accept: 'application/json', 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : {}, text };
  };
  let sentAt = Date.now();
  let requested = await call('POST', '/api/v1/delivery/auth/request-otp', null, { phone: partnerPhone });
  if (requested.status === 429) { await new Promise(resolve => setTimeout(resolve, 61_000)); sentAt = Date.now(); requested = await call('POST', '/api/v1/delivery/auth/request-otp', null, { phone: partnerPhone }); }
  assert.equal(requested.status, 202, requested.text);
  const verified = await call('POST', '/api/v1/delivery/auth/verify-otp', null, { phone: partnerPhone, code: await latestOtp(partnerPhone, sentAt) });
  assert.equal(verified.status, 200, verified.text);
  const token = verified.json.data.accessToken;
  assert.equal((await call('POST', `/api/v1/delivery/me/orders/${orderId}/accept`, token, {})).status, 200);
  const pickedAt = Date.now();
  const pickup = await call('POST', `/api/v1/delivery/me/orders/${orderId}/pickup`, token, {});
  assert.equal(pickup.status, 200, pickup.text);
  const detail = (await call('GET', `/api/v1/delivery/me/orders/${orderId}`, token)).json.data;
  const customerPhone10 = detail.customer.phone.replace(/^\+91/, '');
  const code = await latestOtp(customerPhone10, pickedAt);
  const otp = await call('POST', `/api/v1/delivery/me/orders/${orderId}/verify-otp`, token, { otp: code });
  assert.equal(otp.status, 200, otp.text);
  assert.equal(otp.json.data.requiresCod, true);
  const cash = await call('POST', `/api/v1/delivery/me/orders/${orderId}/cod-collection`, token, { amount: detail.payment.codAmount });
  assert.equal(cash.status, 200, cash.text);
  await call('POST', '/api/v1/delivery/auth/logout', token, {});
}

// Fresh customer numbers per run avoid the per-number OTP cooldown.
const customerPhone = `98${String(Date.now()).slice(-8)}`;
const strangerPhone = `97${String(Date.now()).slice(-8)}`;

async function latestOtp(phone10, notBefore) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const lines = fs.existsSync(outbox) ? fs.readFileSync(outbox, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    const match = lines.filter(line => line.phone === `+91${phone10}` && (!line.at || Date.parse(line.at) >= notBefore - 1000)).at(-1);
    if (match) return match.code;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`No OTP was delivered to ${phone10}`);
}

async function signIn(page, path, phone10) {
  await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
  await page.fill('input[type=tel]', phone10);
  let sentAt = Date.now();
  await page.click('button:has-text("Send OTP")');
  // The API allows one code per number per minute; wait it out if a previous run just signed in.
  const outcome = await Promise.race([
    page.waitForSelector('.otp-input').then(() => 'sent'),
    page.waitForSelector('text=/wait a minute/i').then(() => 'cooldown'),
    page.waitForSelector('text=/Too many codes/i').then(() => 'limit'),
  ]);
  if (outcome === 'limit') throw new Error(`${phone10} reached the 5-codes-per-hour OTP limit; wait or clear otp_challenges in the test database`);
  if (outcome === 'cooldown') {
    await page.waitForTimeout(61_000);
    sentAt = Date.now();
    await page.click('button:has-text("Send OTP")');
    await page.waitForSelector('.otp-input');
  }
  const loginUrl = new URL(page.url());
  const expectedPath = new URL(loginUrl.searchParams.get('next') || '/', base).pathname;
  await page.fill('.otp-input', await latestOtp(phone10, sentAt));
  await page.click('button:has-text("Verify")');

  // First-time accounts are routed through optional profile completion before their destination.
  await page.waitForURL(url => url.pathname !== '/login', { timeout: 20000 });
  if (new URL(page.url()).pathname === '/account/settings' && new URL(page.url()).searchParams.get('onboarding') === '1') {
    await page.getByRole('button', { name: 'Skip for now' }).click();
  }
  await page.waitForURL(url => url.pathname === expectedPath, { timeout: 20000 });

  // Authenticated first visits have their own account-scoped tour.
  await page.waitForTimeout(900);
  for (let step = 0; step < 4 && await page.locator('.tour').count(); step++) {
    await page.locator('.tour-foot .btn-primary').click();
  }
}

async function addToCart(page, expected = null) {
  const saved = page.waitForResponse(response => response.url().endsWith('/api/v1/cart/items') && response.request().method() === 'POST');
  await page.click('.pdp-cta button:has-text("Add to Cart")');
  const response = await saved;
  const requestBody = response.request().postData();
  const responseBody = await response.text();
  assert.equal(response.status(), 200,
    `POST ${response.url()} ${requestBody}${expected ? `; expected ${JSON.stringify(expected)}` : ''} returned ${response.status()}: ${responseBody}`);
  return { requestBody: JSON.parse(requestBody), responseBody: JSON.parse(responseBody) };
}

describe('web store and admin (browser E2E)', { skip, timeout: 600_000 }, () => {
  let browser;
  let errors = [];
  let orderId;
  let orderNumber;

  const watch = page => {
    page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
    page.on('console', message => { if (message.type() === 'error' && !/favicon|Failed to load resource: the server responded with a status of 4(01|03|04|29)/.test(message.text())) errors.push(`console: ${message.text()}`); });
    return page;
  };

  // Returning visitors: the first-visit tour and PIN code pop-up are tested on their own.
  const context = async (options = {}, { firstVisit = false } = {}) => {
    const created = await browser.newContext(options);
    if (!firstVisit) await created.addInitScript(() => { localStorage.setItem('sac-guest-tour-done', '1'); localStorage.setItem('sac-pin-asked', '1'); });
    return created;
  };

  before(async () => { browser = await chromium.launch(); });
  after(async () => { await browser?.close(); });

  it('a first-time visitor sees the tour, then the delivery PIN code check', async () => {
    const page = watch(await (await context({}, { firstVisit: true })).newPage());
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.waitForSelector('.tour');
    for (let step = 0; step < 8 && await page.locator('.tour').count(); step++) await page.click('.tour-foot .btn-primary');
    const pinDialog = page.locator('[role=dialog]:has-text("Check delivery to your area")');
    await pinDialog.waitFor();
    await pinDialog.locator('.pin-checker input').fill('517501');
    await pinDialog.locator('.pin-checker button:has-text("Check")').click();
    await pinDialog.locator('.pin-result.ok').waitFor();
    await pinDialog.locator('button:has-text("Continue shopping")').click();
    await pinDialog.waitFor({ state: 'detached' });
    await page.context().close();
  });

  it('a guest can browse, fill a cart and wishlist without signing in; checkout asks to sign in', async () => {
    const page = watch(await (await context()).newPage());
    await page.goto(`${base}/account/orders`);
    await page.waitForURL(url => url.pathname === '/login');
    await page.goto(`${base}/products/brass-diya`, { waitUntil: 'networkidle' });
    await page.click('.pdp-cta button:has-text("Add to Cart")');
    await page.waitForSelector('.pdp-cta .cart-stepper');
    await page.click('.pdp-cta .cart-stepper button[aria-label^="One more"]');
    await page.waitForSelector('.pdp-cta .cart-stepper output:has-text("2")');
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('sac-guest-cart') || '[]')[0]?.quantity === 2);
    assert.equal(new URL(page.url()).pathname, '/products/brass-diya', 'adding to cart does not force a sign-in');
    await page.click('button:has-text("Add to Wishlist")');
    await page.waitForSelector('button:has-text("Saved to Wishlist")');
    await page.goto(`${base}/wishlist`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=Brass Diya');
    await page.goto(`${base}/cart`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.cart-row');
    await page.click('button:has-text("Sign in to Checkout")');
    await page.waitForURL(url => url.pathname === '/login' && url.searchParams.get('next') === '/checkout');
    await page.context().close();
  });

  it('a customer signs in, fills the cart and places a Cash on Delivery order', async () => {
    const page = watch(await (await context({ viewport: { width: 1440, height: 900 } })).newPage());
    await signIn(page, '/login?next=/products/brass-diya', customerPhone);
    await page.waitForURL(url => url.pathname === '/products/brass-diya');
    await addToCart(page);

    await page.goto(`${base}/products/organic-haldi`, { waitUntil: 'networkidle' });
    const product = await page.evaluate(async () => (await (await fetch('/api/v1/products/organic-haldi')).json()).data);
    const selectedVariant = product.variants.find(variant => variant.label === '250 g');
    assert.ok(selectedVariant, `250 g variant missing from product ${product.id}: ${JSON.stringify(product.variants)}`);
    await page.click('.variant:has-text("250 g")');
    await page.locator('.variant[aria-pressed="true"]').filter({ hasText: '250 g' }).waitFor();
    const expectedVariantLine = { product_id: product.id, quantity: 1, variant_id: selectedVariant.id };
    const variantAdd = await addToCart(page, expectedVariantLine);
    assert.deepEqual(variantAdd.requestBody, expectedVariantLine,
      `cart request did not use the selected variant from product ${product.id}`);
    assert.ok(variantAdd.responseBody.data.lines.some(line => line.product_id === product.id && line.variant_id === selectedVariant.id),
      `cart response did not include variant ${selectedVariant.id}: ${JSON.stringify(variantAdd.responseBody)}`);

    await page.goto(`${base}/cart`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.cart-row');
    assert.equal(await page.locator('.cart-row').count(), 2, 'both products are in the cart');
    await page.click('button:has-text("Proceed to Checkout")');
    await page.waitForURL(url => url.pathname === '/checkout');
    await page.waitForSelector('text=Delivery Address');
    await page.click('text=Add a delivery address');
    await page.fill('input[autocomplete=name]', 'E2E Customer');
    await page.fill('input[autocomplete="address-line1"]', '12, Temple Road');
    await page.locator('label:has-text("Area / locality") input').fill('Balaji Colony');
    await page.fill('input[autocomplete=postal-code]', '517501');
    await page.click('button:has-text("Save Address")');
    await page.waitForSelector('text=Delivery Option');
    await page.click('button:has-text("Continue to Payment")');
    await page.waitForSelector('text=Select Payment Method');
    assert.ok(await page.locator('text=Online payments are being set up').count(), 'online payment is clearly unavailable until Razorpay test credentials are configured');
    await page.click('.summary button:has-text("Continue")');
    await page.waitForSelector('text=Review Your Order');
    await page.click('button:has-text("Place Order")');
    await page.waitForURL('**/confirmation');
    await page.waitForSelector('text=Order Placed Successfully');
    orderId = new URL(page.url()).pathname.split('/')[2];
    orderNumber = (await page.locator('text=/SA\\d{5,}/').first().textContent()).match(/SA\d{5,}/)[0];

    await page.goto(`${base}/account/orders`, { waitUntil: 'networkidle' });
    await page.getByText(orderNumber, { exact: false }).waitFor();
    assert.ok(await page.locator(`text=${orderNumber}`).count(), 'the order is listed in the account');
    await page.goto(`${base}/track-order`, { waitUntil: 'networkidle' });
    await page.fill('#order-ref', orderNumber);
    await page.click('form.track-form button');
    await page.waitForSelector('.track-card');
    await page.context().close();
  });

  it('a different customer cannot see that order', async () => {
    const page = watch(await (await context()).newPage());
    await signIn(page, '/login?next=/account/orders', strangerPhone);
    await page.waitForURL(url => url.pathname === '/account/orders');
    const status = await page.evaluate(async id => (await fetch(`/api/v1/orders/${id}`)).status, orderId);
    assert.equal(status, 404);
    await page.goto(`${adminBase}/admin`);
    await page.waitForURL(url => url.pathname === '/admin/login', { timeout: 15000 });
    const adminApi = await page.evaluate(async () => (await fetch('/api/v1/admin/orders')).status);
    assert.equal(adminApi, 403, 'customers are refused by the admin API, not just hidden in the UI');
    await page.context().close();
  });

  it('staff fulfil the order in the admin panel and the customer sees it delivered', async () => {
    const page = watch(await (await context({ viewport: { width: 1440, height: 900 } })).newPage());
    await page.goto(`${adminBase}/admin/login`, { waitUntil: 'networkidle' });
    await page.fill('#staff-phone', adminPhone);
    await page.fill('#staff-password', 'Not-the-password-1');
    await page.click('button:has-text("Sign In")');
    await page.waitForSelector('text=Mobile number or password is incorrect');
    await page.fill('#staff-password', adminPassword);
    await page.click('button:has-text("Sign In")');
    await page.waitForURL(url => url.pathname === '/admin', { timeout: 20000 });
    // The temporary password must be replaced before anything else is reachable.
    await page.waitForSelector('text=Choose your password');
    assert.equal(await page.evaluate(async () => (await fetch('/api/v1/admin/orders')).status), 403);
    const newPassword = `Diya-${Date.now()}`;
    await page.fill('#current-password', adminPassword);
    await page.fill('#new-password', newPassword);
    await page.fill('#confirm-password', newPassword);
    await page.click('button:has-text("Save and continue")');
    await page.waitForSelector('text=Pending Orders');
    await page.goto(`${adminBase}/admin/orders`, { waitUntil: 'networkidle' });
    await page.waitForSelector(`text=${orderNumber}`);
    await page.goto(`${adminBase}/admin/orders/${orderId}`, { waitUntil: 'networkidle' });
    for (const label of ['Accept Order', 'Mark as Packed']) {
      const button = page.locator(`button:has-text("${label}")`);
      await button.waitFor();
      await button.click();
      await button.waitFor({ state: 'detached' });
    }

    // Self-delivery dispatch is intentionally blocked until an active delivery partner is assigned.
    const assignmentPanel = page.locator('section.panel').filter({ hasText: 'Self-delivery assignment' });
    await assignmentPanel.waitFor();
    const partnerSelect = assignmentPanel.locator('select');
    await partnerSelect.waitFor();
    const partnerOption = partnerSelect.locator('option').filter({ hasText: `${partnerPhone.slice(0, 5)} ${partnerPhone.slice(5)}` });
    const partnerId = await partnerOption.first().getAttribute('value');
    assert.ok(partnerId, 'CI must provision E2E_DELIVERY_PARTNER_PHONE as an active delivery partner');
    await partnerSelect.selectOption(partnerId);
    await assignmentPanel.getByRole('button', { name: 'Assign delivery partner' }).click();
    await assignmentPanel.getByText('Assigned:', { exact: false }).waitFor();

    // Staff cannot dispatch or deliver a self-delivery order: the partner picks it up and completes it with the customer's code.
    await page.getByTestId('awaiting-partner').waitFor();
    assert.equal(await page.locator('button:has-text("Mark Out for Delivery")').count(), 0);
    await partnerDelivers(orderId);
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('.admin-page-head, main').getByText('Delivered').first().waitFor();
    await page.goto(`${adminBase}/admin/orders/${orderId}/invoice`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=/Tax Invoice/i');
    for (const path of ['/admin/products', '/admin/categories', '/admin/customers', '/admin/inventory', '/admin/payments', '/admin/delivery', '/admin/reports', '/admin/settings', '/admin/audit']) {
      const response = await page.goto(`${adminBase}${path}`, { waitUntil: 'networkidle' });
      assert.equal(response.status(), 200, path);
      assert.equal(await page.locator('text=/Something went wrong|Application error/').count(), 0, path);
    }
    await page.context().close();

    const customer = watch(await (await context()).newPage());
    await signIn(customer, `/login?next=/account/orders/${orderId}`, customerPhone);
    await customer.waitForURL(url => url.pathname === `/account/orders/${orderId}`, { timeout: 20000 });
    await customer.waitForSelector('text=Delivered');
    await customer.context().close();
  });

  it('the store is usable at phone width without horizontal scrolling', async () => {
    const page = watch(await (await context({ viewport: { width: 390, height: 844 }, isMobile: true })).newPage());
    for (const path of ['/', '/categories', '/products/brass-diya', '/search?q=diya', '/login']) {
      await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 1, `${path} overflows by ${overflow}px`);
    }
    await page.context().close();
  });

  it('no page threw a script error', () => {
    assert.deepEqual(errors, []);
  });
});
