import { afterAll, describe, expect, it } from 'vitest';
import { closeDb } from './db/client';
import { clearHeartbeat, coreMetrics, heartbeat, recordJob, renderPrometheus, workerHeartbeats, WORKER_ID } from './metrics';
import { closeQueues } from './queue';
import { closeRedis } from './redis';

afterAll(async () => {
  await closeQueues();
  await closeDb();
  await closeRedis();
});

describe('metrics', () => {
  it('renders Prometheus text with escaped labels', () => {
    const text = renderPrometheus([{ name: 'lc_x', help: 'An example.', type: 'gauge', samples: [{ value: 3 }, { labels: { job: 'a"b\\c\nd' }, value: Number.NaN }] }]);
    expect(text).toBe('# HELP lc_x An example.\n# TYPE lc_x gauge\nlc_x 3\nlc_x{job="a\\"b\\\\c\\nd"} 0\n');
  });

  it('counts jobs and reports live worker heartbeats', async () => {
    const job = `test-job-${Date.now()}`;
    await recordJob('jobs', job, 'completed', 1500);
    await recordJob('jobs', job, 'failed', 500);
    await heartbeat({ startedAt: new Date().toISOString(), active: 2, concurrency: { jobs: 8 } });

    const metrics = await coreMetrics();
    const sample = (name: string, labels: Record<string, string>) => metrics.find((m) => m.name === name)!.samples.find((s) => Object.entries(labels).every(([k, v]) => s.labels?.[k] === v))?.value;
    expect(sample('lc_jobs_total', { job, result: 'completed' })).toBe(1);
    expect(sample('lc_jobs_total', { job, result: 'failed' })).toBe(1);
    expect(sample('lc_job_seconds_total', { job })).toBeCloseTo(2);
    expect(sample('lc_worker_active_jobs', { worker: WORKER_ID })).toBe(2);
    expect(metrics.find((m) => m.name === 'lc_queue_jobs')!.samples.length).toBeGreaterThan(0);

    await clearHeartbeat();
    expect((await workerHeartbeats()).some((b) => b.id === WORKER_ID)).toBe(false);
  });
});
