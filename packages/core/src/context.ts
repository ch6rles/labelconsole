import { sql } from 'drizzle-orm';
import { appDb, type Tx } from './db/client';
import { auditLog, domainEvents } from './db/schema';
import { ForbiddenError } from './errors';
import { OUTBOX_WAKE_CHANNEL, type EventPayload, type EventType } from './events';
import { logger } from './logger';
import { PermissionSet } from './permissions';
import { redis } from './redis';

export type Actor =
  | { type: 'user'; id: string; name: string }
  | { type: 'agent'; id: string; name: string; runId: string; stepId?: string; ownerUserId: string | null }
  | { type: 'system'; id?: undefined; name: string };

export function actorString(a: Actor): string {
  return a.type === 'system' ? 'system' : `${a.type}:${a.id}`;
}

export type AuditEntry = {
  action: string;
  module: string;
  targetType?: string;
  targetId?: string;
  targetLabel?: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
};

export interface ServiceContext {
  readonly orgId: string;
  readonly actor: Actor;
  readonly permissions: PermissionSet;
  /** Artist ids the actor is restricted to, or null for the whole roster. */
  readonly artistScope: readonly string[] | null;
  readonly tx: Tx;
  readonly ip?: string;
  can(permission: string): boolean;
  /** Throws ForbiddenError unless the actor holds the permission. */
  assert(permission: string): void;
  /** Append a domain event to the outbox in this transaction. */
  emit<K extends EventType>(type: K, payload: EventPayload<K>): Promise<void>;
  /** Record who changed what, with a before/after diff. */
  audit(entry: AuditEntry): Promise<void>;
  /** Run after the transaction commits (enqueue jobs, publish realtime). */
  afterCommit(fn: () => unknown | Promise<unknown>): void;
}

export type OrgContextInput = {
  orgId: string;
  actor: Actor;
  permissions: PermissionSet;
  artistScope?: readonly string[] | null;
  ip?: string;
};

const SENSITIVE_KEYS = /password|secret|token|ciphertext|apikey|api_key/i;

function scrub(obj: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!obj) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = SENSITIVE_KEYS.test(k) ? '[redacted]' : v instanceof Date ? v.toISOString() : v;
  }
  return out;
}

/** Keep only the fields that changed so the audit log reads as a diff. */
export function diff(before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
  if (!before || !after) return { before: scrub(before), after: scrub(after) };
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  const sb = scrub(before)!;
  const sa = scrub(after)!;
  for (const key of new Set([...Object.keys(sb), ...Object.keys(sa)])) {
    if (key === 'updatedAt') continue;
    if (JSON.stringify(sb[key]) !== JSON.stringify(sa[key])) {
      b[key] = sb[key];
      a[key] = sa[key];
    }
  }
  return { before: b, after: a };
}

/**
 * Run `fn` in a transaction scoped to one org. Sets the Postgres settings the
 * RLS policies read (`app.org_id`, `app.user_id`, `app.actor`) with
 * `is_local = true`, so they vanish at commit and cannot leak across pooled
 * connections.
 */
export async function withOrg<T>(input: OrgContextInput, fn: (ctx: ServiceContext) => Promise<T>): Promise<T> {
  const after: Array<() => unknown | Promise<unknown>> = [];
  let emitted = false;
  const userId = input.actor.type === 'user' ? input.actor.id : input.actor.type === 'agent' ? input.actor.ownerUserId ?? '' : '';

  const result = await appDb().transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.org_id', ${input.orgId}, true), set_config('app.user_id', ${userId}, true), set_config('app.actor', ${actorString(input.actor)}, true)`,
    );

    const ctx: ServiceContext = {
      orgId: input.orgId,
      actor: input.actor,
      permissions: input.permissions,
      artistScope: input.artistScope ?? null,
      tx,
      ip: input.ip,
      can: (p) => input.permissions.has(p),
      assert: (p) => {
        if (!input.permissions.has(p)) throw new ForbiddenError(`Missing permission ${p}`, { permission: p });
      },
      emit: async (type, payload) => {
        emitted = true;
        await tx.insert(domainEvents).values({
          orgId: input.orgId,
          type,
          payload: payload as Record<string, unknown>,
          actor: actorString(input.actor),
        });
      },
      audit: async (entry) => {
        const d = diff(entry.before ?? null, entry.after ?? null);
        await tx.insert(auditLog).values({
          orgId: input.orgId,
          actorType: input.actor.type,
          actorId: input.actor.id ?? null,
          actorLabel: input.actor.name,
          action: entry.action,
          module: entry.module,
          targetType: entry.targetType,
          targetId: entry.targetId,
          targetLabel: entry.targetLabel,
          before: d.before,
          after: d.after,
          agentRunId: input.actor.type === 'agent' ? input.actor.runId : null,
          agentStepId: input.actor.type === 'agent' ? input.actor.stepId ?? null : null,
          ip: input.ip,
        });
      },
      afterCommit: (f) => {
        after.push(f);
      },
    };
    return fn(ctx);
  });

  if (emitted) after.unshift(() => redis().publish(OUTBOX_WAKE_CHANNEL, input.orgId));
  for (const f of after) {
    try {
      await f();
    } catch (err) {
      logger.error({ err }, 'afterCommit hook failed');
    }
  }
  return result;
}

/** Context for background work acting as the platform (not a person or agent). */
export function systemActor(name = 'system'): Actor {
  return { type: 'system', name };
}

export function withSystemOrg<T>(orgId: string, fn: (ctx: ServiceContext) => Promise<T>, name = 'worker'): Promise<T> {
  return withOrg({ orgId, actor: systemActor(name), permissions: PermissionSet.fromPatterns(['*']) }, fn);
}
