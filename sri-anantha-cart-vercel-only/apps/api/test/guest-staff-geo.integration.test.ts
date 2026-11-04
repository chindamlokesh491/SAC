import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createHarness, skipReason, STAFF_TEST_PASSWORD, type Harness } from './support/harness.js';

const geocoderCalls: string[] = [];
const fakeGeocoder = (async (input: URL | string) => {
  geocoderCalls.push(String(input));
  return new Response(JSON.stringify({
    display_name: '12, Temple Road, Balaji Colony, Tirupati, Andhra Pradesh, 517501, India',
    address: { house_number: '12', road: 'Temple Road', suburb: 'Balaji Colony', city: 'Tirupati', state: 'Andhra Pradesh', postcode: '517 501' },
  }), { headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

describe('guest shopping, staff management and location (integration)', { skip: skipReason }, () => {
  let h: Harness;
  let category: string;
  before(async () => {
    h = await createHarness({ geoFetch: fakeGeocoder });
    category = await h.seed.category('Guest Items');
    await h.seed.zone({ postal: ['517501'], fee: 3000 });
  });
  after(async () => { await h?.close(); });

  describe('guest cart', () => {
    it('prices a device-stored cart on the server without signing in and without saving anything', async () => {
      const lamp = await h.seed.product({ categoryId: category, price: 24900, mrp: 29900, stock: 3, gst: 1200 });
      const haldi = await h.seed.product({ categoryId: category, price: 0 + 7000, stock: 0 });
      const kumkum = await h.seed.product({ categoryId: category, price: 6000, stock: 10 });
      const pack = await h.seed.variant(kumkum.id, { label: '100 g', price: 9000, stock: 5 });
      const preview = await h.request('POST', '/api/v1/cart/preview', { body: { items: [
        { product_id: lamp.id, quantity: 2 },
        { product_id: haldi.id, quantity: 1 },
        { product_id: kumkum.id, variant_id: pack, quantity: 1 },
        { product_id: '00000000-0000-4000-8000-000000000000', quantity: 1 },
      ], postal_code: '517501' } });
      assert.equal(preview.status, 200, preview.body);
      const quote = preview.json.data;
      assert.equal(quote.lines.length, 3, 'unknown products are dropped');
      assert.equal(quote.lines[0].unit_price_paise, 24900, 'prices come from the database');
      assert.equal(quote.lines[1].issue, 'insufficient_stock');
      assert.equal(quote.lines[2].unit_price_paise, 9000, 'variant price');
      assert.equal(quote.subtotal_paise, 2 * 24900 + 9000);
      assert.equal(quote.delivery_fee_paise, 0, 'over ₹499: free delivery');
      assert.equal(quote.zone.name, 'Zone');
      assert.equal(Number((await h.pool.query('SELECT COUNT(*) FROM cart_items')).rows[0].count), 0, 'nothing is stored');
      const tampered = await h.request('POST', '/api/v1/cart/preview', { body: { items: [{ product_id: lamp.id, quantity: 1, unit_price_paise: 1 }] } });
      assert.equal(tampered.status, 400);
      assert.equal((await h.request('POST', '/api/v1/cart/preview', { body: { items: [{ product_id: lamp.id, quantity: 0 }] } })).status, 400);
    });

    it('merges the guest cart at sign-in: larger quantity wins, capped at stock, unsellable items reported', async () => {
      const diya = await h.seed.product({ categoryId: category, price: 10000, stock: 4 });
      const bell = await h.seed.product({ categoryId: category, price: 5000, stock: 10 });
      const hidden = await h.seed.product({ categoryId: category, price: 5000, stock: 10, active: false });
      const { token } = await h.login('9600000001');
      await h.request('POST', '/api/v1/cart/items', { token, body: { product_id: bell.id, quantity: 3 } });
      const merged = await h.request('POST', '/api/v1/cart/merge', { token, body: { items: [
        { product_id: diya.id, quantity: 9 }, { product_id: bell.id, quantity: 2 }, { product_id: hidden.id, quantity: 1 },
      ] } });
      assert.equal(merged.status, 200, merged.body);
      const lines = merged.json.data.lines as { product_id: string; quantity: number }[];
      assert.equal(lines.find(line => line.product_id === diya.id)?.quantity, 4, 'capped at stock');
      assert.equal(lines.find(line => line.product_id === bell.id)?.quantity, 3, 'larger quantity wins, not the sum');
      assert.equal(lines.some(line => line.product_id === hidden.id), false);
      assert.equal(merged.json.adjusted.length, 2);
      const again = await h.request('POST', '/api/v1/cart/merge', { token, body: { items: [{ product_id: bell.id, quantity: 2 }] } });
      assert.equal(again.json.data.lines.find((line: { product_id: string }) => line.product_id === bell.id).quantity, 3, 'merging twice never doubles');
      assert.equal((await h.request('POST', '/api/v1/cart/merge', { body: { items: [] } })).status, 401, 'merge needs a session');
    });

    it('checkout still needs a signed-in customer', async () => {
      assert.equal((await h.request('POST', '/api/v1/orders/checkout', { body: {} })).status, 401);
    });
  });

  describe('guest wishlist', () => {
    it('shows cards by id without signing in, and merges into the account at sign-in', async () => {
      const a = await h.seed.product({ categoryId: category, price: 1000, stock: 2, name: 'Wish A' });
      const b = await h.seed.product({ categoryId: category, price: 1000, stock: 2, name: 'Wish B' });
      const hidden = await h.seed.product({ categoryId: category, price: 1000, stock: 2, active: false });
      const cards = await h.request('POST', '/api/v1/products/by-ids', { body: { ids: [a.id, b.id, hidden.id] } });
      assert.deepEqual(cards.json.data.map((card: { name: string }) => card.name), ['Wish A', 'Wish B']);
      const { token } = await h.login('9600000002');
      const merged = await h.request('POST', '/api/v1/wishlist/merge', { token, body: { product_ids: [a.id, hidden.id, a.id] } });
      assert.deepEqual(merged.json.data.product_ids, [a.id]);
    });
  });

  describe('location lookup', () => {
    it('turns coordinates into an editable address with a 6-digit PIN, rounding and caching the coordinates', async () => {
      const first = await h.request('GET', '/api/v1/geo/reverse?lat=13.628756&lon=79.419182');
      assert.equal(first.status, 200, first.body);
      assert.deepEqual(first.json.data, {
        postal_code: '517501', line1: '12, Temple Road', locality: 'Balaji Colony', city: 'Tirupati', state: 'Andhra Pradesh',
        display: '12, Temple Road, Balaji Colony, Tirupati, Andhra Pradesh, 517501, India',
      });
      assert.match(geocoderCalls[0]!, /lat=13\.629&lon=79\.419/, 'coordinates are rounded to about 100 m before leaving the server');
      await h.request('GET', '/api/v1/geo/reverse?lat=13.62880&lon=79.41920');
      assert.equal(geocoderCalls.length, 1, 'nearby lookups are served from the cache');
    });

    it('rejects bad or foreign coordinates', async () => {
      assert.equal((await h.request('GET', '/api/v1/geo/reverse?lat=abc&lon=1')).status, 400);
      assert.equal((await h.request('GET', '/api/v1/geo/reverse?lat=51.5&lon=-0.12')).status, 422);
    });
  });

  describe('admin accounts from Settings', () => {
    it('adds an admin with a temporary password, only after the acting admin confirms their own password', async () => {
      const owner = await h.login('9600000010', 'admin');
      const wrong = await h.request('POST', '/api/v1/admin/staff', { token: owner.token, body: { phone: '9600000011', role: 'admin', current_password: 'not-my-password-1' } });
      assert.equal(wrong.status, 400);
      assert.equal(wrong.json.error, 'WRONG_PASSWORD');
      const added = await h.request('POST', '/api/v1/admin/staff', { token: owner.token, body: { phone: '9600000011', role: 'admin', name: 'Second Admin', current_password: STAFF_TEST_PASSWORD } });
      assert.equal(added.status, 201, added.body);
      const temporary = added.json.data.temporary_password as string;
      const signedIn = await h.request('POST', '/api/v1/auth/staff/login', { body: { phone: '9600000011', password: temporary } });
      assert.equal(signedIn.status, 200);
      assert.equal(signedIn.json.data.user.must_change_password, true);
      assert.equal((await h.request('POST', '/api/v1/admin/staff', { token: owner.token, body: { phone: '9600000011', role: 'admin', current_password: STAFF_TEST_PASSWORD } })).json.error, 'ALREADY_STAFF');
      await h.login('9600000012');
      assert.equal((await h.request('POST', '/api/v1/admin/staff', { token: owner.token, body: { phone: '9600000012', role: 'admin', current_password: STAFF_TEST_PASSWORD } })).json.error, 'PHONE_IS_CUSTOMER');
      const list = (await h.request('GET', '/api/v1/admin/staff', { token: owner.token })).json.data as { phone_e164: string; is_you: boolean }[];
      assert.ok(list.some(member => member.phone_e164 === '+919600000011'));
      assert.ok(list.some(member => member.is_you));
    });

    it('removes access immediately, never yourself or the last admin, and allows re-adding later', async () => {
      const owner = await h.login('9600000020', 'admin');
      const operator = await h.login('9600000021', 'operator');
      const self = await h.request('POST', `/api/v1/admin/staff/${owner.userId}/remove`, { token: owner.token, body: { current_password: STAFF_TEST_PASSWORD } });
      assert.equal(self.json.error, 'CANNOT_REMOVE_SELF');
      const removed = await h.request('POST', `/api/v1/admin/staff/${operator.userId}/remove`, { token: owner.token, body: { current_password: STAFF_TEST_PASSWORD } });
      assert.equal(removed.status, 200, removed.body);
      assert.equal((await h.request('GET', '/api/v1/admin/orders', { token: operator.token })).status, 401, 'signed out at once');
      assert.equal((await h.request('POST', '/api/v1/auth/staff/login', { body: { phone: '9600000021', password: STAFF_TEST_PASSWORD } })).status, 401);
      const readded = await h.request('POST', '/api/v1/admin/staff', { token: owner.token, body: { phone: '9600000021', role: 'operator', current_password: STAFF_TEST_PASSWORD } });
      assert.equal(readded.status, 201, readded.body);

      await h.pool.query(`UPDATE users SET role = 'customer', password_hash = NULL WHERE role = 'admin' AND id <> $1`, [owner.userId]);
      const second = await h.login('9600000022', 'admin');
      await h.pool.query(`UPDATE users SET role = 'customer', password_hash = NULL WHERE id = $1`, [owner.userId]);
      const last = await h.request('POST', `/api/v1/admin/staff/${owner.userId}/remove`, { token: second.token, body: { current_password: STAFF_TEST_PASSWORD } });
      assert.equal(last.status, 404, 'a non-staff account cannot be "removed"');
      const lastAdmin = await h.login('9600000023', 'operator');
      const blocked = await h.request('POST', `/api/v1/admin/staff/${second.userId}/remove`, { token: lastAdmin.token, body: { current_password: STAFF_TEST_PASSWORD } });
      assert.equal(blocked.status, 403, 'operators cannot manage staff');
    });

    it('the store must keep at least one admin', async () => {
      await h.pool.query(`UPDATE users SET role = 'customer', password_hash = NULL WHERE role IN ('admin','operator')`);
      const only = await h.login('9600000030', 'admin');
      const other = await h.request('POST', '/api/v1/admin/staff', { token: only.token, body: { phone: '9600000031', role: 'operator', current_password: STAFF_TEST_PASSWORD } });
      assert.equal(other.status, 201);
      const admins = Number((await h.pool.query(`SELECT COUNT(*) FROM users WHERE role = 'admin'`)).rows[0].count);
      assert.equal(admins, 1);
      // Even another admin cannot remove the last admin.
      await h.pool.query(`UPDATE users SET role = 'admin' WHERE phone_e164 = '+919600000031'`);
      await h.pool.query(`UPDATE users SET must_change_password = FALSE, password_hash = (SELECT password_hash FROM users WHERE phone_e164 = '+919600000030') WHERE phone_e164 = '+919600000031'`);
      const second = (await h.request('POST', '/api/v1/auth/staff/login', { body: { phone: '9600000031', password: STAFF_TEST_PASSWORD } })).json.data.accessToken as string;
      assert.equal((await h.request('POST', `/api/v1/admin/staff/${only.userId}/remove`, { token: second, body: { current_password: STAFF_TEST_PASSWORD } })).status, 200, 'two admins: one may go');
      const me = (await h.pool.query(`SELECT id FROM users WHERE phone_e164 = '+919600000031'`)).rows[0].id;
      const readd = await h.request('POST', '/api/v1/admin/staff', { token: second, body: { phone: '9600000032', role: 'admin', current_password: STAFF_TEST_PASSWORD } });
      assert.equal(readd.status, 201);
      const third = await h.request('POST', '/api/v1/auth/staff/login', { body: { phone: '9600000032', password: readd.json.data.temporary_password } });
      await h.request('POST', '/api/v1/auth/staff/password', { token: third.json.data.accessToken, body: { current_password: readd.json.data.temporary_password, new_password: 'Third-admin-2026' } });
      await h.pool.query(`UPDATE users SET role = 'operator' WHERE id = $1`, [me]);
      const lone = await h.request('POST', `/api/v1/admin/staff/${me}/remove`, { token: third.json.data.accessToken, body: { current_password: 'Third-admin-2026' } });
      assert.equal(lone.status, 200, 'removing an operator is fine with one admin left');
    });

    it('settings keep the store name and tagline fixed', async () => {
      const { token } = await h.login('9600000040', 'admin');
      const before = (await h.request('GET', '/api/v1/admin/settings', { token })).json.data.store;
      const saved = await h.request('PUT', '/api/v1/admin/settings/store', { token, body: { ...before, name: 'Hacked Store', tagline: 'Changed', support_email: 'help@example.com' } });
      assert.equal(saved.status, 200, saved.body);
      assert.equal(saved.json.data.name, before.name);
      assert.equal(saved.json.data.tagline, before.tagline);
      assert.equal(saved.json.data.support_email, 'help@example.com');
      const { name: _name, tagline: _tagline, ...withoutBrand } = before;
      assert.equal((await h.request('PUT', '/api/v1/admin/settings/store', { token, body: withoutBrand })).status, 200, 'the page no longer sends them');
    });
  });
});
