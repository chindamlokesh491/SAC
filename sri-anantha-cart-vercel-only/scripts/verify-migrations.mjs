// Static migration checks that do not need a database. Schema correctness itself is
// proven by the API integration tests, which apply every migration to a fresh schema.
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const migrationsDir = resolve(process.cwd(), 'database/migrations');
const files = (await readdir(migrationsDir)).filter(file => /^\d{3}_.+\.sql$/.test(file)).sort();
const fail = message => { console.error(`Migration verification failed: ${message}`); process.exitCode = 1; };

if (files.length === 0) fail('no numbered SQL migrations found');
files.forEach((file, index) => {
  if (Number(file.slice(0, 3)) !== index + 1) fail(`expected migration ${String(index + 1).padStart(3, '0')}, found ${file}`);
});
for (const file of files) {
  const sql = await readFile(resolve(migrationsDir, file), 'utf8');
  if (!file.startsWith('002_development_seed') && /insert\s+into\s+(users|products|orders)\b/i.test(sql)) {
    fail(`${file} inserts customer or catalogue data; sample data belongs in the development seed or seed:demo`);
  }
  if (/drop\s+table(?!\s+if\s+exists\s+\w+_old)/i.test(sql) && !/--\s*reviewed-destructive/i.test(sql)) {
    fail(`${file} drops a table; mark intentional destructive changes with "-- reviewed-destructive"`);
  }
  // From migration 024 on, every new table must get the backend-only RLS policy (Supabase exposes tables otherwise).
  if (Number(file.slice(0, 3)) > 24) {
    for (const match of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)/gi)) {
      if (!new RegExp(`enable_backend_rls\\(\\s*'${match[1]}'`, 'i').test(sql)) fail(`${file} creates table ${match[1]} without SELECT enable_backend_rls('${match[1]}')`);
    }
  }
  if (/revoke\s+all\s+on\s+database/i.test(sql) && !/supabase_admin/.test(sql)) {
    fail(`${file} revokes database privileges without the Supabase guard (it would lock out Supabase services)`);
  }
}
if (process.exitCode) process.exit(process.exitCode);
console.log(`Migration checks passed: ${files.length} ordered migrations, development seed isolated, new tables protected by RLS.`);
