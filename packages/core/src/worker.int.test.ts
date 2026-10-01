import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../test/helpers';
import { withSystemOrg } from './context';
import { closeDb, systemDb } from './db/client';
import { auditLog, domainEvents } from './db/schema';
import { defineListener, defineModule, registerModules } from './modules';
import { closeQueues, defineJob, enqueue } from './queue';
import { closeRedis } from './redis';
import { startWorker, type WorkerRuntime } from './worker';

declare module './queue' {
  interface JobMap {
    'test.write-audit': { marker: string };
  }
}
declare module './events' {
  interface DomainEventMap {
    'test.thing.happened': { marker: string };
  }
}

const testModule = defineModule({
  manifest: { id: 'testmod', name: 'Test', description: '', icon: 'science', plans: ['starter', 'growth', 'scale'], core: true, permissions: [], nav: [], events: { emits: [], listens: [] }, tools: [] },
  jobs: [
    defineJob('test.write-audit', async (ctx, data) => {
      await ctx.withOrg((s) => s.audit({ action: 'test.job_ran', module: 'test', targetId: data.marker }));
    }),
  ],
  listeners: [
    defineListener({
      id: 'testmod.on-thing',
      event: 'test.thing.happened',
      handle: async (ctx, event) => ctx.audit({ action: 'test.listener_ran', module: 'test', targetId: event.payload.marker }),
    }),
  ],
});

let runtime: WorkerRuntime;

beforeAll(async () => {
  registerModules([testModule]);
  runtime = await startWorker({ modules: [testModule], schedules: false, healthPort: null, outboxPollMs: 200 });
});

afterAll(async () => {
  await runtime.stop();
  await closeQueues();
  await closeDb();
  await closeRedis();
});

async function waitFor<T>(fn: () => Promise<T | undefined | null>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('worker service', () => {
  it('runs a queued job in the worker, scoped to the org', async () => {
    const a = await makeOrg();
    const marker = crypto.randomUUID();
    await enqueue('test.write-audit', a.org.id, { marker });
    const row = await waitFor(async () => (await systemDb().select().from(auditLog).where(eq(auditLog.targetId, marker)))[0]);
    expect(row.orgId).toBe(a.org.id);
    expect(row.actorType).toBe('system');
  });

  it('delivers committed domain events from the outbox to listeners', async () => {
    const a = await makeOrg();
    const marker = crypto.randomUUID();
    await withSystemOrg(a.org.id, (ctx) => ctx.emit('test.thing.happened', { marker }));
    const row = await waitFor(async () => (await systemDb().select().from(auditLog).where(eq(auditLog.targetId, marker)))[0]);
    expect(row.action).toBe('test.listener_ran');
    expect(row.orgId).toBe(a.org.id);
    const [evt] = await systemDb().select().from(domainEvents).where(eq(domainEvents.type, 'test.thing.happened'));
    expect(evt.dispatchedAt).not.toBeNull();
  });

  it('does not deliver events from a rolled-back transaction', async () => {
    const a = await makeOrg();
    const marker = crypto.randomUUID();
    await withSystemOrg(a.org.id, async (ctx) => {
      await ctx.emit('test.thing.happened', { marker });
      throw new Error('rollback');
    }).catch(() => undefined);
    await runtime.dispatchOutbox();
    await new Promise((r) => setTimeout(r, 500));
    expect(await systemDb().select().from(auditLog).where(eq(auditLog.targetId, marker))).toHaveLength(0);
  });
});
