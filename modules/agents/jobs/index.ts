import '../types';
import { and, eq, lt, sql } from 'drizzle-orm';
import { withSystemOrg } from '@labelconsole/core/context';
import { systemDb } from '@labelconsole/core/db/client';
import { defineJob } from '@labelconsole/core/queue';
import { approvals, runs, triggers } from '../schema';
import { executeRun } from '../runtime/runtime';
import { nextCronRun } from '../service/agents';
import { expireApprovals } from '../service/approvals';
import { queueRun, startRun } from '../service/runs';

export const jobs = [
  defineJob('agents.run', (job, data) => executeRun(job, data.runId), 'agents'),

  /**
   * Every minute: fire due cron triggers, re-queue runs whose worker died,
   * re-queue runs whose job went missing, and expire stale approvals.
   */
  defineJob('agents.tick', async (job) => {
    const now = new Date();
    // Cron triggers: claim each due one and move its next run time forward first, so two ticks never double-fire.
    const due = await systemDb().transaction(async (tx) => {
      const rows = (await tx.execute(sql`
        select t.id, t.org_id, t.agent_id, t.config from agent_triggers t
        join agents a on a.id = t.agent_id
        where t.enabled and t.kind = 'cron' and t.next_run_at <= now() and a.status = 'active'
        order by t.next_run_at limit 100 for update of t skip locked`)) as unknown as Array<{ id: string; org_id: string; agent_id: string; config: { cron: string; timezone?: string } }>;
      for (const r of rows) {
        let next: Date | null = null;
        try {
          next = nextCronRun(r.config.cron, r.config.timezone ?? 'UTC', now);
        } catch {
          next = null;
        }
        await tx.update(triggers).set({ nextRunAt: next, lastFiredAt: now, enabled: next !== null }).where(eq(triggers.id, r.id));
      }
      return rows;
    });
    let fired = 0;
    for (const t of due) {
      try {
        await withSystemOrg(t.org_id, (ctx) => startRun(ctx, { agentId: t.agent_id, triggerKind: 'cron', triggerId: t.id, task: null }), 'job:agents.tick');
        fired++;
      } catch (err) {
        job.log.warn({ triggerId: t.id, err: (err as Error).message }, 'cron trigger skipped');
      }
    }

    // Crash recovery: a run marked running whose lease ran out has lost its worker.
    const stalled = await systemDb().select({ id: runs.id, orgId: runs.orgId }).from(runs).where(and(eq(runs.status, 'running'), lt(runs.leaseExpiresAt, new Date(Date.now() - 60_000)))).limit(100);
    // Queued runs that never got picked up (e.g. a lost job) are handed to the queue again.
    const lost = await systemDb().select({ id: runs.id, orgId: runs.orgId }).from(runs).where(and(eq(runs.status, 'queued'), lt(runs.updatedAt, new Date(Date.now() - 10 * 60_000)))).limit(100);
    for (const r of [...stalled, ...lost]) {
      await withSystemOrg(r.orgId, async (ctx) => {
        await ctx.tx.update(runs).set({ updatedAt: new Date() }).where(eq(runs.id, r.id));
        queueRun(ctx, r.id);
      }, 'job:agents.tick');
    }

    // Approvals nobody decided: expire and let their runs carry on without them.
    const expiringOrgs = await systemDb().selectDistinct({ orgId: approvals.orgId }).from(approvals).where(and(eq(approvals.status, 'pending'), lt(approvals.expiresAt, now)));
    for (const { orgId } of expiringOrgs) await withSystemOrg(orgId, (ctx) => expireApprovals(ctx), 'job:agents.tick');

    if (fired || stalled.length || lost.length) job.log.info({ fired, recovered: stalled.length, requeued: lost.length }, 'agents tick');
    return { fired, recovered: stalled.length, requeued: lost.length };
  }),
];

