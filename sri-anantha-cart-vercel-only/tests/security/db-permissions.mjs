// Proves the database privilege model (migrations 021 + 024, database/roles/app_runtime_role.sql) on a
// Supabase-like cluster. Run against a THROWAWAY database prepared with supabase-emulation-setup.sql:
//   OWNER_URL=postgres://postgres@localhost:5434/sac_emul \
//   RUNTIME_URL=postgres://sac_app_runtime@localhost:5434/sac_emul \
//   AUTHENTICATOR_URL=postgres://authenticator@localhost:5434/sac_emul \
//   STORAGE_URL=postgres://supabase_storage_admin@localhost:5434/sac_emul node tests/security/db-permissions.mjs
// Exits non-zero if any expectation fails.
import pg from 'pg';

const { OWNER_URL, RUNTIME_URL, AUTHENTICATOR_URL, STORAGE_URL } = process.env;
if (!OWNER_URL || !RUNTIME_URL || !AUTHENTICATOR_URL) { console.error('Set OWNER_URL, RUNTIME_URL and AUTHENTICATOR_URL'); process.exit(2); }
if (!/emul|test|bench/.test(OWNER_URL)) { console.error('Refusing: OWNER_URL must point at a throwaway (emul/test/bench) database'); process.exit(2); }

const results = [];
const check = (name, ok, detail = '') => { results.push({ check: name, result: ok ? 'PASS' : 'FAIL', detail }); };
const outcome = async (client, sql, params = []) => {
  try { const r = await client.query(sql, params); return { ok: true, rows: r.rows, count: r.rowCount }; } catch (error) { return { ok: false, code: error.code, message: error.message }; }
};

const owner = new pg.Client({ connectionString: OWNER_URL }); await owner.connect();
const runtime = new pg.Client({ connectionString: RUNTIME_URL }); await runtime.connect();
const api = new pg.Client({ connectionString: AUTHENTICATOR_URL }); await api.connect();

const tables = (await owner.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).rows.map(r => r.tablename);
const noRls = (await owner.query(`SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity`)).rows.map(r => r.relname);
check(`RLS enabled on all ${tables.length} tables`, noRls.length === 0, noRls.join(', '));

// 1. Supabase Data API roles: no access to any table, sequence or function.
for (const role of ['anon', 'authenticated', 'service_role']) {
  await api.query(`SET ROLE ${role}`);
  const readable = []; const writable = [];
  for (const table of tables) {
    if ((await outcome(api, `SELECT 1 FROM public.${table} LIMIT 1`)).ok) readable.push(table);
    if ((await outcome(api, `DELETE FROM public.${table} WHERE false`)).ok) writable.push(table);
  }
  check(`${role}: cannot read any table`, readable.length === 0, readable.join(', '));
  check(`${role}: cannot write any table`, writable.length === 0, writable.join(', '));
  const fn = await outcome(api, 'SELECT public.rebuild_product_sales()');
  check(`${role}: cannot call database functions`, !fn.ok, fn.code ?? 'allowed');
  const seq = await outcome(api, `SELECT nextval('public.orders_order_number_seq')`);
  check(`${role}: cannot use sequences`, !seq.ok, seq.code ?? 'allowed');
  await api.query('RESET ROLE');
}

// 2. A privilege granted by mistake is still blocked by RLS (second barrier).
await owner.query(`INSERT INTO categories (name, slug) VALUES ('Permission probe', 'permission-probe-' || floor(random() * 1e9)::text)`);
await owner.query('GRANT SELECT ON public.categories TO authenticated');
await api.query('SET ROLE authenticated');
const leaked = await outcome(api, 'SELECT count(*)::int AS n FROM public.categories');
check('mistaken GRANT to authenticated still returns zero rows (RLS)', leaked.ok && leaked.rows[0].n === 0, JSON.stringify(leaked.rows ?? leaked.code));
await api.query('RESET ROLE');
await owner.query('REVOKE SELECT ON public.categories FROM authenticated');

// 3. Runtime (API/worker) role: row access only.
await owner.query(`INSERT INTO admin_audit_logs (action, resource_type) VALUES ('permission.probe', 'test')`);
const slug = `runtime-probe-${Date.now()}`;
const ins = await outcome(runtime, `INSERT INTO categories (name, slug) VALUES ('Runtime probe', $1) RETURNING id`, [slug]);
check('runtime: INSERT', ins.ok, ins.message ?? '');
check('runtime: SELECT', (await outcome(runtime, 'SELECT id FROM categories WHERE slug = $1', [slug])).count === 1);
check('runtime: UPDATE', (await outcome(runtime, `UPDATE categories SET description = 'x' WHERE slug = $1`, [slug])).count === 1);
check('runtime: DELETE', (await outcome(runtime, 'DELETE FROM categories WHERE slug = $1', [slug])).count === 1);
check('runtime: can run worker functions', (await outcome(runtime, 'SELECT refresh_product_sales_summary()')).ok);
for (const [name, sql] of [
  ['TRUNCATE', 'TRUNCATE categories'],
  ['DROP TABLE', 'DROP TABLE categories'],
  ['ALTER TABLE', 'ALTER TABLE categories ADD COLUMN hacked int'],
  ['CREATE TABLE', 'CREATE TABLE public.hacked (id int)'],
  ['DISABLE RLS', 'ALTER TABLE users DISABLE ROW LEVEL SECURITY'],
  ['read migration history', 'SELECT * FROM schema_migrations'],
  ['become the owner', 'SET ROLE postgres'],
  ['create roles', 'CREATE ROLE hacker LOGIN'],
  ['modify audit log', `DELETE FROM admin_audit_logs WHERE true`],
]) {
  const r = await outcome(runtime, sql);
  const blocked = !r.ok;
  check(`runtime: cannot ${name}`, blocked, r.code ?? `allowed (${r.count ?? 0} rows)`);
}

// 4. Supabase's own services can still connect (migration 021 must not revoke PUBLIC CONNECT there).
if (STORAGE_URL) {
  const storage = new pg.Client({ connectionString: STORAGE_URL });
  const connected = await storage.connect().then(() => true, () => false);
  check('Supabase service roles can still connect', connected);
  if (connected) await storage.end();
}

await Promise.all([owner.end(), runtime.end(), api.end()]);
console.table(results);
const failed = results.filter(r => r.result === 'FAIL');
console.log(`${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
