import pg from 'pg';
import { databaseSslOptions } from '../scripts/lib/db-ssl.mjs';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { missingSchemaObjects } from './readiness.js';

// COUNT/SUM results arrive as int8; store amounts are far below 2^53, so parse them as numbers.
pg.types.setTypeParser(20, value => Number(value));

const config = loadConfig();
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DATABASE_POOL_SIZE ?? 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 3_000,
  ...databaseSslOptions(process.env),
});

// An idle client can be dropped by the database or network at any time. Without this
// handler pg re-emits the error on the pool and the whole process exits.
pool.on('error', error => { app.log.error({ err: error }, 'Idle PostgreSQL client error'); });

const app = await buildApp({ config, pool, rateLimit: !config.rateLimitDisabled });

app.get('/ready', async (_request, reply) => {
  try {
    const missing = await missingSchemaObjects(pool);
    if (missing.tables.length || missing.columns.length) {
      app.log.warn(missing, 'Readiness check failed: database migrations are incomplete');
      return reply.code(503).send({ status: 'not_ready', reason: 'Database schema is not ready' });
    }
    return { status: 'ready' };
  } catch {
    return reply.code(503).send({ status: 'not_ready', reason: 'Database is unavailable' });
  }
});

// Background work (payment reconciliation, reservation expiry, cache revalidation, ...) runs in
// apps/worker from the durable jobs table, never on timers inside this process.

try {
  await app.listen({ host: process.env.HOST ?? '0.0.0.0', port: Number(process.env.PORT ?? 4000) });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

const shutdown = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
