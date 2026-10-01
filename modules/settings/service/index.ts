import '../types';
import { and, desc, eq, gte, ilike, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { hashToken, newToken } from '@labelconsole/core/auth';
import type { ServiceContext } from '@labelconsole/core/context';
import { auditLog, customRoles, invitations, memberships, organizations, usageCounters, users, type OrgSettings } from '@labelconsole/core/db/schema';
import { env } from '@labelconsole/core/env';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@labelconsole/core/errors';
import { modules, setModuleEnabled, enabledModuleIds, PLAN_LABELS, type PlanTier } from '@labelconsole/core/modules';
import { accessLevel, allPermissions, BUILT_IN_ROLES, PermissionSet, ROLE_LABELS, type BuiltInRole } from '@labelconsole/core/permissions';
import { enqueueAfterCommit } from '@labelconsole/core/queue';
import { listCredentials, putCredential, revokeCredential } from '@labelconsole/core/vault';
import { dataExports } from '../schema';
import { integrationFor } from '../integrations';

/* ------------------------------------------------------------ schemas -- */

export const WorkspacePatch = z
  .object({
    name: z.string().trim().min(1).max(120),
    shortCode: z.string().trim().min(1).max(5).transform((s) => s.toUpperCase()),
    legalEntity: z.string().trim().max(200).nullable(),
    distributor: z.string().trim().max(120).nullable(),
    currency: z.enum(['USD', 'EUR', 'GBP', 'SEK', 'AUD', 'CAD', 'JPY']),
    siteUrl: z.string().trim().max(200).nullable(),
    timezone: z.string().trim().max(60),
    streamPollHoursActive: z.number().int().min(1).max(168),
    streamPollHoursCatalogue: z.number().int().min(1).max(720),
    agentMonthlyBudgetUsd: z.number().min(0).max(1_000_000).nullable(),
  })
  .partial();

export const ProfilePatch = z.object({ name: z.string().trim().min(1).max(120) });
export const InviteInput = z.object({ email: z.email().transform((s) => s.trim().toLowerCase()), role: z.string().min(1) });
export const RoleChange = z.object({ role: z.string().min(1), customRoleId: z.uuid().nullable().optional() });
export const CustomRoleInput = z.object({ name: z.string().trim().min(1).max(60), description: z.string().trim().max(300).nullable().optional(), permissions: z.array(z.string()).min(1) });
/** Flat body: `provider`, optional `label`, plus the integration's own field names. */
export const CredentialInput = z.object({ provider: z.string().min(1), label: z.string().trim().max(120).nullable().optional() }).catchall(z.string().nullable());

/* ---------------------------------------------------------- workspace -- */

export async function getWorkspace(ctx: ServiceContext) {
  const [org] = await ctx.tx.select().from(organizations).where(eq(organizations.id, ctx.orgId));
  if (!org) throw new NotFoundError('Label');
  return org;
}

export async function updateWorkspace(ctx: ServiceContext, patch: z.infer<typeof WorkspacePatch>) {
  ctx.assert('settings:manage');
  const org = await getWorkspace(ctx);
  const { name, ...settingsPatch } = patch;
  const settings: OrgSettings = { ...org.settings, ...settingsPatch };
  const [after] = await ctx.tx
    .update(organizations)
    .set({ ...(name ? { name } : {}), settings })
    .where(eq(organizations.id, ctx.orgId))
    .returning();
  await ctx.audit({ action: 'workspace.updated', module: 'settings', targetType: 'organization', targetId: ctx.orgId, targetLabel: after.name, before: { name: org.name, ...org.settings }, after: { name: after.name, ...after.settings } });
  return after;
}

export async function updateProfile(ctx: ServiceContext, patch: z.infer<typeof ProfilePatch>) {
  if (ctx.actor.type !== 'user') throw new ForbiddenError('Only people have profiles');
  const [before] = await ctx.tx.select({ name: users.name }).from(users).where(eq(users.id, ctx.actor.id));
  const [after] = await ctx.tx.update(users).set({ name: patch.name }).where(eq(users.id, ctx.actor.id)).returning({ name: users.name });
  await ctx.audit({ action: 'profile.updated', module: 'settings', targetType: 'user', targetId: ctx.actor.id, targetLabel: after.name, before, after });
  return after;
}

/* ------------------------------------------------------------ members -- */

export type MemberRow = {
  membershipId: string;
  userId: string;
  name: string;
  email: string;
  role: string;
  roleLabel: string;
  status: string;
  lastActiveAt: Date | null;
  access: string;
};

function accessSummary(set: PermissionSet) {
  const mods = modules().filter((m) => !m.manifest.core);
  const levels = mods.map((m) => ({ name: m.manifest.name, level: accessLevel(set, m.manifest.id) }));
  if (levels.every((l) => l.level === 'Full')) return 'All sections';
  const visible = levels.filter((l) => l.level !== '—');
  if (visible.length === 0) return '—';
  return visible.map((l) => (l.level === 'View' ? `${l.name} (view)` : l.name)).join(' · ');
}

export async function listMembers(ctx: ServiceContext) {
  ctx.assert('settings:read');
  const rows = await ctx.tx
    .select({ m: memberships, u: { id: users.id, name: users.name, email: users.email, lastActiveAt: users.lastActiveAt } })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.orgId, ctx.orgId))
    .orderBy(memberships.createdAt);
  const custom = await ctx.tx.select().from(customRoles);
  const members: MemberRow[] = rows.map(({ m, u }) => {
    const cr = custom.find((c) => c.id === m.customRoleId);
    const set = PermissionSet.forRole(m.role, m.extraPermissions, cr?.permissions);
    return {
      membershipId: m.id,
      userId: u.id,
      name: u.name,
      email: u.email,
      role: m.role,
      roleLabel: m.role === 'custom' ? cr?.name ?? 'Custom' : ROLE_LABELS[m.role as BuiltInRole] ?? m.role,
      status: m.status,
      lastActiveAt: u.lastActiveAt,
      access: accessSummary(set),
    };
  });
  const pending = await ctx.tx
    .select()
    .from(invitations)
    .where(and(isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gte(invitations.expiresAt, new Date())))
    .orderBy(desc(invitations.createdAt));
  return { members, invitations: pending.map((i) => ({ id: i.id, email: i.email, role: i.role, roleLabel: ROLE_LABELS[i.role as BuiltInRole] ?? i.role, expiresAt: i.expiresAt, createdAt: i.createdAt })) };
}

