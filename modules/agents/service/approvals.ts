import '../types';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ServiceContext } from '@labelconsole/core/context';
import { ConflictError, NotFoundError, ValidationError } from '@labelconsole/core/errors';
import { users } from '@labelconsole/core/db/schema';
import { toolByName } from '@labelconsole/core/modules';
import { publish } from '@labelconsole/core/realtime';
import { agents, approvals, runs } from '../schema';
import { queueRun } from './runs';

export const DecisionInput = z.object({
  decision: z.enum(['approve', 'reject']),
  /** Edit-then-approve: the corrected tool input, validated against the tool's schema. */
  editedPayload: z.unknown().optional(),
  reason: z.string().max(2000).optional(),
});

export async function listApprovals(ctx: ServiceContext, q: { status?: string } = {}) {
  ctx.assert('agents:read');
  return ctx.tx
    .select({ approval: approvals, agentName: agents.name, agentType: agents.type, runTask: runs.task, decidedByName: users.name })
    .from(approvals)
    .innerJoin(agents, eq(agents.id, approvals.agentId))
    .innerJoin(runs, eq(runs.id, approvals.runId))
    .leftJoin(users, eq(users.id, approvals.decidedBy))
    .where(q.status ? eq(approvals.status, q.status) : undefined)
    .orderBy(sql`case ${approvals.status} when 'pending' then 0 else 1 end`, desc(approvals.createdAt))
    .limit(300);
}

/**
 * A person approves (optionally after editing the action) or rejects a risky
 * tool call. The run resumes either way: approved calls execute with the
 * approved input; rejected ones come back to the agent as a refusal it must
 * work around.
 */
export async function decide(ctx: ServiceContext, id: string, input: z.input<typeof DecisionInput>) {
  ctx.assert('agents:approve');
  if (ctx.actor.type !== 'user') throw new ConflictError('Only people can decide approvals');
  const data = DecisionInput.parse(input);
  const [a] = await ctx.tx.select().from(approvals).where(eq(approvals.id, id)).for('update');
  if (!a) throw new NotFoundError('Approval');
  if (a.status !== 'pending') throw new ConflictError(`Already ${a.status}`);
  if (a.expiresAt < new Date()) throw new ConflictError('This approval has expired');
  let edited: unknown = null;
  if (data.decision === 'approve' && data.editedPayload !== undefined && JSON.stringify(data.editedPayload) !== JSON.stringify(a.payload)) {
    const tool = toolByName(a.toolName);
    const parsed = tool?.input.safeParse(data.editedPayload);
    if (!parsed?.success) throw new ValidationError('The edited action does not match what the tool accepts', { formErrors: [parsed?.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') ?? 'Unknown tool'] });
    edited = parsed.data;
  }
  const [after] = await ctx.tx
    .update(approvals)
    .set({ status: data.decision === 'approve' ? 'approved' : 'rejected', editedPayload: edited, decidedBy: ctx.actor.id, decidedAt: new Date(), reason: data.reason ?? null })
    .where(eq(approvals.id, id))
    .returning();
  await ctx.audit({ action: `approval.${after.status}`, module: 'agents', targetType: 'approval', targetId: id, targetLabel: `${a.toolName}: ${a.preview.slice(0, 120)}`, after: { edited: Boolean(edited), reason: data.reason ?? null } });
  await ctx.emit('agents.approval.decided', { approvalId: id, runId: a.runId, status: after.status, decidedBy: ctx.actor.id });
  // Wake the run if it is waiting on this decision (row lock shared with the runtime's wait).
  const [run] = await ctx.tx.select().from(runs).where(eq(runs.id, a.runId)).for('update');
  if (run && run.status === 'waiting_approval' && run.desiredState === 'run') {
    await ctx.tx.update(runs).set({ status: 'queued', currentTask: `Approval ${after.status}` }).where(eq(runs.id, run.id));
    queueRun(ctx, run.id);
  }
  ctx.afterCommit(() => publish(ctx.orgId, { type: 'agents.approval.updated', data: { approvalId: id, runId: a.runId, status: after.status }, permission: 'agents:read' }));
  return after;
}

/** Approvals nobody decided in time expire; their runs resume and treat them as refused. Called by the tick. */
export async function expireApprovals(ctx: ServiceContext) {
  const expired = await ctx.tx.update(approvals).set({ status: 'expired', reason: 'Nobody decided in time' }).where(and(eq(approvals.status, 'pending'), lt(approvals.expiresAt, new Date()))).returning();
  for (const a of expired) {
    const [run] = await ctx.tx.select().from(runs).where(eq(runs.id, a.runId)).for('update');
    if (run?.status === 'waiting_approval' && run.desiredState === 'run') {
      await ctx.tx.update(runs).set({ status: 'queued', currentTask: 'Approval expired' }).where(eq(runs.id, run.id));
      queueRun(ctx, run.id);
    }
  }
  return expired.length;
}
