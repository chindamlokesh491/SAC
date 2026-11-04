import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { databaseSslOptions } from './lib/db-ssl.mjs';

const { Client } = pg;
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '../../../database/migrations');
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required to run database migrations.');
  process.exit(1);
}

const client = new Client({
  connectionString: databaseUrl,
  ...databaseSslOptions(),
  connectionTimeoutMillis: 10_000,
});

// The development seed contains clearly labelled placeholder products and must
// never be applied to a production database by the standard migration command.
const includeDevelopmentSeed = process.env.INCLUDE_DEVELOPMENT_SEED === 'true';
const lockKey = 'sri-anantha-cart-schema-migrations-v1';

try {
  await client.connect();
  await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      migration_name TEXT PRIMARY KEY,
      checksum_sha256 TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(migrationsDir))
    .filter(name => /^\d{3}_[a-z0-9_-]+\.sql$/.test(name))
    .sort();
  if (!files.length) throw new Error(`No migration files found in ${migrationsDir}`);

  let appliedCount = 0;
  for (const file of files) {
    if (file.startsWith('002_development_seed') && !includeDevelopmentSeed) {
      console.log(`SKIP ${file} (development-only seed; set INCLUDE_DEVELOPMENT_SEED=true to opt in)`);
      continue;
    }

    const rawSql = await readFile(resolve(migrationsDir, file), 'utf8');
    const checksum = createHash('sha256').update(rawSql).digest('hex');
    const existing = await client.query(
      'SELECT checksum_sha256 FROM schema_migrations WHERE migration_name = $1', [file],
    );
    if (existing.rowCount) {
      if (existing.rows[0].checksum_sha256 !== checksum) {
        throw new Error(`Checksum mismatch for already-applied migration ${file}; do not edit applied migrations.`);
      }
      console.log(`OK   ${file} (already applied)`);
      continue;
    }

    // Existing files wrap themselves in BEGIN/COMMIT. Strip those wrappers so
    // migration SQL and its tracking row commit atomically as one transaction.
    const sql = rawSql
      .replace(/^\s*BEGIN\s*;?/i, '')
      .replace(/COMMIT\s*;?\s*$/i, '');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (migration_name, checksum_sha256) VALUES ($1, $2)',
        [file, checksum],
      );
      await client.query('COMMIT');
      appliedCount += 1;
      console.log(`APPLY ${file}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
  console.log(`Migration run complete. Newly applied: ${appliedCount}.`);
} catch (error) {
  console.error('Migration failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  try { await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]); } catch {}
  await client.end().catch(() => {});
}