function assertAssignable(ctx: ServiceContext, role: string) {
  if (role !== 'custom' && !BUILT_IN_ROLES.includes(role as BuiltInRole)) throw new ValidationError(`Unknown role ${role}`);
  if (role === 'owner' && !ctx.permissions.has('settings:billing')) throw new ForbiddenError('Only an owner can grant the owner role');
}

export async function inviteMember(ctx: ServiceContext, input: z.infer<typeof InviteInput>) {
  ctx.assert('settings:members');
  assertAssignable(ctx, input.role);
  const existing = await ctx.tx
    .select({ id: memberships.id })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.orgId, ctx.orgId), sql`lower(${users.email}) = ${input.email}`));
  if (existing.length) throw new ConflictError(`${input.email} is already a member`);
  const token = newToken();
  const [inv] = await ctx.tx
    .insert(invitations)
    .values({ email: input.email, role: input.role, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 14 * 86400_000) })
    .returning();
  const url = `${env().APP_URL}/invite/${token}`;
  await ctx.audit({ action: 'member.invited', module: 'settings', targetType: 'invitation', targetId: inv.id, targetLabel: input.email, after: { email: input.email, role: input.role } });
  await ctx.emit('settings.member.invited', { invitationId: inv.id, email: input.email, role: input.role });
  enqueueAfterCommit(ctx, 'settings.send-invite', { invitationId: inv.id, url }, { jobId: `invite-${inv.id}` });
  // The link is returned once so it can be copied when no email account is connected.
  return { id: inv.id, email: inv.email, role: inv.role, url };
}

