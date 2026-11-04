import pg from 'pg';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { databaseSslOptions } from '../scripts/lib/db-ssl.mjs';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { missingSchemaObjects } from './readiness.js';
import { createMediaStore } from './media/store.js';
import { runCycle, type TaskContext } from './jobs/index.js';

// Vercel runs this Fastify application as a Node.js Function. Do not call app.listen()
// here: Vercel owns the HTTP server and reuses warm instances where possible.
pg.types.setTypeParser(20, value => Number(value));

const env = process.env;
if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
  throw new Error('SESSION_SECRET must contain at least 32 characters');
}
if (env.DATABASE_SSL !== 'true') throw new Error('DATABASE_SSL=true is required in Vercel production');
if (!env.CRON_SECRET || env.CRON_SECRET.length < 32) {
  throw new Error('CRON_SECRET must contain at least 32 random characters');
}

const poolSize = Number(env.DATABASE_POOL_SIZE ?? 3);
if (!Number.isInteger(poolSize) || poolSize < 1 || poolSize > 5) {
  throw new Error('DATABASE_POOL_SIZE must be an integer from 1 to 5 on Vercel');
}

const config = loadConfig(env);
if (config.mediaStorage !== 'supabase') {
  throw new Error('MEDIA_STORAGE=supabase is required on Vercel; serverless local disk is not persistent');
}
const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  // Serverless instances multiply connections. Use the Supabase transaction pooler
  // and a deliberately small per-instance pool; tune only after observing load.
  max: poolSize,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
  allowExitOnIdle: true,
  ...databaseSslOptions(env),
});
pool.on('error', error => console.error(JSON.stringify({
  level: 'error',
  message: 'Idle PostgreSQL client error',
  error: error.message,
})));

const app = await buildApp({ config, pool, rateLimit: !config.rateLimitDisabled });

app.get('/ready', async (_request, reply) => {
  try {
    const missing = await missingSchemaObjects(pool);
    if (missing.tables.length || missing.columns.length) {
      return reply.code(503).send({ status: 'not_ready', reason: 'Database schema is not ready' });
    }
    await pool.query('SELECT 1');
    return { status: 'ready' };
  } catch {
    return reply.code(503).send({ status: 'not_ready', reason: 'Database is unavailable' });
  }
});

// Vercel Cron invokes this bounded worker cycle once per minute on Pro.
// PostgreSQL advisory locking prevents overlapping cron invocations across instances.
// The durable queue still provides leases, retries, deduplication and crash recovery.
const cronSecret = env.CRON_SECRET ?? '';
const workerContext: TaskContext = {
  pool,
  log: (message, detail = {}) => console.log(JSON.stringify({
    time: new Date().toISOString(),
    service: 'sac-vercel-worker',
    message,
    ...detail,
  })),
  media: createMediaStore(config),
  storefrontRevalidateUrl: env.STOREFRONT_REVALIDATE_URL?.trim() || null,
  revalidateToken: env.REVALIDATE_TOKEN && env.REVALIDATE_TOKEN.length >= 32
    ? env.REVALIDATE_TOKEN
    : null,
};

function hasValidCronSecret(header: unknown): boolean {
  if (!cronSecret || typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(cronSecret);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

app.get('/api/internal/worker', async (request, reply) => {
  if (!hasValidCronSecret(request.headers.authorization)) {
    return reply.code(404).send({ error: 'NOT_FOUND' });
  }

  const lockClient = await pool.connect();
  const lockKey = 731_204_116;
  let locked = false;
  try {
    const lock = await lockClient.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1::bigint) AS locked',
      [lockKey],
    );
    locked = Boolean(lock.rows[0]?.locked);
    if (!locked) return { ok: true, skipped: true, reason: 'worker_already_running' };

    const workerId = `vercel:${randomUUID()}`;
    const result = await runCycle(workerContext, workerId, {
      concurrency: 1,
      // Greater than the configured function duration so timed-out work is recoverable.
      leaseSeconds: 120,
    });
    return { ok: true, worker: workerId, ...result };
  } finally {
    if (locked) {
      await lockClient.query('SELECT pg_advisory_unlock($1::bigint)', [lockKey]).catch(() => undefined);
    }
    lockClient.release();
  }
});

export default app;
