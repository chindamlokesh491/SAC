// Creates or updates a staff account from a trusted shell. Staff roles are deliberately NOT
// grantable over HTTP.
//
//   pnpm --filter @sac/api staff:grant -- 9876543210 admin       create, or reset a forgotten password
//   pnpm --filter @sac/api staff:grant -- 9876543210 operator
//   pnpm --filter @sac/api staff:grant -- 9876543210 customer    remove staff access
//   pnpm --filter @sac/api staff:grant -- 9876543211 delivery_partner
//
// Granting admin/operator issues a one-time temporary password (printed once, stored only as a
// hash) that must be changed at the first sign-in. Automation may supply it via STAFF_PASSWORD.
import pg from 'pg';
import { hashPassword, passwordProblem, temporaryPassword } from './lib/password-hash.mjs';
import { databaseSslOptions } from './lib/db-ssl.mjs';

const [phoneInput, role] = process.argv.slice(2).filter(arg => arg !== '--');
const roles = ['admin', 'operator', 'delivery_partner', 'customer'];
const digits = (phoneInput ?? '').replace(/[\s()-]/g, '').replace(/^\+91(?=\d{10}$)/, '').replace(/^91(?=\d{10}$)/, '').replace(/^0(?=\d{10}$)/, '');
if (!/^[6-9]\d{9}$/.test(digits) || !roles.includes(role)) {
  console.error('Usage: staff:grant -- <10-digit mobile number> <admin|operator|delivery_partner|customer>');
  process.exit(1);
}
const phone = `+91${digits}`;
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

const staff = role !== 'customer';
// Delivery partners sign in only with an SMS code at /partner; they never get a password.
const usesPassword = role === 'admin' || role === 'operator';
let password = null;
if (usesPassword) {
  password = process.env.STAFF_PASSWORD || temporaryPassword();
  const problem = process.env.STAFF_PASSWORD ? passwordProblem(password, phone) : null;
  if (problem) {
    console.error(`STAFF_PASSWORD is too weak: ${problem}.`);
    process.exit(1);
  }
}
const hash = password ? await hashPassword(password) : null;

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ...databaseSslOptions() });
await client.connect();
try {
  await client.query('BEGIN');
  const user = await client.query(
    `INSERT INTO users (phone_e164, role, password_hash, must_change_password, password_changed_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $3::text IS NULL THEN NULL ELSE now() END)
     ON CONFLICT (phone_e164) DO UPDATE SET role = EXCLUDED.role, password_hash = EXCLUDED.password_hash,
       must_change_password = EXCLUDED.must_change_password, password_changed_at = EXCLUDED.password_changed_at,
       failed_login_attempts = 0, locked_until = NULL, updated_at = now()
     RETURNING id`, [phone, role, hash, usesPassword]);
  // Existing sessions were issued under the previous role or password; force a fresh sign-in.
  await client.query('UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [user.rows[0].id]);
  await client.query(`INSERT INTO admin_audit_logs (action, resource_type, resource_id, metadata) VALUES ('staff.role_granted_cli', 'user', $1, $2::jsonb)`, [user.rows[0].id, JSON.stringify({ role, password_reset: usesPassword })]);
  await client.query('COMMIT');
  if (role === 'delivery_partner') {
    console.log(`\n${phone} is now a delivery partner. They sign in at /partner with an SMS code; no password is issued.\n`);
  } else if (staff) {
    console.log(`\n${phone} is now ${role}.`);
    console.log(`Temporary password: ${password}`);
    console.log('Sign in at /admin/login. You will be asked to choose a new password straight away.');
    console.log('This password is shown only once. Run this command again to issue a new one.\n');
  } else {
    console.log(`${phone} no longer has staff access. Existing sessions were signed out.`);
  }
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('Failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await client.end();
}
