import { and, eq } from 'drizzle-orm';
import type { ServiceContext } from './context';
import type { DbLike } from './db/client';
import { orgModules } from './db/schema';
import type { EventType, StoredEvent } from './events';
import type { Metric } from './metrics';
import { registerPermissions, type PermissionDef } from './permissions';
import type { JobDefinition, ScheduleDefinition } from './queue';
import type { ApiRoute } from './router';
import type { ToolDefinition } from './tools';

export type PlanTier = 'starter' | 'growth' | 'scale';
export const PLAN_LABELS: Record<PlanTier, string> = { starter: 'Starter', growth: 'Growth', scale: 'Scale' };

/** A sidebar section. Several modules can contribute tabs to the same section. */
export type NavSection = { id: string; label: string; icon: string; sub: string; order: number };
export type NavTab = { id: string; label: string; href: string; permission?: string; order?: number };
export type NavContribution = { section: NavSection; tabs: NavTab[] };

/** Pure data: safe to import anywhere (web, worker, client components). */
export interface ModuleManifest {
  id: string;
  name: string;
  description: string;
  icon: string;
  /** Plan tiers that include the module by default. */
  plans: PlanTier[];
  /** Core modules cannot be switched off. */
  core?: boolean;
  dependsOn?: string[];
  permissions: PermissionDef[];
  nav: NavContribution[];
  events: { emits: string[]; listens: string[] };
  /** Names of agent tools the module registers. */
  tools: string[];
}

export type AttentionItem = { n: number; tone: 'red' | 'ink'; title: string; sub: string; href: string };
export type HealthStat = { label: string; icon: string; value: string; delta?: string; note?: string; group: 'health' | 'marketing' };
export type WidgetData = { value: string; unit: string; line: string; cta: string; href: string };
export type WidgetDef = { id: string; name: string; icon: string; desc: string; permission?: string; load(ctx: ServiceContext): Promise<WidgetData> };

/** One step of a new label's setup checklist, contributed by the module that owns it. */
export type OnboardingStep = { id: string; title: string; sub: string; done: boolean; href: string; order: number };

export type ShellCounts = { unread: number; runningAgents: number; pendingApprovals: number };

export type SearchResult = { type: string; title: string; sub?: string; href: string; icon?: string };

/** Extra per-entity values another module contributes to a list (e.g. streams per artist). */
export type Enricher = (ctx: ServiceContext, ids: string[]) => Promise<Record<string, Record<string, unknown>>>;

export type EventListener<K extends EventType = EventType> = {
  /** Stable id used for delivery dedupe, e.g. `streams.register-imported-track`. */
  id: string;
  event: K;
  handle(ctx: ServiceContext, event: StoredEvent<K>): Promise<void>;
};

/** Everything a module plugs into the server side of both apps. */
export interface ModuleServer {
  manifest: ModuleManifest;
  routes?: ApiRoute[];
  jobs?: JobDefinition[];
  schedules?: ScheduleDefinition[];
  listeners?: EventListener[];
  tools?: ToolDefinition[];
  widgets?: WidgetDef[];
  attention?: (ctx: ServiceContext) => Promise<AttentionItem[]>;
  stats?: (ctx: ServiceContext) => Promise<HealthStat[]>;
  search?: (ctx: ServiceContext, q: string) => Promise<SearchResult[]>;
  /** Platform-wide operational metrics (aggregates only, via the system connection) for /api/metrics. */
  metrics?: () => Promise<Metric[]>;
  /** Setup steps for the dashboard's getting-started checklist. */
  onboarding?: (ctx: ServiceContext) => Promise<OnboardingStep[]>;
  /** Counts for the console shell (notification badge, agent indicator). */
  shell?: (ctx: ServiceContext, userId: string) => Promise<Partial<ShellCounts>>;
  enrich?: Record<string, Enricher>;
}

export function defineModule(m: ModuleServer): ModuleServer {
  return m;
}

export function defineListener<K extends EventType>(l: EventListener<K>): EventListener {
  return l as unknown as EventListener;
}

// Shared via globalThis: Next compiles route handlers and pages into separate bundles,
// each with its own copy of this file, but they must see one registry.
const g = globalThis as unknown as { __lcModuleRegistry?: Map<string, ModuleServer> };
const registry: Map<string, ModuleServer> = (g.__lcModuleRegistry ??= new Map());