export async function revokeInvitation(ctx: ServiceContext, id: string) {
  ctx.assert('settings:members');
  const [inv] = await ctx.tx.update(invitations).set({ revokedAt: new Date() }).where(eq(invitations.id, id)).returning();
  if (!inv) throw new NotFoundError('Invitation');
  await ctx.audit({ action: 'member.invite_revoked', module: 'settings', targetType: 'invitation', targetId: id, targetLabel: inv.email });
}

async function ownerCount(ctx: ServiceContext) {
  const [r] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(memberships).where(and(eq(memberships.role, 'owner'), eq(memberships.status, 'active')));
  return r.n;
}

export async function changeRole(ctx: ServiceContext, membershipId: string, input: z.infer<typeof RoleChange>) {
  ctx.assert('settings:members');
  assertAssignable(ctx, input.role);
  const [m] = await ctx.tx.select().from(memberships).where(eq(memberships.id, membershipId));
  if (!m) throw new NotFoundError('Member');
  if (m.role === 'owner' && input.role !== 'owner') {
    if (!ctx.permissions.has('settings:billing')) throw new ForbiddenError('Only an owner can change another owner');
    if ((await ownerCount(ctx)) <= 1) throw new ValidationError('A label needs at least one owner');
  }
  if (input.role === 'custom' && !input.customRoleId) throw new ValidationError('Pick a custom role');
  const [after] = await ctx.tx
    .update(memberships)
    .set({ role: input.role, customRoleId: input.role === 'custom' ? input.customRoleId ?? null : null })
    .where(eq(memberships.id, membershipId))
    .returning();
  const [u] = await ctx.tx.select({ name: users.name }).from(users).where(eq(users.id, m.userId));
  await ctx.audit({ action: 'member.role_changed', module: 'settings', targetType: 'membership', targetId: membershipId, targetLabel: u?.name, before: { role: m.role }, after: { role: after.role } });
  await ctx.emit('settings.member.role_changed', { membershipId, userId: m.userId, role: after.role });
  return after;
}

export async function removeMember(ctx: ServiceContext, membershipId: string) {
  ctx.assert('settings:members');
  const [m] = await ctx.tx.select().from(memberships).where(eq(memberships.id, membershipId));
  if (!m) throw new NotFoundError('Member');
  if (m.role === 'owner' && (await ownerCount(ctx)) <= 1) throw new ValidationError('A label needs at least one owner');
  if (m.role === 'owner' && !ctx.permissions.has('settings:billing')) throw new ForbiddenError('Only an owner can remove an owner');
  await ctx.tx.update(memberships).set({ status: 'removed' }).where(eq(memberships.id, membershipId));
  const [u] = await ctx.tx.select({ name: users.name }).from(users).where(eq(users.id, m.userId));
  await ctx.audit({ action: 'member.removed', module: 'settings', targetType: 'membership', targetId: membershipId, targetLabel: u?.name, before: { role: m.role, status: m.status }, after: { status: 'removed' } });
}

/* -------------------------------------------------------------- roles -- */

