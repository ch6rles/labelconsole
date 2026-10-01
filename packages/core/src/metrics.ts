import { hostname } from 'node:os';
import { sql } from 'drizzle-orm';
import { systemDb } from './db/client';
import { queue, queuePrefix, QUEUE_NAMES } from './queue';
import { redis } from './redis';

/**
 * Operational metrics in Prometheus text format. Everything here is an
 * aggregate across labels (counts, ages, durations); no tenant data leaves
 * through it. Job counters live in Redis so every worker process adds to the
 * same totals and one scrape of the web app sees them all.
 */
export type Metric = {
  name: string;
  help: string;
  type: 'gauge' | 'counter';
  samples: Array<{ labels?: Record<string, string>; value: number }>;
};

const jobsKey = () => `${queuePrefix()}:metrics:jobs`;
const heartbeatKey = (id: string) => `${queuePrefix()}:worker:${id}`;
export const WORKER_ID = `${hostname()}:${process.pid}`;

/** Count a finished job and add its duration. Never throws: metrics must not fail a job. */
export async function recordJob(queueName: string, job: string, result: 'completed' | 'failed' | 'delayed', ms: number) {
  try {
    await redis()
      .multi()
      .hincrby(jobsKey(), `${queueName}\t${job}\t${result}`, 1)
      .hincrbyfloat(jobsKey(), `${queueName}\t${job}\tseconds`, ms / 1000)
      .exec();
  } catch {
    /* metrics are best effort */
  }
}

export type Heartbeat = { id: string; startedAt: string; at: string; active: number; concurrency: Record<string, number> };

/** Written every few seconds by each worker process; expires if the process dies. */
export async function heartbeat(beat: Omit<Heartbeat, 'id' | 'at'>, ttlSec = 45) {
  const value: Heartbeat = { id: WORKER_ID, at: new Date().toISOString(), ...beat };
  await redis().set(heartbeatKey(WORKER_ID), JSON.stringify(value), 'EX', ttlSec);
}

export async function clearHeartbeat() {
  await redis().del(heartbeatKey(WORKER_ID)).catch(() => undefined);
}

export async function workerHeartbeats(): Promise<Heartbeat[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis().scan(cursor, 'MATCH', heartbeatKey('*'), 'COUNT', 200);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0');
  if (!keys.length) return [];
  const values = await redis().mget(...keys);
  return values.filter((v): v is string => Boolean(v)).map((v) => JSON.parse(v) as Heartbeat);
}

/** Events written but not yet handed to listeners, and how long the oldest has waited. */
export async function outboxLag() {
  const [row] = (await systemDb().execute(
    sql`select count(*)::int as pending, coalesce(extract(epoch from now() - min(created_at)), 0)::float as oldest from domain_events where dispatched_at is null`,
  )) as unknown as Array<{ pending: number; oldest: number }>;
  return { pending: Number(row?.pending ?? 0), oldestSeconds: Number(row?.oldest ?? 0) };
}

/** Platform-level metrics: queues, workers, outbox, job counters, tenants, this process. */
export async function coreMetrics(): Promise<Metric[]> {
  const [counts, beats, lag, jobTotals, [tenants]] = await Promise.all([
    Promise.all(QUEUE_NAMES.map(async (q) => [q, await queue(q).getJobCounts('waiting', 'active', 'delayed', 'failed', 'prioritized', 'waiting-children')] as const)),
    workerHeartbeats(),
    outboxLag(),
    redis().hgetall(jobsKey()),
    systemDb().execute(sql`select (select count(*)::int from organizations) as orgs, (select count(*)::int from users) as users`) as unknown as Promise<Array<{ orgs: number; users: number }>>,
  ]);

  const jobCounter: Metric = { name: 'lc_jobs_total', help: 'Jobs finished by the workers, by queue, job and result.', type: 'counter', samples: [] };
  const jobSeconds: Metric = { name: 'lc_job_seconds_total', help: 'Total seconds spent running jobs, by queue and job.', type: 'counter', samples: [] };
  for (const [field, raw] of Object.entries(jobTotals)) {
    const [q, job, kind] = field.split('\t');
    if (kind === 'seconds') jobSeconds.samples.push({ labels: { queue: q, job }, value: Number(raw) });
    else jobCounter.samples.push({ labels: { queue: q, job, result: kind }, value: Number(raw) });
  }
  const mem = process.memoryUsage();

  return [
    { name: 'lc_queue_jobs', help: 'Jobs in each BullMQ queue by state.', type: 'gauge', samples: counts.flatMap(([q, c]) => Object.entries(c).map(([state, value]) => ({ labels: { queue: q, state }, value }))) },
    { name: 'lc_workers', help: 'Worker processes with a live heartbeat.', type: 'gauge', samples: [{ value: beats.length }] },
    { name: 'lc_worker_active_jobs', help: 'Jobs each worker process is running right now.', type: 'gauge', samples: beats.map((b) => ({ labels: { worker: b.id }, value: b.active })) },
    { name: 'lc_outbox_pending', help: 'Domain events not yet dispatched to listeners.', type: 'gauge', samples: [{ value: lag.pending }] },
    { name: 'lc_outbox_oldest_seconds', help: 'Age of the oldest undispatched domain event.', type: 'gauge', samples: [{ value: lag.oldestSeconds }] },
    jobCounter,
    jobSeconds,
    { name: 'lc_labels', help: 'Labels (organizations) on the platform.', type: 'gauge', samples: [{ value: Number(tenants?.orgs ?? 0) }] },
    { name: 'lc_users', help: 'User accounts on the platform.', type: 'gauge', samples: [{ value: Number(tenants?.users ?? 0) }] },
    { name: 'lc_web_process_resident_bytes', help: 'Resident memory of the web process serving this scrape.', type: 'gauge', samples: [{ value: mem.rss }] },
    { name: 'lc_web_process_uptime_seconds', help: 'Uptime of the web process serving this scrape.', type: 'gauge', samples: [{ value: Math.round(process.uptime()) }] },
  ];
}

const escapeLabel = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

/** Prometheus text exposition format, version 0.0.4. */
export function renderPrometheus(metrics: Metric[]): string {
  const out: string[] = [];
  for (const m of metrics) {
    out.push(`# HELP ${m.name} ${m.help}`, `# TYPE ${m.name} ${m.type}`);
    for (const s of m.samples) {
      const labels = s.labels && Object.keys(s.labels).length ? `{${Object.entries(s.labels).map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',')}}` : '';
      out.push(`${m.name}${labels} ${Number.isFinite(s.value) ? s.value : 0}`);
    }
  }
  return out.join('\n') + '\n';
}