export function registerModules(mods: ModuleServer[]) {
  const toolNames = new Set<string>();
  for (const m of mods) {
    for (const t of m.tools ?? []) {
      if (toolNames.has(t.name)) throw new Error(`Duplicate agent tool ${t.name}`);
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(t.name)) throw new Error(`Invalid tool name ${t.name}`);
      if (t.module !== m.manifest.id) throw new Error(`Tool ${t.name} declares module ${t.module} but is registered by ${m.manifest.id}`);
      toolNames.add(t.name);
    }
    registerPermissions(m.manifest.permissions);
    registry.set(m.manifest.id, m);
  }
}

export function modules(): ModuleServer[] {
  return [...registry.values()];
}

export function getModule(id: string): ModuleServer | undefined {
  return registry.get(id);
}

/** Every registered agent tool, optionally limited to the modules an org has on. */
export function allTools(enabled?: Set<string>): ToolDefinition[] {
  return [...registry.values()].filter((m) => !enabled || enabled.has(m.manifest.id)).flatMap((m) => m.tools ?? []);
}

export function toolByName(name: string): ToolDefinition | undefined {
  for (const m of registry.values()) for (const t of m.tools ?? []) if (t.name === name) return t;
  return undefined;
}

/** Which modules are on for an org: explicit toggles win, else the plan default. */
export async function enabledModuleIds(db: DbLike, org: { id: string; plan: string }): Promise<Set<string>> {
  const rows = await db.select().from(orgModules).where(eq(orgModules.orgId, org.id));
  const overrides = new Map(rows.map((r) => [r.module, r.enabled]));
  const on = new Set<string>();
  for (const m of registry.values()) {
    const def = m.manifest.core || m.manifest.plans.includes(org.plan as PlanTier);
    if (m.manifest.core || (overrides.get(m.manifest.id) ?? def)) on.add(m.manifest.id);
  }
  // A module whose dependency is off is off too.
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...on]) {
      const deps = registry.get(id)?.manifest.dependsOn ?? [];
      if (deps.some((d) => !on.has(d))) {
        on.delete(id);
        changed = true;
      }
    }
  }
  return on;
}

export async function setModuleEnabled(ctx: ServiceContext, moduleId: string, enabled: boolean) {
  ctx.assert('settings:manage');
  const m = registry.get(moduleId);
  if (!m) throw new Error(`Unknown module ${moduleId}`);
  if (m.manifest.core && !enabled) throw new Error(`${m.manifest.name} is a core module and cannot be switched off`);
  const [before] = await ctx.tx.select().from(orgModules).where(and(eq(orgModules.orgId, ctx.orgId), eq(orgModules.module, moduleId)));
  await ctx.tx
    .insert(orgModules)
    .values({ module: moduleId, enabled })
    .onConflictDoUpdate({ target: [orgModules.orgId, orgModules.module], set: { enabled, updatedAt: new Date() } });
  await ctx.audit({ action: enabled ? 'module.enabled' : 'module.disabled', module: 'settings', targetType: 'module', targetId: moduleId, targetLabel: m.manifest.name, before: before ? { enabled: before.enabled } : null, after: { enabled } });
}

/** Merge every module's nav contributions into ordered sections with ordered tabs. */
export function buildNav(enabled: Set<string>, can: (p: string) => boolean) {
  const sections = new Map<string, NavSection & { tabs: NavTab[] }>();
  for (const m of registry.values()) {
    if (!enabled.has(m.manifest.id)) continue;
    for (const c of m.manifest.nav) {
      const tabs = c.tabs.filter((t) => !t.permission || can(t.permission));
      if (tabs.length === 0) continue;
      const existing = sections.get(c.section.id);
      if (existing) {
        existing.tabs.push(...tabs);
        if (c.section.order < existing.order) Object.assign(existing, { ...c.section, tabs: existing.tabs });
      } else {
        sections.set(c.section.id, { ...c.section, tabs: [...tabs] });
      }
    }
  }
  return [...sections.values()]
    .sort((a, b) => a.order - b.order)
    .map((s) => ({ ...s, tabs: s.tabs.sort((a, b) => (a.order ?? 50) - (b.order ?? 50)) }));
}

export type NavModel = ReturnType<typeof buildNav>;

/** Merge enrichment from every enabled module for one entity type. */
export async function enrich(ctx: ServiceContext, enabled: Set<string>, entityType: string, ids: string[]) {
  const out: Record<string, Record<string, unknown>> = Object.fromEntries(ids.map((id) => [id, {}]));
  if (ids.length === 0) return out;
  for (const m of registry.values()) {
    const fn = m.enrich?.[entityType];
    if (!fn || !enabled.has(m.manifest.id)) continue;
    const part = await fn(ctx, ids);
    for (const [id, vals] of Object.entries(part)) Object.assign((out[id] ??= {}), vals);
  }
  return out;
}
