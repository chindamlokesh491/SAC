import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, describe, it } from 'node:test';
import { backoffSeconds, claimJobs, completeJob, enqueueJob, failJob, reapExpiredLeases, relayOutbox } from '../src/jobs/queue.js';
import { enqueueDueSchedules, runCycle, scheduleSlot } from '../src/jobs/runner.js';
import type { TaskContext } from '../src/jobs/tasks.js';
import { localMediaStore } from '../src/media/store.js';
import { createHarness, skipReason, type Harness } from './support/harness.js';

describe('job schedule slots', () => {
  it('interval schedules get one slot per period; daily schedules start at the IST time', () => {
    const at = (iso: string) => new Date(iso);
    const every = { kind: 'x.y', everySeconds: 60 };
    assert.equal(scheduleSlot(every, at('2026-11-01T10:00:05Z'))!.dedupeKey, scheduleSlot(every, at('2026-11-01T10:00:55Z'))!.dedupeKey);
    assert.notEqual(scheduleSlot(every, at('2026-11-01T10:00:55Z'))!.dedupeKey, scheduleSlot(every, at('2026-11-01T10:01:05Z'))!.dedupeKey);
    const daily = { kind: 'x.daily', dailyAtIst: '03:10' };
    assert.equal(scheduleSlot(daily, at('2026-11-01T21:30:00Z')), null, '03:00 IST is before 03:10');
    assert.equal(scheduleSlot(daily, at('2026-11-01T21:45:00Z'))!.dedupeKey, 'schedule:x.daily:2026-11-02', '03:15 IST on 2 Nov');
  });
  it('backoff doubles and is capped at 15 minutes plus jitter', () => {
    assert.equal(backoffSeconds(1, () => 0), 10);
    assert.equal(backoffSeconds(3, () => 0), 40);
    assert.equal(backoffSeconds(20, () => 0), 900);
    assert.ok(backoffSeconds(20, () => 0.999) <= 1080);
  });
  it('the API process runs no background timers', async () => {
    const server = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
    assert.ok(!/setInterval|setTimeout/.test(server));
  });
});

