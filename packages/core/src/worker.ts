import { createServer, type Server } from 'node:http';
import { DelayedError, Worker, type Job } from 'bullmq';
import { inArray, sql } from 'drizzle-orm';
import { withSystemOrg } from './context';
import { systemDb } from './db/client';
import { domainEvents, organizations } from './db/schema';
import { env } from './env';
import { RateLimitedError } from './errors';
import { OUTBOX_WAKE_CHANNEL, type StoredEvent } from './events';
import { logger } from './logger';
import { clearHeartbeat, heartbeat, recordJob } from './metrics';
import { enabledModuleIds, type EventListener, type ModuleServer } from './modules';
import { makeJobContext, queue, queuePrefix, QUEUE_NAMES, type JobDefinition, type QueueName } from './queue';
import { publish } from './realtime';
import { createRedis } from './redis';

/**
 * The persistent worker service: everything slow or scheduled runs here so it
 * keeps going with every browser closed. One process type, horizontally
 * scalable: BullMQ hands each job to exactly one worker, and stalled jobs from
 * a crashed process are re-queued automatically.
 */
export type WorkerRuntime = {
  stop(): Promise<void>;
  /** Dispatch pending outbox events now (tests and the wake channel use this). */
  dispatchOutbox(): Promise<number>;
  workers: Worker[];
};

export type WorkerOptions = {
  modules: ModuleServer[];
  concurrency?: Partial<Record<QueueName, number>>;
  outboxPollMs?: number;
  /** Register repeatable schedules (off in most tests). */
  schedules?: boolean;
  healthPort?: number | null;
};

type EventJobData = { eventId: number; listenerId: string };

