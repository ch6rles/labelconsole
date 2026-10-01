import { randomBytes } from 'node:crypto';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ServiceContext } from '@labelconsole/core/context';
import { organizations } from '@labelconsole/core/db/schema';
import { NotFoundError } from '@labelconsole/core/errors';
import { DEMO_STAGES, demos, type DemoScore } from '../schema';

export const DemoInput = z.object({
  title: z.string().trim().min(1).max(200),
  artistName: z.string().trim().min(1).max(200),
  submitterName: z.string().trim().max(200).nullable().optional(),
  submitterEmail: z.email().nullable().optional(),
  links: z.array(z.url()).max(10).default([]),
  genre: z.string().trim().max(80).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  audioFileId: z.uuid().nullable().optional(),
});

export const ScoreInput = z.object({
  fit: z.number().min(0).max(10),
  production: z.number().min(0).max(10),
  potential: z.number().min(0).max(10),
  rationale: z.string().trim().min(1).max(4000),
});

export async function listDemos(ctx: ServiceContext, q: { stage?: string } = {}) {
  ctx.assert('catalogue:read');
  return ctx.tx
    .select()
    .from(demos)
    .where(q.stage ? eq(demos.stage, q.stage as (typeof DEMO_STAGES)[number]) : undefined)
    .orderBy(sql`case ${demos.stage} when 'new' then 0 when 'reviewing' then 1 when 'shortlisted' then 2 else 3 end`, desc(demos.createdAt))
    .limit(500);
}

export async function getDemo(ctx: ServiceContext, id: string) {
  ctx.assert('catalogue:read');
  const [d] = await ctx.tx.select().from(demos).where(eq(demos.id, id));
  if (!d) throw new NotFoundError('Demo');
  return d;
}

export async function createDemo(ctx: ServiceContext, input: z.input<typeof DemoInput>, source: 'manual' | 'intake' | 'agent' = 'manual') {
  if (source !== 'intake') ctx.assert('catalogue:write');
  const data = DemoInput.parse(input);
  const [row] = await ctx.tx.insert(demos).values({ ...data, source }).returning();
  await ctx.audit({ action: 'demo.submitted', module: 'catalogue', targetType: 'demo', targetId: row.id, targetLabel: `${row.title} · ${row.artistName}`, after: { source } });
  await ctx.emit('catalogue.demo.submitted', { demoId: row.id, title: row.title, artistName: row.artistName, source });
  return row;
}

export async function setDemoStage(ctx: ServiceContext, id: string, stage: (typeof DEMO_STAGES)[number]) {
  ctx.assert('catalogue:write');
  const before = await getDemo(ctx, id);
  const reviewer = ctx.actor.type === 'system' ? 'system' : `${ctx.actor.type}:${ctx.actor.id}`;
  const [after] = await ctx.tx.update(demos).set({ stage, reviewedBy: reviewer, reviewedAt: new Date() }).where(eq(demos.id, id)).returning();
  await ctx.audit({ action: 'demo.stage_changed', module: 'catalogue', targetType: 'demo', targetId: id, targetLabel: `${after.title} · ${after.artistName}`, before: { stage: before.stage }, after: { stage } });
  return after;
}

export async function scoreDemo(ctx: ServiceContext, id: string, input: z.infer<typeof ScoreInput>) {
  ctx.assert('catalogue:write');
  const before = await getDemo(ctx, id);
  const overall = Math.round(((input.fit * 0.4 + input.production * 0.25 + input.potential * 0.35) * 10)) / 10;
  const scoredBy = ctx.actor.type === 'agent' ? `Agent · ${ctx.actor.name}` : ctx.actor.name;
  const detail: DemoScore = { overall, ...input, scoredBy, scoredAt: new Date().toISOString() };
  const [after] = await ctx.tx
    .update(demos)
    .set({ score: String(overall), scoreDetail: detail, stage: before.stage === 'new' ? 'reviewing' : before.stage })
    .where(eq(demos.id, id))
    .returning();
  await ctx.audit({ action: 'demo.scored', module: 'catalogue', targetType: 'demo', targetId: id, targetLabel: `${after.title} · ${after.artistName}`, before: { score: before.score }, after: { score: after.score } });
  await ctx.emit('catalogue.demo.scored', { demoId: id, title: after.title, score: overall });
  return after;
}

export async function deleteDemo(ctx: ServiceContext, id: string) {
  ctx.assert('catalogue:delete');
  const d = await getDemo(ctx, id);
  await ctx.tx.delete(demos).where(eq(demos.id, id));
  await ctx.audit({ action: 'demo.deleted', module: 'catalogue', targetType: 'demo', targetId: id, targetLabel: d.title });
}

export async function demoCounts(ctx: ServiceContext) {
  const [unreviewed] = await ctx.tx.select({ n: sql<number>`count(*)::int`, oldest: sql<Date | null>`min(${demos.createdAt})` }).from(demos).where(and(eq(demos.stage, 'new'), isNull(demos.reviewedAt)));
  const [newest] = await ctx.tx.select().from(demos).where(eq(demos.stage, 'new')).orderBy(desc(demos.createdAt)).limit(1);
  return { unreviewed: unreviewed.n, oldest: unreviewed.oldest, newest: newest ?? null };
}

/** Per-label secret for the public demo submission link. */
export async function intakeToken(ctx: ServiceContext) {
  const [org] = await ctx.tx.select().from(organizations).where(eq(organizations.id, ctx.orgId));
  const settings = org.settings as Record<string, unknown>;
  if (typeof settings.intakeToken === 'string') return settings.intakeToken;
  ctx.assert('catalogue:write');
  const token = randomBytes(12).toString('base64url');
  await ctx.tx.update(organizations).set({ settings: { ...settings, intakeToken: token } as never }).where(eq(organizations.id, ctx.orgId));
  return token;
}

export const oldestFirst = asc(demos.createdAt);
