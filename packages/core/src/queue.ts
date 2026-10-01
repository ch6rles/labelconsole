import { Queue, type Job, type JobsOptions } from 'bullmq';
import type { ServiceContext } from './context';
import { withSystemOrg } from './context';
import { logger, type Logger } from './logger';
import { createRedis } from './redis';

/**
 * Background jobs. Modules extend `JobMap` with declaration merging:
 *
 *   declare module '@labelconsole/core/queue' {
 *     interface JobMap { 'catalogue.bulk-import': { importId: string } }
 *   }
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface JobMap {}

export type JobName = keyof JobMap & string;
export type QueueName = 'jobs' | 'agents' | 'events';
export const QUEUE_NAMES: QueueName[] = ['jobs', 'agents', 'events'];

export type JobEnvelope<K extends JobName = JobName> = { orgId: string | null; data: JobMap[K] };

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 24 * 3600, count: 2000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

const prefix = () => process.env.LC_QUEUE_PREFIX ?? 'lc';
const queues = new Map<QueueName, { queue: Queue; connection: ReturnType<typeof createRedis> }>();

export function queue(name: QueueName): Queue {
  let entry = queues.get(name);
  if (!entry) {
    const connection = createRedis();
    entry = { queue: new Queue(name, { connection, prefix: prefix(), defaultJobOptions: DEFAULT_JOB_OPTIONS }), connection };
    queues.set(name, entry);
  }
  return entry.queue;
}

export function queuePrefix() {
  return prefix();
}

export type EnqueueOptions = JobsOptions & { queue?: QueueName };

export async function enqueue<K extends JobName>(name: K, orgId: string | null, data: JobMap[K], opts: EnqueueOptions = {}) {
  const { queue: queueName = 'jobs', ...jobOpts } = opts;
  const envelope: JobEnvelope<K> = { orgId, data };
  return queue(queueName).add(name, envelope, jobOpts);
}

/**
 * Enqueue once the surrounding transaction commits, so the worker never picks
 * up a job whose rows it cannot see yet.
 */
export function enqueueAfterCommit<K extends JobName>(ctx: ServiceContext, name: K, data: JobMap[K], opts: EnqueueOptions = {}) {
  ctx.afterCommit(() => enqueue(name, ctx.orgId, data, opts));
}

export interface JobContext {
  orgId: string | null;
  job: Job;
  log: Logger;
  progress(value: number | object): Promise<void>;
  /** Run tenant-scoped work as the platform for this job's org. */
  withOrg<T>(fn: (ctx: ServiceContext) => Promise<T>): Promise<T>;
}

export type JobHandler<K extends JobName> = (ctx: JobContext, data: JobMap[K]) => Promise<unknown>;

/** Stored form of a job; `defineJob` checks the data type against JobMap at the definition site. */
export type JobDefinition = {
  name: JobName;
  queue?: QueueName;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (ctx: JobContext, data: any) => Promise<unknown>;
};

export function defineJob<K extends JobName>(name: K, handler: JobHandler<K>, queueName: QueueName = 'jobs'): JobDefinition {
  return { name, handler: handler as JobDefinition['handler'], queue: queueName };
}

/** A platform-wide repeatable job (fan-out jobs then enqueue per-org work). */
export type ScheduleDefinition = {
  id: string;
  job: JobName;
  everyMs?: number;
  cron?: string;
};

export function makeJobContext(job: Job): JobContext {
  const env = job.data as JobEnvelope;
  return {
    orgId: env.orgId,
    job,
    log: logger.child({ job: job.name, jobId: job.id, orgId: env.orgId }),
    progress: (v) => job.updateProgress(v),
    withOrg: (fn) => {
      if (!env.orgId) throw new Error(`Job ${job.name} has no org`);
      return withSystemOrg(env.orgId, fn, `job:${job.name}`);
    },
  };
}

/** BullMQ doesn't close a connection it was handed, so quit ours after each queue closes. */
export async function closeQueues() {
  await Promise.all(
    [...queues.values()].map(async ({ queue: q, connection }) => {
      await q.close();
      await connection.quit().catch(() => connection.disconnect());
    }),
  );
  queues.clear();
}