export async function rolesMatrix(ctx: ServiceContext) {
  ctx.assert('settings:read');
  const custom = await ctx.tx.select().from(customRoles).orderBy(customRoles.name);
  const counts = await ctx.tx
    .select({ role: memberships.role, customRoleId: memberships.customRoleId, n: sql<number>`count(*)::int` })
    .from(memberships)
    .where(eq(memberships.status, 'active'))
    .groupBy(memberships.role, memberships.customRoleId);
  const cols = [
    ...BUILT_IN_ROLES.map((r) => ({ key: r, name: ROLE_LABELS[r], set: PermissionSet.forRole(r), count: counts.filter((c) => c.role === r).reduce((a, c) => a + c.n, 0), builtIn: true })),
    ...custom.map((c) => ({ key: c.id, name: c.name, set: PermissionSet.forRole('custom', [], c.permissions), count: counts.filter((x) => x.customRoleId === c.id).reduce((a, x) => a + x.n, 0), builtIn: false })),
  ];
  const areas = modules()
    .filter((m) => m.manifest.permissions.length > 0)
    .map((m) => ({ id: m.manifest.id, name: m.manifest.name, desc: m.manifest.description }));
  return {
    columns: cols.map((c) => ({ key: c.key, name: c.name, count: c.count, builtIn: c.builtIn })),
    rows: areas.map((a) => ({ ...a, cells: cols.map((c) => accessLevel(c.set, a.id)) })),
    permissions: allPermissions(),
  };
}

export async function createCustomRole(ctx: ServiceContext, input: z.infer<typeof CustomRoleInput>) {
  ctx.assert('settings:members');
  const known = new Set(allPermissions().map((p) => p.key));
  const unknown = input.permissions.filter((p) => !known.has(p));
  if (unknown.length) throw new ValidationError(`Unknown permissions: ${unknown.join(', ')}`);
  // You cannot create a role with more power than you have.
  const excess = input.permissions.filter((p) => !ctx.permissions.has(p));
  if (excess.length) throw new ForbiddenError(`You cannot grant permissions you do not hold: ${excess.join(', ')}`);
  const [row] = await ctx.tx.insert(customRoles).values({ name: input.name, description: input.description ?? null, permissions: input.permissions }).returning();
  await ctx.audit({ action: 'role.created', module: 'settings', targetType: 'role', targetId: row.id, targetLabel: row.name, after: { permissions: row.permissions } });
  return row;
}

/* -------------------------------------------------------------- audit -- */