export async function startWorker(opts: WorkerOptions): Promise<WorkerRuntime> {
  const log = logger.child({ component: 'worker' });
  const jobs = new Map<string, JobDefinition>();
  const listeners: Array<EventListener & { moduleId: string }> = [];
  for (const m of opts.modules) {
    for (const j of m.jobs ?? []) jobs.set(j.name, j);
    for (const l of m.listeners ?? []) listeners.push({ ...l, moduleId: m.manifest.id });
  }

  /* ----------------------------------------------------------- outbox -- */
  const enabledCache = new Map<string, { at: number; ids: Set<string> }>();
  async function enabledFor(orgId: string) {
    const hit = enabledCache.get(orgId);
    if (hit && Date.now() - hit.at < 30_000) return hit.ids;
    const [org] = await systemDb().select({ id: organizations.id, plan: organizations.plan }).from(organizations).where(sql`${organizations.id} = ${orgId}`);
    const ids = org ? await enabledModuleIds(systemDb(), org) : new Set<string>();
    enabledCache.set(orgId, { at: Date.now(), ids });
    return ids;
  }

  let dispatching: Promise<number> | null = null;
  async function dispatchOnce(): Promise<number> {
    return systemDb().transaction(async (tx) => {
      const rows = (await tx.execute(
        sql`select id, org_id, type, payload, actor, created_at from domain_events where dispatched_at is null order by id limit 200 for update skip locked`,
      )) as unknown as Array<{ id: string | number; org_id: string; type: string; payload: Record<string, unknown>; actor: string | null; created_at: Date }>;
      if (rows.length === 0) return 0;
      const bulk: Array<{ name: string; data: unknown; opts: { jobId: string } }> = [];
      for (const r of rows) {
        const enabled = await enabledFor(r.org_id);
        for (const l of listeners) {
          if (!enabled.has(l.moduleId)) continue;
          if (l.event !== r.type && (l.event as string) !== '*') continue;
          bulk.push({ name: 'event', data: { orgId: r.org_id, data: { eventId: Number(r.id), listenerId: l.id } }, opts: { jobId: `ev-${r.id}-${l.id}` } });
        }
      }
      if (bulk.length) await queue('events').addBulk(bulk);
      await tx.update(domainEvents).set({ dispatchedAt: new Date() }).where(inArray(domainEvents.id, rows.map((r) => Number(r.id))));
      for (const r of rows) {
        await publish(r.org_id, { type: r.type, data: { eventId: Number(r.id), ...r.payload } }).catch(() => undefined);
      }
      return rows.length;
    });
  }

  async function dispatchOutbox(): Promise<number> {
    if (dispatching) return dispatching;
    dispatching = (async () => {
      let total = 0;
      for (;;) {
        const n = await dispatchOnce();
        total += n;
        if (n < 200) break;
      }
      return total;
    })().finally(() => {
      dispatching = null;
    });
    return dispatching;
  }

  /* ---------------------------------------------------------- workers -- */
  const connection = createRedis();
  const conc = { jobs: env().WORKER_CONCURRENCY, events: 16, agents: env().WORKER_AGENT_CONCURRENCY, ...opts.concurrency };

  async function processJob(job: Job, token?: string) {
    const def = jobs.get(job.name);
    if (!def) throw new Error(`No handler registered for job ${job.name}`);
    try {
      return await def.handler(makeJobContext(job), (job.data as { data: never }).data);
    } catch (err) {
      if (err instanceof RateLimitedError && token) {
        // Back off and reschedule instead of burning an attempt.
        await job.moveToDelayed(Date.now() + Math.max(1000, err.retryAfterMs), token);
        throw new DelayedError();
      }
      throw err;
    }
  }

  async function processEvent(job: Job) {
    const { orgId, data } = job.data as { orgId: string; data: EventJobData };
    const listener = listeners.find((l) => l.id === data.listenerId);
    if (!listener) return;
    const [row] = await systemDb().select().from(domainEvents).where(sql`${domainEvents.id} = ${data.eventId}`);
    if (!row) return;
    const event: StoredEvent = { id: row.id, orgId: row.orgId, type: row.type, payload: row.payload as never, actor: row.actor, createdAt: row.createdAt };
    await withSystemOrg(orgId, (ctx) => listener.handle(ctx, event as never), `listener:${listener.id}`);
  }

  let active = 0;
  /** Run a job and count it (by listener for events) so /api/metrics can show throughput and failures. */
  async function timed(name: QueueName, job: Job, token?: string) {
    const label = name === 'events' && job.name === 'event' ? `event:${(job.data as { data: EventJobData }).data.listenerId}` : job.name;
    const started = Date.now();
    active++;
    try {
      const out = await (name === 'events' && job.name === 'event' ? processEvent(job) : processJob(job, token));
      void recordJob(name, label, 'completed', Date.now() - started);
      return out;
    } catch (err) {
      void recordJob(name, label, err instanceof DelayedError ? 'delayed' : 'failed', Date.now() - started);
      throw err;
    } finally {
      active--;
    }
  }

  const workers = QUEUE_NAMES.map(
    (name) =>
      new Worker(name, (job, token) => timed(name, job, token), {
        connection,
        prefix: queuePrefix(),
        concurrency: conc[name],
        lockDuration: 60_000,
        stalledInterval: 30_000,
        maxStalledCount: 3,
      }),
  );
  for (const w of workers) {
    w.on('failed', (job, err) => log.warn({ queue: w.name, job: job?.name, jobId: job?.id, attempts: job?.attemptsMade, err: err.message }, 'job failed'));
    w.on('error', (err) => log.error({ queue: w.name, err }, 'worker error'));
  }

  /* -------------------------------------------------------- schedules -- */
  if (opts.schedules !== false) {
    for (const m of opts.modules) {
      for (const s of m.schedules ?? []) {
        await queue('jobs').upsertJobScheduler(s.id, s.cron ? { pattern: s.cron } : { every: s.everyMs ?? 60_000 }, { name: s.job, data: { orgId: null, data: {} } });
      }
    }
  }

  /* ---------------------------------------------- outbox wake + poll -- */
  const sub = createRedis();
  await sub.subscribe(OUTBOX_WAKE_CHANNEL);
  sub.on('message', () => void dispatchOutbox().catch((err) => log.error({ err }, 'outbox dispatch failed')));
  const poll = setInterval(() => void dispatchOutbox().catch((err) => log.error({ err }, 'outbox dispatch failed')), opts.outboxPollMs ?? 2000);

  /* -------------------------------------------------------- heartbeat -- */
  const startedAt = new Date().toISOString();
  const beat = () => heartbeat({ startedAt, active, concurrency: conc }).catch((err) => log.warn({ err: (err as Error).message }, 'heartbeat failed'));
  await beat();
  const beating = setInterval(() => void beat(), 15_000);

  /* ----------------------------------------------------------- health -- */
  let server: Server | undefined;
  const port = opts.healthPort === undefined ? env().WORKER_HEALTH_PORT : opts.healthPort;
  if (port) {
    server = createServer(async (req, res) => {
      if (req.url !== '/healthz') {
        res.writeHead(404).end();
        return;
      }
      try {
        const counts = Object.fromEntries(await Promise.all(QUEUE_NAMES.map(async (q) => [q, await queue(q).getJobCounts('active', 'waiting', 'delayed', 'failed')] as const)));
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, running: workers.every((w) => w.isRunning()), queues: counts }));
      } catch (err) {
        res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: (err as Error).message }));
      }
    }).listen(port);
  }

  log.info({ jobs: [...jobs.keys()].length, listeners: listeners.length, concurrency: conc }, 'worker started');

  return {
    workers,
    dispatchOutbox,
    async stop() {
      clearInterval(poll);
      clearInterval(beating);
      await clearHeartbeat();
      await sub.quit().catch(() => undefined);
      await Promise.all(workers.map((w) => w.close()));
      await connection.quit().catch(() => undefined);
      server?.close();
      log.info('worker stopped');
    },
  };
}
