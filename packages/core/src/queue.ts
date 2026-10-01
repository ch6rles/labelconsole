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
const queues = new Map<QueueName, Queue>();

export function queue(name: QueueName): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, { connection: createRedis(), prefix: prefix(), defaultJobOptions: DEFAULT_JOB_OPTIONS });
    queues.set(name, q);
  }
  return q;
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

export type JobDefinition<K extends JobName = JobName> = {
  name: K;
  queue?: QueueName;
  handler: JobHandler<K>;
};

export function defineJob<K extends JobName>(name: K, handler: JobHandler<K>, queueName: QueueName = 'jobs'): JobDefinition<K> {
  return { name, handler, queue: queueName };
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

export async function closeQueues() {
  await Promise.all([...queues.values()].map((q) => q.close()));
  queues.clear();
}