export const AuditQuery = z.object({
  module: z.string().optional(),
  q: z.string().trim().max(100).optional(),
  before: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export async function listAudit(ctx: ServiceContext, query: z.infer<typeof AuditQuery>) {
  ctx.assert('settings:audit');
  const conds = [];
  if (query.module) conds.push(eq(auditLog.module, query.module));
  if (query.before) conds.push(lt(auditLog.createdAt, new Date(query.before)));
  if (query.q) conds.push(or(ilike(auditLog.targetLabel, `%${query.q}%`), ilike(auditLog.actorLabel, `%${query.q}%`), ilike(auditLog.action, `%${query.q}%`)));
  return ctx.tx
    .select()
    .from(auditLog)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(auditLog.createdAt))
    .limit(query.limit);
}

/* -------------------------------------------------------- credentials -- */

export async function credentialsStatus(ctx: ServiceContext) {
  return listCredentials(ctx);
}

export async function saveCredential(ctx: ServiceContext, input: z.infer<typeof CredentialInput>) {
  const integration = integrationFor(input.provider);
  if (!integration) throw new ValidationError(`Unknown integration ${input.provider}`);
  const secret: Record<string, string> = {};
  for (const f of integration.fields) {
    const raw = (input as Record<string, unknown>)[f.name];
    const v = typeof raw === 'string' ? raw.trim() : '';
    if (!v && !f.optional) throw new ValidationError(`${f.label} is required`, { fieldErrors: { [f.name]: [`${f.label} is required`] } });
    if (v) secret[f.name] = v;
  }
  // Non-secret fields are kept as display metadata too (e.g. SMTP host, vendor name).
  const metadata = Object.fromEntries(integration.fields.filter((f) => !f.secret && secret[f.name]).map((f) => [f.name, secret[f.name]]));
  // Replacing a key: revoke the previous one so exactly one is active.
  for (const existing of (await listCredentials(ctx)).filter((c) => c.provider === input.provider)) await revokeCredential(ctx, existing.id);
  return putCredential(ctx, { provider: input.provider, label: input.label || integration.name, secret, metadata });
}

export { revokeCredential };

/* ------------------------------------------------------------ modules -- */

export async function listModules(ctx: ServiceContext) {
  ctx.assert('settings:read');
  const org = await getWorkspace(ctx);
  const enabled = await enabledModuleIds(ctx.tx, org);
  return modules().map((m) => ({
    id: m.manifest.id,
    name: m.manifest.name,
    description: m.manifest.description,
    icon: m.manifest.icon,
    core: Boolean(m.manifest.core),
    enabled: enabled.has(m.manifest.id),
    inPlan: m.manifest.plans.includes(org.plan as PlanTier),
    dependsOn: m.manifest.dependsOn ?? [],
  }));
}

export { setModuleEnabled };

/* ------------------------------------------------------------ billing -- */

export async function planUsage(ctx: ServiceContext) {
  ctx.assert('settings:read');
  const org = await getWorkspace(ctx);
  const month = new Date().toISOString().slice(0, 7);
  const usage = await ctx.tx.select().from(usageCounters).where(eq(usageCounters.month, month));
  const [seats] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(memberships).where(eq(memberships.status, 'active'));
  const get = (metric: string) => Number(usage.find((u) => u.metric === metric)?.value ?? 0);
  return {
    plan: org.plan as PlanTier,
    planLabel: PLAN_LABELS[org.plan as PlanTier] ?? org.plan,
    month,
    seats: seats.n,
    agentSpendUsd: get('agent_cost_usd'),
    agentRuns: get('agent_runs'),
    llmTokens: get('llm_tokens'),
    monthlyBudgetUsd: org.settings.agentMonthlyBudgetUsd ?? null,
    modulesInPlan: modules().filter((m) => m.manifest.plans.includes(org.plan as PlanTier)).map((m) => m.manifest.name),
  };
}

/* -------------------------------------------------------- data export -- */

export async function requestExport(ctx: ServiceContext) {
  ctx.assert('settings:export');
  const running = await ctx.tx.select({ id: dataExports.id }).from(dataExports).where(or(eq(dataExports.status, 'queued'), eq(dataExports.status, 'running')));
  if (running.length) throw new ConflictError('An export is already in progress');
  const [row] = await ctx.tx.insert(dataExports).values({}).returning();
  await ctx.audit({ action: 'export.requested', module: 'settings', targetType: 'export', targetId: row.id });
  enqueueAfterCommit(ctx, 'settings.export', { exportId: row.id }, { jobId: `export-${row.id}`, attempts: 2 });
  return row;
}

export async function listExports(ctx: ServiceContext) {
  ctx.assert('settings:export');
  return ctx.tx.select().from(dataExports).orderBy(desc(dataExports.createdAt)).limit(20);
}

export async function getExport(ctx: ServiceContext, id: string) {
  ctx.assert('settings:export');
  const [row] = await ctx.tx.select().from(dataExports).where(eq(dataExports.id, id));
  if (!row) throw new NotFoundError('Export');
  return row;
}

export async function requestDeletion(ctx: ServiceContext, confirmName: string) {
  ctx.assert('settings:billing');
  const org = await getWorkspace(ctx);
  if (confirmName.trim() !== org.name) throw new ValidationError('Type the label name exactly to confirm', { fieldErrors: { confirm: ['Does not match the label name'] } });
  await ctx.audit({ action: 'org.deletion_requested', module: 'settings', targetType: 'organization', targetId: org.id, targetLabel: org.name });
  enqueueAfterCommit(ctx, 'settings.delete-org', { requestedBy: ctx.actor.id ?? 'system' }, { jobId: `delete-${org.id}`, delay: 60_000, attempts: 3 });
  return { scheduled: true, inSeconds: 60 };
}
