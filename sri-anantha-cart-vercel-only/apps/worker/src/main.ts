import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { createMediaStore, databaseSslOptions, loadConfig, missingSchemaObjects, queueStats, runCycle, type TaskContext } from '@sac/api/jobs';

/**
 * Background worker: runs jobs from the PostgreSQL jobs table (see apps/api/src/jobs).
 * Several copies may run at once; the queue guarantees each job is held by one worker at a time.
 */
pg.types.setTypeParser(20, value => Number(value));

const env = process.env;
if (!env.DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(1); }
const concurrency = Math.min(Math.max(Number(env.WORKER_CONCURRENCY ?? 2), 1), 10);
const pollMs = Math.min(Math.max(Number(env.WORKER_POLL_MS ?? 2000), 250), 60_000);
const leaseSeconds = Math.min(Math.max(Number(env.WORKER_LEASE_SECONDS ?? 300), 30), 3600);
const workerId = `${hostname()}:${process.pid}`;

// Small pool: the worker needs one connection per concurrent job plus one for the cycle itself.
const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: concurrency + 1,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ...databaseSslOptions(env),
});
pool.on('error', error => log('Idle PostgreSQL client error', { error: error.message }));

function log(message: string, detail: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), worker: workerId, message, ...detail }));
}

const revalidateUrl = env.STOREFRONT_REVALIDATE_URL?.trim() || null;
if (revalidateUrl && !revalidateUrl.startsWith('https://') && env.NODE_ENV === 'production') {
  console.error('STOREFRONT_REVALIDATE_URL must use https in production'); process.exit(1);
}
// Same validation as the API (storage settings, production safety checks).
const config = loadConfig(env);
const context: TaskContext = {
  pool, log, media: createMediaStore(config),
  storefrontRevalidateUrl: revalidateUrl,
  revalidateToken: env.REVALIDATE_TOKEN && env.REVALIDATE_TOKEN.length >= 32 ? env.REVALIDATE_TOKEN : null,
};

const missing = await missingSchemaObjects(pool);
const missingNames = [...missing.tables, ...missing.columns];
if (missingNames.length) { console.error(`Database schema is not migrated (missing: ${missingNames.join(', ')}). Run pnpm --filter @sac/api migrate.`); process.exit(1); }

let stopping = false;
const stop = (signal: string) => { if (!stopping) { stopping = true; log('Stopping after the current jobs finish', { signal }); } };
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

log('Worker started', { concurrency, pollMs, leaseSeconds });
let lastStats = 0;
while (!stopping) {
  try {
    const { ran } = await runCycle(context, workerId, { concurrency, leaseSeconds });
    if (Date.now() - lastStats > 5 * 60_000) { lastStats = Date.now(); log('Queue status', await queueStats(pool)); }
    if (ran === 0) await sleep(pollMs);
  } catch (error) {
    log('Worker cycle failed', { error: error instanceof Error ? error.message : String(error) });
    await sleep(Math.min(pollMs * 5, 30_000));
  }
}
await pool.end();
log('Worker stopped');
process.exit(0);
