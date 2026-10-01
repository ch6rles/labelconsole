import '../types';
import { and, eq, lt, sql } from 'drizzle-orm';
import { withSystemOrg } from '@labelconsole/core/context';
import { systemDb } from '@labelconsole/core/db/client';
import { embeddingModel, embeddingProviderFor } from '@labelconsole/core/embeddings';
import { env } from '@labelconsole/core/env';
import { defineJob, enqueue } from '@labelconsole/core/queue';
import { approvals, runs, triggers } from '../schema';
import { executeRun } from '../runtime/runtime';
import { nextCronRun } from '../service/agents';
import { expireApprovals } from '../service/approvals';
import { pendingEmbeddings, saveEmbeddings } from '../service/memory';
import { queueRun, startRun } from '../service/runs';

export const jobs = [
  defineJob('agents.run', (job, data) => executeRun(job, data.runId), 'agents'),

  /**
   * Embed agent memories for semantic recall. Without an org: find labels that
   * have memories to embed and an embedding key, and fan out. With an org: embed
   * a batch (the HTTP call happens outside any transaction) and continue if more wait.
   */
  defineJob('agents.embed-memories', async (job) => {
    const bucket = Math.floor(Date.now() / 30_000);
    if (!job.orgId) {
      const rows = (await systemDb().execute(sql`
        select distinct m.org_id from agent_memories m
        where (m.embedding is null or m.embedding_model is distinct from ${embeddingModel()})
          and (m.expires_at is null or m.expires_at > now())
          and (${Boolean(env().VOYAGE_API_KEY)} or exists (select 1 from credentials c where c.org_id = m.org_id and c.provider = 'voyage' and c.revoked_at is null))
        limit 500`)) as unknown as Array<{ org_id: string }>;
      for (const r of rows) await enqueue('agents.embed-memories', r.org_id, {}, { jobId: `embed-${r.org_id}-${bucket}`, attempts: 3 });
      return { labels: rows.length };
    }
    const provider = await job.withOrg((ctx) => embeddingProviderFor(ctx));
    if (!provider) return { skipped: 'no embedding key' };
    const rows = await job.withOrg((ctx) => pendingEmbeddings(ctx, provider.model));
    if (rows.length === 0) return { embedded: 0 };
    const { vectors, tokens } = await provider.embed(rows.map((r) => r.content), 'document');
    await job.withOrg((ctx) => saveEmbeddings(ctx, provider.model, rows.map((r, i) => ({ ...r, vector: vectors[i] })), tokens));
    // A full batch means more may be waiting.
    if (rows.length === 128) await enqueue('agents.embed-memories', job.orgId, {}, { jobId: `embed-${job.orgId}-more-${Date.now()}`, attempts: 3 });
    return { embedded: rows.length, model: provider.model };
  }),

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

