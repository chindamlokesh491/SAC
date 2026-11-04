import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { hashPassword, passwordProblem, temporaryPassword, verifyPassword } from '../src/auth/password.js';
import { createHarness, databaseUrl, skipReason, STAFF_TEST_PASSWORD, type Harness } from './support/harness.js';

const run = promisify(execFile);
const grantScript = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/grant-role.mjs');

describe('password hashing', () => {
  it('hashes with a random salt and verifies only the right password', async () => {
    const first = await hashPassword('Kumkum-and-haldi-9');
    const second = await hashPassword('Kumkum-and-haldi-9');
    assert.match(first, /^scrypt\$32768\$8\$1\$/);
    assert.notEqual(first, second, 'same password, different salt');
    assert.equal(await verifyPassword('Kumkum-and-haldi-9', first), true);
    assert.equal(await verifyPassword('kumkum-and-haldi-9', first), false);
    assert.equal(await verifyPassword('Kumkum-and-haldi-9', 'plain-text'), false);
    assert.equal(await verifyPassword('Kumkum-and-haldi-9', null), false);
  });

  it('enforces the password rules', () => {
    assert.equal(passwordProblem('short1', null), 'Use at least 10 characters');
    assert.equal(passwordProblem('onlyletterspassword', null), 'Use both letters and numbers');
    assert.equal(passwordProblem('Lamp9876543210x', '+919876543210'), 'Do not use your mobile number in the password');
    assert.match(String(passwordProblem('Password1234', null)), /less guessable/);
    assert.equal(passwordProblem('Temple-lamp-2026', '+919876543210'), null);
    for (let i = 0; i < 2000; i++) assert.equal(passwordProblem(temporaryPassword(), null), null, 'temporary passwords satisfy the rules');
  });
});

