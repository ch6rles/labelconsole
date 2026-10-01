import { eq, sql } from 'drizzle-orm';
import type { ServiceContext } from './context';
import { organizations } from './db/schema';
import { AppError } from './errors';
import { PLAN_LABELS, type PlanTier } from './modules';

/**
 * What each plan includes beyond its modules. These numbers are placeholders
 * until pricing is decided (see docs/progress.md, open questions): generous,
 * kept in this one place, and only checked at the moment something is added,
 * so a label is never locked out of what it already has.
 */
export type PlanLimits = { seats: number; trackedTracks: number; storageBytes: number };

const GB = 1024 ** 3;
export const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
  starter: { seats: 3, trackedTracks: 200, storageBytes: 20 * GB },
  growth: { seats: 15, trackedTracks: 2_000, storageBytes: 200 * GB },
  scale: { seats: 100, trackedTracks: 20_000, storageBytes: 2_000 * GB },
};

const LIMIT_LABEL: Record<keyof PlanLimits, string> = { seats: 'team members', trackedTracks: 'tracked tracks', storageBytes: 'file storage' };

/** 402: the action is fine, the plan doesn't include more of it. */
export class PlanLimitError extends AppError {
  constructor(what: keyof PlanLimits, limit: number, plan: PlanTier) {
    const amount = what === 'storageBytes' ? `${Math.round(limit / GB)} GB` : String(limit);
    super(402, 'plan_limit', `The ${PLAN_LABELS[plan]} plan includes ${amount} of ${LIMIT_LABEL[what]}. Upgrade the plan or free some up.`, { what, limit, plan });
  }
}

export function limitsFor(plan: string): PlanLimits {
  return PLAN_LIMITS[plan as PlanTier] ?? PLAN_LIMITS.starter;
}

export async function planOf(ctx: ServiceContext): Promise<{ plan: PlanTier; limits: PlanLimits }> {
  const [org] = await ctx.tx.select({ plan: organizations.plan }).from(organizations).where(eq(organizations.id, ctx.orgId));
  const plan = (org?.plan ?? 'starter') as PlanTier;
  return { plan, limits: limitsFor(plan) };
}

/**
 * Serialize check-then-add for one limit within a label until this transaction
 * ends, so two concurrent adds can't both see room for one more.
 */
export async function lockPlanLimit(ctx: ServiceContext, what: keyof PlanLimits) {
  await ctx.tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`plan:${what}:${ctx.orgId}`}))`);
}

/** Throw if adding `adding` more would take `current` past the plan's limit. */
export async function assertWithinPlan(ctx: ServiceContext, what: keyof PlanLimits, current: number, adding = 1) {
  const { plan, limits } = await planOf(ctx);
  if (current + adding > limits[what]) throw new PlanLimitError(what, limits[what], plan);
}
