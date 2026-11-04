import type { Pool } from 'pg';
import { claimJobs, completeJob, enqueueJob, failJob, reapExpiredLeases, relayOutbox, type JobRow } from './queue.js';
import { handlers, outboxRoutes, PermanentJobError, schedules, type Schedule, type TaskContext } from './tasks.js';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** The slot key for a schedule at a given time; one job per slot no matter how many workers run. */
export function scheduleSlot(schedule: Schedule, now: Date): { dedupeKey: string; runAt: Date } | null {
  if ('everySeconds' in schedule) {
    const slot = Math.floor(now.getTime() / (schedule.everySeconds * 1000));
    return { dedupeKey: `schedule:${schedule.kind}:${slot}`, runAt: now };
  }
  const [hours, minutes] = schedule.dailyAtIst.split(':').map(Number) as [number, number];
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const due = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), hours, minutes) - IST_OFFSET_MS;
  if (now.getTime() < due) return null;
  return { dedupeKey: `schedule:${schedule.kind}:${ist.toISOString().slice(0, 10)}`, runAt: new Date(due) };
}

export async function enqueueDueSchedules(pool: Pool, now = new Date()): Promise<number> {
  let added = 0;
  for (const schedule of schedules) {
    const slot = scheduleSlot(schedule, now);
    if (slot && await enqueueJob(pool, schedule.kind, {}, { dedupeKey: slot.dedupeKey, runAt: slot.runAt, maxAttempts: 3 })) added++;
  }
  return added;
}

async function runOne(job: JobRow, worker: string, context: TaskContext): Promise<'succeeded' | 'retry' | 'dead'> {
  const handler = handlers[job.kind];
  if (!handler) return failJob(context.pool, job, worker, new Error(`No handler for job kind ${job.kind}`), { permanent: true });
  try {
    await handler(job.payload, context);
    await completeJob(context.pool, job, worker);
    return 'succeeded';
  } catch (error) {
    const outcome = await failJob(context.pool, job, worker, error, { permanent: error instanceof PermanentJobError });
    context.log(outcome === 'dead' ? 'Job failed permanently' : 'Job failed; will retry', { kind: job.kind, id: job.id, attempt: job.attempts, error: error instanceof Error ? error.message : String(error) });
    return outcome;
  }
}

/** One worker cycle: recover expired leases, enqueue due schedules, relay the outbox, run claimed jobs. */
export async function runCycle(context: TaskContext, worker: string, options: { concurrency: number; leaseSeconds: number }) {
  await reapExpiredLeases(context.pool);
  await enqueueDueSchedules(context.pool);
  await relayOutbox(context.pool, outboxRoutes);
  const jobs = await claimJobs(context.pool, worker, options.concurrency, options.leaseSeconds);
  // Every job is awaited before the next cycle; nothing runs detached.
  const outcomes = await Promise.all(jobs.map(job => runOne(job, worker, context)));
  return { ran: jobs.length, outcomes };
}
