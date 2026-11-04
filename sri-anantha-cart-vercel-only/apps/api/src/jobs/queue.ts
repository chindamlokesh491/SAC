import type { Pool, PoolClient } from 'pg';

/**
 * Durable PostgreSQL job queue (tables from migration 023).
 *
 * Guarantees:
 *  - A job is held by at most one worker at a time: claiming uses FOR UPDATE SKIP LOCKED and a lease.
 *  - A job whose worker crashed is retried once its lease expires (reapExpiredLeases).
 *  - Failures retry with exponential backoff; after max_attempts the job is 'dead' and kept for review.
 *  - dedupe_key makes enqueueing idempotent (scheduled slots, outbox fan-out).
 * Delivery is at-least-once, so every handler must be idempotent.
 */
export type Db = Pool | PoolClient;
export type JobRow = { id: string; kind: string; payload: Record<string, unknown>; attempts: number; max_attempts: number };

export async function enqueueJob(db: Db, kind: string, payload: Record<string, unknown> = {}, options: { dedupeKey?: string; runAt?: Date; maxAttempts?: number } = {}): Promise<boolean> {
  const result = await db.query(
    `INSERT INTO jobs (kind, payload, dedupe_key, run_at, max_attempts) VALUES ($1, $2, $3, COALESCE($4, now()), $5)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [kind, JSON.stringify(payload), options.dedupeKey ?? null, options.runAt ?? null, options.maxAttempts ?? 8],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Records a fact for the worker to act on. Call inside the same transaction as the change when possible. */
export async function recordOutboxEvent(db: Db, topic: string, payload: Record<string, unknown> = {}): Promise<void> {
  await db.query('INSERT INTO outbox_events (topic, payload) VALUES ($1, $2)', [topic, JSON.stringify(payload)]);
}

export async function claimJobs(pool: Pool, worker: string, limit: number, leaseSeconds: number): Promise<JobRow[]> {
  // Claim and attempt record in one statement, so a crash cannot leave one without the other.
  const result = await pool.query<JobRow>(
    `WITH claimed AS (
       UPDATE jobs j
          SET status = 'running', attempts = j.attempts + 1, locked_by = $1,
              locked_until = now() + make_interval(secs => $3), updated_at = now()
        WHERE j.id IN (SELECT id FROM jobs WHERE status = 'queued' AND run_at <= now()
                        ORDER BY run_at LIMIT $2 FOR UPDATE SKIP LOCKED)
        RETURNING j.id, j.kind, j.payload, j.attempts, j.max_attempts
     ), attempt AS (
       INSERT INTO job_attempts (job_id, attempt, worker) SELECT id, attempts, $1 FROM claimed
     )
     SELECT * FROM claimed`,
    [worker, limit, leaseSeconds],
  );
  return result.rows;
}

/** Exponential backoff: 10 s, 20 s, 40 s ... capped at 15 minutes, with up to 20% jitter. */
export function backoffSeconds(attempt: number, random = Math.random): number {
  const base = Math.min(10 * 2 ** Math.max(0, attempt - 1), 900);
  return Math.round(base * (1 + random() * 0.2));
}

export async function completeJob(pool: Pool, job: JobRow, worker: string): Promise<void> {
  // Only the lease holder may finish the job; a reclaimed job belongs to its new worker.
  const done = await pool.query(
    `UPDATE jobs SET status = 'succeeded', locked_by = NULL, locked_until = NULL, last_error = NULL, finished_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'running' AND locked_by = $2 AND attempts = $3`, [job.id, worker, job.attempts]);
  await pool.query(`UPDATE job_attempts SET finished_at = now(), outcome = $3 WHERE job_id = $1 AND attempt = $2`,
    [job.id, job.attempts, done.rowCount ? 'succeeded' : 'lease_expired']);
}

export async function failJob(pool: Pool, job: JobRow, worker: string, error: unknown, options: { permanent?: boolean } = {}): Promise<'retry' | 'dead'> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
  const dead = options.permanent || job.attempts >= job.max_attempts;
  await pool.query(
    `UPDATE jobs SET status = $4, locked_by = NULL, locked_until = NULL, last_error = $5, updated_at = now(),
            run_at = CASE WHEN $4 = 'queued' THEN now() + make_interval(secs => $6) ELSE run_at END,
            finished_at = CASE WHEN $4 = 'dead' THEN now() END
      WHERE id = $1 AND status = 'running' AND locked_by = $2 AND attempts = $3`,
    [job.id, worker, job.attempts, dead ? 'dead' : 'queued', message, backoffSeconds(job.attempts)],
  );
  await pool.query(`UPDATE job_attempts SET finished_at = now(), outcome = $3, error = $4 WHERE job_id = $1 AND attempt = $2`,
    [job.id, job.attempts, dead ? 'dead' : 'retry', message]);
  return dead ? 'dead' : 'retry';
}

/** Crash recovery: jobs whose lease ran out go back to the queue (or to 'dead' if out of attempts). */
export async function reapExpiredLeases(pool: Pool): Promise<number> {
  const result = await pool.query<{ id: string; attempts: number }>(
    `UPDATE jobs SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'queued' END,
            run_at = now() + interval '5 seconds', locked_by = NULL, locked_until = NULL,
            last_error = 'Worker stopped before finishing (lease expired)', updated_at = now(),
            finished_at = CASE WHEN attempts >= max_attempts THEN now() END
      WHERE status = 'running' AND locked_until < now()
      RETURNING id, attempts`,
  );
  for (const row of result.rows) {
    await pool.query(`UPDATE job_attempts SET finished_at = now(), outcome = 'lease_expired' WHERE job_id = $1 AND attempt = $2 AND finished_at IS NULL`, [row.id, row.attempts]);
  }
  return result.rowCount ?? 0;
}

/** Fan-out: each outbox event becomes its jobs exactly once, in one transaction per batch. */
export async function relayOutbox(pool: Pool, routes: Record<string, string[]>, batch = 100): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const events = await client.query<{ id: string; topic: string; payload: Record<string, unknown> }>(
      `SELECT id, topic, payload FROM outbox_events WHERE published_at IS NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`, [batch]);
    for (const event of events.rows) {
      for (const kind of routes[event.topic] ?? []) {
        await enqueueJob(client, kind, { ...event.payload, outbox_event_id: event.id, topic: event.topic }, { dedupeKey: `outbox:${event.id}:${kind}` });
      }
    }
    if (events.rows.length) await client.query('UPDATE outbox_events SET published_at = now() WHERE id = ANY($1::bigint[])', [events.rows.map(event => event.id)]);
    await client.query('COMMIT');
    return events.rows.length;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Job counts by status, plus the oldest due job, for health checks and monitoring. */
export async function queueStats(pool: Pool) {
  const result = await pool.query<{ status: string; count: number }>('SELECT status, COUNT(*)::integer AS count FROM jobs GROUP BY status');
  const lag = await pool.query<{ seconds: number | null }>(`SELECT EXTRACT(EPOCH FROM now() - MIN(run_at))::integer AS seconds FROM jobs WHERE status = 'queued' AND run_at <= now()`);
  return { counts: Object.fromEntries(result.rows.map(row => [row.status, row.count])), oldest_due_seconds: lag.rows[0]?.seconds ?? 0 };
}
