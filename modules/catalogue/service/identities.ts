import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { ServiceContext } from '@labelconsole/core/context';
import { NotFoundError } from '@labelconsole/core/errors';
import { platformIdentities, tracks } from '../schema';

export const IdentityInput = z.object({
  entityType: z.enum(['track', 'release']),
  entityId: z.uuid(),
  platform: z.string().min(2).max(30),
  externalId: z.string().trim().min(1).max(200),
  url: z.url().nullable().optional(),
  confidence: z.number().min(0).max(1).default(1),
  source: z.string().max(60).default('manual'),
  status: z.enum(['confirmed', 'pending_review', 'rejected']).default('confirmed'),
  variant: z.string().max(30).nullable().optional(),
});

/** Insert or refresh a platform identity (used by imports, the stream resolver and staff). */
export async function upsertIdentity(ctx: ServiceContext, input: z.input<typeof IdentityInput>) {
  const data = IdentityInput.parse(input);
  const [row] = await ctx.tx
    .insert(platformIdentities)
    .values({ ...data, confidence: String(data.confidence), url: data.url ?? null })
    .onConflictDoUpdate({
      target: [platformIdentities.orgId, platformIdentities.entityType, platformIdentities.entityId, platformIdentities.platform, platformIdentities.externalId],
      // Never downgrade a human decision.
      set: { url: data.url ?? null, variant: data.variant ?? null },
    })
    .returning();
  return row;
}

export async function identitiesFor(ctx: ServiceContext, entityType: 'track' | 'release', entityIds: string[], platform?: string) {
  if (entityIds.length === 0) return [];
  const conds = [eq(platformIdentities.entityType, entityType), inArray(platformIdentities.entityId, entityIds)];
  if (platform) conds.push(eq(platformIdentities.platform, platform));
  return ctx.tx.select().from(platformIdentities).where(and(...conds));
}

export async function reviewQueue(ctx: ServiceContext, platform?: string) {
  ctx.assert('catalogue:read');
  const conds = [eq(platformIdentities.status, 'pending_review')];
  if (platform) conds.push(eq(platformIdentities.platform, platform));
  const rows = await ctx.tx.select({ identity: platformIdentities, trackTitle: tracks.title, isrc: tracks.isrc }).from(platformIdentities).leftJoin(tracks, eq(tracks.id, platformIdentities.entityId)).where(and(...conds)).orderBy(desc(platformIdentities.createdAt)).limit(300);
  return rows;
}

export async function reviewIdentity(ctx: ServiceContext, id: string, status: 'confirmed' | 'rejected') {
  ctx.assert('catalogue:write');
  const reviewer = ctx.actor.type === 'system' ? 'system' : `${ctx.actor.type}:${ctx.actor.id}`;
  const [row] = await ctx.tx.update(platformIdentities).set({ status, reviewedBy: reviewer, confidence: status === 'confirmed' ? '1' : undefined }).where(eq(platformIdentities.id, id)).returning();
  if (!row) throw new NotFoundError('Platform match');
  await ctx.audit({ action: status === 'confirmed' ? 'identity.confirmed' : 'identity.rejected', module: 'catalogue', targetType: row.entityType, targetId: row.entityId, targetLabel: `${row.platform} ${row.externalId}` });
  return row;
}