describe('staff password sign-in (integration)', { skip: skipReason }, () => {
  let h: Harness;
  before(async () => { h = await createHarness(); });
  after(async () => { await h?.close(); });

  const staffLogin = (phone: string, password: string, headers: Record<string, string> = {}) =>
    h.request('POST', '/api/v1/auth/staff/login', { headers, body: { phone, password } });

  it('signs staff in with the right password and gives the web an HttpOnly cookie', async () => {
    await h.login('9400000001', 'admin');
    const ok = await staffLogin('9400000001', STAFF_TEST_PASSWORD, { 'x-sac-client': 'web' });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.data.accessToken, undefined);
    assert.match(String(ok.headers['set-cookie']), /HttpOnly/i);
    assert.equal(ok.json.data.user.role, 'admin');
  });

  it('gives the same answer for a wrong password, an unknown number and a customer number', async () => {
    await h.login('9400000002', 'admin');
    await h.login('9400000003');
    const wrong = await staffLogin('9400000002', 'Wrong-password-1');
    const unknown = await staffLogin('9400000099', STAFF_TEST_PASSWORD);
    const customer = await staffLogin('9400000003', STAFF_TEST_PASSWORD);
    for (const response of [wrong, unknown, customer]) {
      assert.equal(response.status, 401);
      assert.deepEqual(response.json, { error: 'INVALID_CREDENTIALS', message: 'Mobile number or password is incorrect' });
    }
  });

  it('locks the account for 15 minutes after 5 wrong passwords, even for the right password', async () => {
    await h.login('9400000004', 'admin');
    for (let i = 0; i < 5; i++) assert.equal((await staffLogin('9400000004', `Wrong-guess-${i}x`)).status, 401);
    const locked = await staffLogin('9400000004', STAFF_TEST_PASSWORD);
    assert.equal(locked.status, 429);
    assert.equal(locked.json.error, 'ACCOUNT_LOCKED');
    await h.pool.query(`UPDATE users SET locked_until = now() - interval '1 second' WHERE phone_e164 = '+919400000004'`);
    assert.equal((await staffLogin('9400000004', STAFF_TEST_PASSWORD)).status, 200, 'works again once the lock expires');
  });

  it('staff numbers cannot sign in by SMS code', async () => {
    await h.login('9400000005', 'operator');
    await h.request('POST', '/api/v1/auth/otp/request', { body: { phone: '9400000005' } });
    const otp = await h.request('POST', '/api/v1/auth/otp/verify', { body: { phone: '9400000005', code: h.otpCodes.get('+919400000005') } });
    assert.equal(otp.status, 403);
    assert.equal(otp.json.error, 'STAFF_USE_PASSWORD');
  });

  it('a temporary password only unlocks the change-password step', async () => {
    const phone = '+919400000006';
    await h.pool.query(`INSERT INTO users(phone_e164, role, password_hash, must_change_password) VALUES ($1, 'admin', $2, TRUE)`, [phone, await hashPassword('Temp-pass-1234')]);
    const signedIn = await staffLogin('9400000006', 'Temp-pass-1234');
    assert.equal(signedIn.status, 200);
    assert.equal(signedIn.json.data.user.must_change_password, true);
    const token = signedIn.json.data.accessToken as string;
    for (const url of ['/api/v1/admin/dashboard', '/api/v1/admin/orders', '/api/v1/admin/settings']) {
      const blocked = await h.request('GET', url, { token });
      assert.equal(blocked.status, 403, url);
      assert.equal(blocked.json.error, 'PASSWORD_CHANGE_REQUIRED');
    }
    assert.equal((await h.request('POST', '/api/v1/auth/staff/phone', { token, body: { current_password: 'Temp-pass-1234', phone: '9400000016' } })).status, 403);
    const weak = await h.request('POST', '/api/v1/auth/staff/password', { token, body: { current_password: 'Temp-pass-1234', new_password: 'short' } });
    assert.equal(weak.status, 400);
    assert.equal(weak.json.error, 'WEAK_PASSWORD');
    const wrongCurrent = await h.request('POST', '/api/v1/auth/staff/password', { token, body: { current_password: 'not-it-12345', new_password: 'Brass-diya-2026' } });
    assert.equal(wrongCurrent.status, 400);
    assert.equal(wrongCurrent.json.error, 'WRONG_PASSWORD');
    const changed = await h.request('POST', '/api/v1/auth/staff/password', { token, body: { current_password: 'Temp-pass-1234', new_password: 'Brass-diya-2026' } });
    assert.equal(changed.status, 200);
    assert.equal((await h.request('GET', '/api/v1/admin/dashboard', { token })).status, 200, 'the same session now works');
    assert.equal((await staffLogin('9400000006', 'Temp-pass-1234')).status, 401, 'the temporary password no longer works');
    assert.equal((await staffLogin('9400000006', 'Brass-diya-2026')).status, 200);
  });

  it('changing the password signs out every other device', async () => {
    await h.login('9400000007', 'admin');
    const laptop = (await staffLogin('9400000007', STAFF_TEST_PASSWORD)).json.data.accessToken as string;
    const phone = (await staffLogin('9400000007', STAFF_TEST_PASSWORD)).json.data.accessToken as string;
    assert.equal((await h.request('POST', '/api/v1/auth/staff/password', { token: laptop, body: { current_password: STAFF_TEST_PASSWORD, new_password: 'Camphor-dhoop-77' } })).status, 200);
    assert.equal((await h.request('GET', '/api/v1/admin/orders', { token: laptop })).status, 200);
    assert.equal((await h.request('GET', '/api/v1/admin/orders', { token: phone })).status, 401);
  });

  it('changing the mobile number needs the current password and a free number', async () => {
    const { token } = await h.login('9400000008', 'admin');
    await h.login('9400000009');
    const noPassword = await h.request('POST', '/api/v1/auth/staff/phone', { token, body: { current_password: 'wrong-one-123', phone: '9400000018' } });
    assert.equal(noPassword.status, 400);
    const taken = await h.request('POST', '/api/v1/auth/staff/phone', { token, body: { current_password: STAFF_TEST_PASSWORD, phone: '9400000009' } });
    assert.equal(taken.status, 409);
    const moved = await h.request('POST', '/api/v1/auth/staff/phone', { token, body: { current_password: STAFF_TEST_PASSWORD, phone: '9400000018' } });
    assert.equal(moved.status, 200);
    assert.equal((await staffLogin('9400000008', STAFF_TEST_PASSWORD)).status, 401);
    assert.equal((await staffLogin('9400000018', STAFF_TEST_PASSWORD)).status, 200);
  });

  it('customers have no password and cannot use the staff endpoints', async () => {
    const { token, userId } = await h.login('9400000010');
    assert.equal((await h.request('POST', '/api/v1/auth/staff/password', { token, body: { current_password: 'x', new_password: 'Brass-diya-2026' } })).status, 403);
    await assert.rejects(h.pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, await hashPassword('Brass-diya-2026')]), 'the database refuses a password on a customer account');
  });

  it('the staff:grant command issues a temporary password that must be changed', async () => {
    const schema = (await h.pool.query<{ schema: string }>('SELECT current_schema() AS schema')).rows[0]!.schema;
    const env = { ...process.env, DATABASE_URL: `${databaseUrl}${databaseUrl!.includes('?') ? '&' : '?'}options=-c%20search_path%3D${schema}` };
    const { stdout } = await run(process.execPath, [grantScript, '9400000011', 'admin'], { env });
    const temporary = /Temporary password: (\S+)/.exec(stdout)?.[1];
    assert.ok(temporary, stdout);
    const row = (await h.pool.query(`SELECT password_hash, must_change_password FROM users WHERE phone_e164 = '+919400000011'`)).rows[0];
    assert.equal(row.must_change_password, true);
    assert.ok(!row.password_hash.includes(temporary), 'only a hash is stored');
    const signedIn = await staffLogin('9400000011', temporary);
    assert.equal(signedIn.status, 200);
    assert.equal(signedIn.json.data.user.must_change_password, true);

    await run(process.execPath, [grantScript, '9400000011', 'customer'], { env });
    const demoted = (await h.pool.query(`SELECT role, password_hash FROM users WHERE phone_e164 = '+919400000011'`)).rows[0];
    assert.deepEqual(demoted, { role: 'customer', password_hash: null });
    assert.equal((await h.request('GET', '/api/v1/me', { token: signedIn.json.data.accessToken })).status, 401, 'removing access signs the person out');
  });
});
