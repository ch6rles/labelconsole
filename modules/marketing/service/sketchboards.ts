import { desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ServiceContext } from '@labelconsole/core/context';
import { ConflictError, NotFoundError } from '@labelconsole/core/errors';
import { campaigns, sketchboards, type SketchItem } from '../schema';

const Item = z.object({
  id: z.string().min(1).max(40),
  type: z.enum(['note', 'ref', 'milestone']),
  x: z.number().min(0).max(10_000),
  y: z.number().min(0).max(10_000),
  w: z.number().min(80).max(1200),
  h: z.number().min(40).max(1200),
  text: z.string().max(4000),
  url: z.url().optional(),
  date: z.iso.date().optional(),
  color: z.enum(['paper', 'blue', 'ink', 'red']).optional(),
});

export const SketchboardInput = z.object({ name: z.string().trim().min(1).max(200), campaignId: z.uuid().nullable().optional() });
export const CanvasInput = z.object({ items: z.array(Item).max(500), version: z.number().int().min(1) });

export async function listSketchboards(ctx: ServiceContext) {
  ctx.assert('marketing:read');
  return ctx.tx
    .select({ id: sketchboards.id, name: sketchboards.name, campaignId: sketchboards.campaignId, campaignName: campaigns.name, updatedAt: sketchboards.updatedAt, items: sql<number>`jsonb_array_length(${sketchboards.canvas} -> 'items')` })
    .from(sketchboards)
    .leftJoin(campaigns, eq(campaigns.id, sketchboards.campaignId))
    .orderBy(desc(sketchboards.updatedAt));
}

export async function createSketchboard(ctx: ServiceContext, input: z.input<typeof SketchboardInput>) {
  ctx.assert('marketing:write');
  const data = SketchboardInput.parse(input);
  const starter: SketchItem[] = [
    { id: 'n1', type: 'note', x: 40, y: 40, w: 240, h: 120, text: 'The idea in one line', color: 'paper' },
    { id: 'm1', type: 'milestone', x: 320, y: 40, w: 200, h: 90, text: 'Release day', date: new Date().toISOString().slice(0, 10), color: 'ink' },
  ];
  const [row] = await ctx.tx.insert(sketchboards).values({ name: data.name, campaignId: data.campaignId ?? null, canvas: { items: starter } }).returning();
  await ctx.audit({ action: 'sketchboard.created', module: 'marketing', targetType: 'sketchboard', targetId: row.id, targetLabel: row.name });
  return row;
}

export async function getSketchboard(ctx: ServiceContext, id: string) {
  ctx.assert('marketing:read');
  const [row] = await ctx.tx.select({ board: sketchboards, campaignName: campaigns.name }).from(sketchboards).leftJoin(campaigns, eq(campaigns.id, sketchboards.campaignId)).where(eq(sketchboards.id, id));
  if (!row) throw new NotFoundError('Sketchboard');
  return row;
}

/** Save the canvas. Saves carry the version they started from, so two people editing never overwrite each other silently. */
export async function saveCanvas(ctx: ServiceContext, id: string, input: z.input<typeof CanvasInput>) {
  ctx.assert('marketing:write');
  const data = CanvasInput.parse(input);
  const [row] = await ctx.tx
    .update(sketchboards)
    .set({ canvas: { items: data.items }, version: sql`${sketchboards.version} + 1` })
    .where(sql`${sketchboards.id} = ${id} and ${sketchboards.version} = ${data.version}`)
    .returning({ id: sketchboards.id, version: sketchboards.version, updatedAt: sketchboards.updatedAt });
  if (row) return row;
  const [exists] = await ctx.tx.select({ version: sketchboards.version }).from(sketchboards).where(eq(sketchboards.id, id));
  if (!exists) throw new NotFoundError('Sketchboard');
  throw new ConflictError('Someone else changed this board. Reload to see their changes.', { version: exists.version });
}

export async function renameSketchboard(ctx: ServiceContext, id: string, input: Partial<z.input<typeof SketchboardInput>>) {
  ctx.assert('marketing:write');
  const data = SketchboardInput.partial().parse(input);
  const [row] = await ctx.tx.update(sketchboards).set(data).where(eq(sketchboards.id, id)).returning();
  if (!row) throw new NotFoundError('Sketchboard');
  return row;
}

export async function deleteSketchboard(ctx: ServiceContext, id: string) {
  ctx.assert('marketing:delete');
  const [row] = await ctx.tx.delete(sketchboards).where(eq(sketchboards.id, id)).returning();
  if (row) await ctx.audit({ action: 'sketchboard.deleted', module: 'marketing', targetType: 'sketchboard', targetId: id, targetLabel: row.name });
}
