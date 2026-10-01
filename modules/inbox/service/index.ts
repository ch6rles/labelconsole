import '../types';
import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ServiceContext } from '@labelconsole/core/context';
import { actorString } from '@labelconsole/core/context';
import { auditLog, customRoles, memberships } from '@labelconsole/core/db/schema';
import { PermissionSet } from '@labelconsole/core/permissions';
import { publish } from '@labelconsole/core/realtime';
import { notifications, type NotificationKind } from '../schema';

export type NotifyInput = {
  /** Explicit recipients, or everyone holding `permission`. */
  userIds?: string[];
  permission?: string;
  kind: NotificationKind;
  title: string;
  body?: string | null;
  href?: string | null;
  entityType?: string;
  entityId?: string;
  /** Same key for the same user is never inserted twice (retried event delivery). */
  dedupeKey?: string;
};

/** Active members whose role grants a permission. */
export async function membersWithPermission(ctx: ServiceContext, permission: string): Promise<string[]> {
  const rows = await ctx.tx.select().from(memberships).where(eq(memberships.status, 'active'));
  const custom = await ctx.tx.select().from(customRoles);
  return rows
    .filter((m) => PermissionSet.forRole(m.role, m.extraPermissions, custom.find((c) => c.id === m.customRoleId)?.permissions).has(permission))
    .map((m) => m.userId);
}

export async function notify(ctx: ServiceContext, input: NotifyInput) {
  const recipients = new Set(input.userIds ?? []);
  if (input.permission) for (const id of await membersWithPermission(ctx, input.permission)) recipients.add(id);
  if (recipients.size === 0) return [];
  let users = [...recipients];
  if (input.dedupeKey) {
    const existing = await ctx.tx
      .select({ userId: notifications.userId })
      .from(notifications)
      .where(and(eq(notifications.dedupeKey, input.dedupeKey), inArray(notifications.userId, users)));
    const seen = new Set(existing.map((e) => e.userId));
    users = users.filter((u) => !seen.has(u));
  }
  if (users.length === 0) return [];
  const rows = await ctx.tx
    .insert(notifications)
    .values(
      users.map((userId) => ({
        userId,
        kind: input.kind,
        title: input.title,
        body: input.body ?? null,
        href: input.href ?? null,
        entityType: input.entityType,
        entityId: input.entityId,
        actor: actorString(ctx.actor),
        actorLabel: ctx.actor.name,
        dedupeKey: input.dedupeKey,
      })),
    )
    .returning();
  const orgId = ctx.orgId;
  ctx.afterCommit(async () => {
    for (const r of rows) await publish(orgId, { type: 'inbox.notification', userId: r.userId, data: { id: r.id, kind: r.kind, title: r.title, body: r.body, href: r.href, readAt: null, createdAt: r.createdAt.toISOString() } });
  });
  return rows;
}

export const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  unread: z.enum(['1', '0']).optional(),
  kind: z.string().optional(),
  before: z.iso.datetime().optional(),
});

export async function listNotifications(ctx: ServiceContext, userId: string, q: z.infer<typeof ListQuery>) {
  const conds = [eq(notifications.userId, userId)];
  if (q.unread === '1') conds.push(isNull(notifications.readAt));
  if (q.kind) conds.push(eq(notifications.kind, q.kind as NotificationKind));
  if (q.before) conds.push(lt(notifications.createdAt, new Date(q.before)));
  const items = await ctx.tx.select().from(notifications).where(and(...conds)).orderBy(desc(notifications.createdAt)).limit(q.limit);
  return { items, unread: await unreadCount(ctx, userId) };
}

export async function unreadCount(ctx: ServiceContext, userId: string) {
  const [r] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(notifications).where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  return r.n;
}

export async function markRead(ctx: ServiceContext, userId: string, ids?: string[]) {
  const conds = [eq(notifications.userId, userId), isNull(notifications.readAt)];
  if (ids?.length) conds.push(inArray(notifications.id, ids));
  const rows = await ctx.tx.update(notifications).set({ readAt: new Date() }).where(and(...conds)).returning({ id: notifications.id });
  return { updated: rows.length };
}

/**
 * Activity feed: the audit log, limited to areas the reader can see. Settings
 * changes need the audit permission; everything else needs the module's read.
 */
/**
 * The activity feed: audit entries from modules the reader can read. Settings
 * entries (invites, roles, credentials) need settings:audit, and entries marked
 * with a read permission (confidential documents, statements) need that too.
 */
export async function activity(ctx: ServiceContext, q: { limit?: number; before?: string }) {
  const readable = [...ctx.permissions.keys].filter((k) => k.endsWith(':read') && !k.startsWith('settings:')).map((k) => k.split(':')[0]);
  if (ctx.can('settings:audit')) readable.push('settings');
  if (readable.length === 0) return [];
  const held = [...ctx.permissions.keys];
  const conds = [inArray(auditLog.module, readable), or(isNull(auditLog.readPermission), held.length ? inArray(auditLog.readPermission, held) : sql`false`)!];
  if (q.before) conds.push(lt(auditLog.createdAt, new Date(q.before)));
  return ctx.tx
    .select({ id: auditLog.id, actorType: auditLog.actorType, actorLabel: auditLog.actorLabel, action: auditLog.action, module: auditLog.module, targetType: auditLog.targetType, targetId: auditLog.targetId, targetLabel: auditLog.targetLabel, agentRunId: auditLog.agentRunId, createdAt: auditLog.createdAt })
    .from(auditLog)
    .where(and(...conds))
    .orderBy(desc(auditLog.createdAt))
    .limit(q.limit ?? 100);
}