describe('durable job queue (integration)', { skip: skipReason }, () => {
  let h: Harness;
  before(async () => { h = await createHarness(); });
  after(async () => { await h?.close(); });
  beforeEach(async () => { await h.pool.query('DELETE FROM jobs; DELETE FROM outbox_events'); });

  const context = (overrides: Partial<TaskContext> = {}): TaskContext => ({
    pool: h.pool, media: localMediaStore(h.mediaDir), storefrontRevalidateUrl: null, revalidateToken: null, log: () => undefined, ...overrides,
  });

  it('dedupe keys make enqueueing idempotent', async () => {
    assert.equal(await enqueueJob(h.pool, 'catalog.refresh_sales', {}, { dedupeKey: 'once' }), true);
    assert.equal(await enqueueJob(h.pool, 'catalog.refresh_sales', {}, { dedupeKey: 'once' }), false);
    assert.equal(Number((await h.pool.query('SELECT COUNT(*) FROM jobs')).rows[0].count), 1);
  });

  it('two workers claiming at the same time never receive the same job', async () => {
    for (let i = 0; i < 30; i++) await enqueueJob(h.pool, 'catalog.refresh_sales');
    const [a, b, c] = await Promise.all([claimJobs(h.pool, 'w1', 12, 60), claimJobs(h.pool, 'w2', 12, 60), claimJobs(h.pool, 'w3', 12, 60)]);
    const ids = [...a, ...b, ...c].map(job => job.id);
    assert.equal(ids.length, 30);
    assert.equal(new Set(ids).size, 30);
    const attempts = await h.pool.query('SELECT COUNT(*)::int AS n FROM job_attempts WHERE job_id = ANY($1::uuid[])', [ids]);
    assert.equal(attempts.rows[0].n, 30, 'every claim has an attempt record');
  });

  it('failures retry with backoff, then the job is dead with its full attempt history', async () => {
    await enqueueJob(h.pool, 'test.fail', {}, { maxAttempts: 2 });
    let [job] = await claimJobs(h.pool, 'w1', 1, 60);
    assert.equal(await failJob(h.pool, job!, 'w1', new Error('provider timeout')), 'retry');
    const queued = (await h.pool.query(`SELECT status, run_at > now() + interval '5 seconds' AS later FROM jobs WHERE id = $1`, [job!.id])).rows[0];
    assert.deepEqual(queued, { status: 'queued', later: true });
    await h.pool.query('UPDATE jobs SET run_at = now() WHERE id = $1', [job!.id]);
    [job] = await claimJobs(h.pool, 'w1', 1, 60);
    assert.equal(job!.attempts, 2);
    assert.equal(await failJob(h.pool, job!, 'w1', new Error('provider timeout')), 'dead');
    const history = await h.pool.query('SELECT attempt, outcome, error FROM job_attempts WHERE job_id = $1 ORDER BY attempt', [job!.id]);
    assert.deepEqual(history.rows, [{ attempt: 1, outcome: 'retry', error: 'provider timeout' }, { attempt: 2, outcome: 'dead', error: 'provider timeout' }]);
    assert.deepEqual(await claimJobs(h.pool, 'w1', 5, 60), [], 'dead jobs are never picked up again');
  });

  it('a crashed worker’s job is reclaimed after its lease, and the old worker cannot finish it', async () => {
    await enqueueJob(h.pool, 'catalog.refresh_sales');
    const [stale] = await claimJobs(h.pool, 'crashed', 1, 60);
    await h.pool.query(`UPDATE jobs SET locked_until = now() - interval '1 second' WHERE id = $1`, [stale!.id]);
    assert.equal(await reapExpiredLeases(h.pool), 1);
    await h.pool.query('UPDATE jobs SET run_at = now() WHERE id = $1', [stale!.id]);
    const [fresh] = await claimJobs(h.pool, 'healthy', 1, 60);
    assert.equal(fresh!.id, stale!.id);
    await completeJob(h.pool, stale!, 'crashed'); // late finish from the dead worker: ignored
    assert.equal((await h.pool.query('SELECT status, locked_by FROM jobs WHERE id = $1', [fresh!.id])).rows[0].locked_by, 'healthy');
    await completeJob(h.pool, fresh!, 'healthy');
    assert.equal((await h.pool.query('SELECT status FROM jobs WHERE id = $1', [fresh!.id])).rows[0].status, 'succeeded');
  });

  it('each outbox event produces its jobs exactly once, even with concurrent relays', async () => {
    for (let i = 0; i < 5; i++) await h.pool.query(`INSERT INTO outbox_events (topic) VALUES ('catalog.changed')`);
    await Promise.all([relayOutbox(h.pool, { 'catalog.changed': ['storefront.revalidate'] }), relayOutbox(h.pool, { 'catalog.changed': ['storefront.revalidate'] })]);
    await relayOutbox(h.pool, { 'catalog.changed': ['storefront.revalidate'] });
    assert.equal(Number((await h.pool.query(`SELECT COUNT(*) FROM jobs WHERE kind = 'storefront.revalidate'`)).rows[0].count), 5);
    assert.equal(Number((await h.pool.query('SELECT COUNT(*) FROM outbox_events WHERE published_at IS NULL')).rows[0].count), 0);
  });

  it('scheduled jobs are enqueued once per slot however many workers run', async () => {
    const now = new Date();
    await Promise.all([enqueueDueSchedules(h.pool, now), enqueueDueSchedules(h.pool, now), enqueueDueSchedules(h.pool, now)]);
    const rows = await h.pool.query(`SELECT kind, COUNT(*)::int AS n FROM jobs GROUP BY kind`);
    assert.ok(rows.rows.length >= 3);
    assert.ok(rows.rows.every(row => row.n === 1));
  });

  it('an admin catalogue change records catalog.changed and the worker revalidates the storefront', async () => {
    const admin = await h.login('9800000201', 'admin');
    const categoryId = await h.seed.category('Outbox');
    await h.request('GET', '/api/v1/admin/categories', { token: admin.token });
    assert.equal(Number((await h.pool.query('SELECT COUNT(*) FROM outbox_events')).rows[0].count), 0, 'reads record nothing');
    const changed = await h.request('PATCH', `/api/v1/admin/categories/${categoryId}`, { token: admin.token, body: { name: 'Outbox Renamed' } });
    assert.equal(changed.status, 200, changed.body);
    assert.equal(Number((await h.pool.query(`SELECT COUNT(*) FROM outbox_events WHERE topic = 'catalog.changed'`)).rows[0].count), 1);

    const calls: { url: string; token: string | null }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, token: new Headers(init.headers).get('x-revalidate-token') });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const ctx = context({ storefrontRevalidateUrl: 'https://shop.example/internal/revalidate', revalidateToken: 'r'.repeat(40), fetch: fakeFetch });
    for (let i = 0; i < 3; i++) await runCycle(ctx, 'w1', { concurrency: 10, leaseSeconds: 60 });
    assert.deepEqual(calls, [{ url: 'https://shop.example/internal/revalidate', token: 'r'.repeat(40) }]);
    assert.equal((await h.pool.query(`SELECT status FROM jobs WHERE kind = 'storefront.revalidate'`)).rows[0].status, 'succeeded');
  });

  it('a rejected revalidate token fails permanently instead of retrying forever', async () => {
    await enqueueJob(h.pool, 'storefront.revalidate');
    const fakeFetch = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch;
    await runCycle(context({ storefrontRevalidateUrl: 'https://shop.example/internal/revalidate', revalidateToken: 'r'.repeat(40), fetch: fakeFetch }), 'w1', { concurrency: 10, leaseSeconds: 60 });
    assert.equal((await h.pool.query(`SELECT status FROM jobs WHERE kind = 'storefront.revalidate'`)).rows[0].status, 'dead');
  });
});
