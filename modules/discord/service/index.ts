import '../types';
import { createHmac, randomInt } from 'node:crypto';
import { and, desc, eq, gt, gte, inArray, isNull, lt, notInArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { memberAccess } from '@labelconsole/core/auth';
import { withOrg, withSystemOrg, type ServiceContext } from '@labelconsole/core/context';
import { systemDb } from '@labelconsole/core/db/client';
import { credentials, users } from '@labelconsole/core/db/schema';
import { env } from '@labelconsole/core/env';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@labelconsole/core/errors';
import { enqueueAfterCommit } from '@labelconsole/core/queue';
import { getCredentialHandle } from '@labelconsole/core/vault';
import { isPublicKeyHex, isSnowflake } from '../protocol/verify';
import { notify } from '@labelconsole/inbox/service';
import { CORRECTABLE_FIELDS } from '../protocol/commands';
import { RECORDING_FIELDS, type ClaimField, type ResolvedMetadata } from '@labelconsole/catalogue/schema';
import { pausedSources, resumeSource } from '@labelconsole/catalogue/service';
import { discordBenchmarks, discordCorrections, discordEvidence, discordLinkCodes, discordLinks, discordLookups, discordPlayReadings, discordState, type SourceCall } from '../schema';

/** The permission a member needs to link and use the app: the app shows catalogue data. */
export const USE_PERMISSION = 'catalogue:read';

const CODE_TTL_MS = 10 * 60_000;
/** No 0/O, 1/I/L: the code is read off a screen and typed. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/* ---------------------------------------------------------- link codes -- */

export function hashLinkCode(code: string): string | null {
  const norm = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (norm.length !== 8 || [...norm].some((c) => !ALPHABET.includes(c))) return null;
  return createHmac('sha256', env().SIGNING_SECRET).update(`discord-link:${norm}`).digest('hex');
}

function newLinkCode() {
  const chars = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

function assertPerson(ctx: ServiceContext) {
  if (ctx.actor.type !== 'user') throw new ForbiddenError('Only a person can link a Discord account');
  return ctx.actor.id;
}

/** A one-time code for /link. Replaces any earlier code of this member; only its HMAC is stored. */
export async function createLinkCode(ctx: ServiceContext) {
  const userId = assertPerson(ctx);
  ctx.assert(USE_PERMISSION);
  await ctx.tx.delete(discordLinkCodes).where(eq(discordLinkCodes.userId, userId));
  const code = newLinkCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);
  await ctx.tx.insert(discordLinkCodes).values({ userId, codeHash: hashLinkCode(code)!, expiresAt });
  return { code, expiresAt, command: `/link code:${code}` };
}

/**
 * Redeem a code typed into /link by a Discord user. Runs before any member is
 * known, so it finds the code across the label with the system pool and uses
 * it up atomically; the link itself is written as the member who made the code.
 */
export async function redeemLinkCode(orgId: string, code: string, discord: { id: string; username: string }): Promise<{ ok: true; userName: string; orgName: string } | { ok: false; message: string }> {
  const hash = hashLinkCode(code);
  const invalid = { ok: false as const, message: 'That code is wrong or has expired. Get a new one in Label Console → Settings → Discord.' };
  if (!hash) return invalid;
  const [row] = await systemDb()
    .update(discordLinkCodes)
    .set({ usedAt: new Date() })
    .where(and(eq(discordLinkCodes.codeHash, hash), eq(discordLinkCodes.orgId, orgId), isNull(discordLinkCodes.usedAt), gt(discordLinkCodes.expiresAt, new Date())))
    .returning();
  if (!row) return invalid;
  const access = await memberAccess(row.userId, orgId);
  if (!access || !access.permissions.has(USE_PERMISSION)) return { ok: false, message: 'The Label Console account that made this code can no longer use the Discord app.' };
  await withOrg({ orgId, actor: { type: 'user', id: access.user.id, name: access.user.name }, permissions: access.permissions, artistScope: access.artistScope }, async (ctx) => {
    // One Discord account per member and one member per Discord account: the newest link wins.
    const replaced = await ctx.tx
      .delete(discordLinks)
      .where(or(eq(discordLinks.discordUserId, discord.id), eq(discordLinks.userId, access.user.id)))
      .returning();
    await ctx.tx.insert(discordLinks).values({ userId: access.user.id, discordUserId: discord.id, discordUsername: discord.username.slice(0, 100) });
    await ctx.audit({
      action: 'discord.linked',
      module: 'discord',
      targetType: 'user',
      targetId: access.user.id,
      targetLabel: access.user.name,
      after: { discordUsername: discord.username, discordUserId: discord.id, replacedLinks: replaced.length },
    });
  });
  return { ok: true, userName: access.user.name, orgName: access.org.name };
}

/* --------------------------------------------------------------- links -- */

/** The link for a Discord user in a label, looked up before any member context exists. */
export async function findLink(orgId: string, discordUserId: string) {
  const [row] = await systemDb()
    .select()
    .from(discordLinks)
    .where(and(eq(discordLinks.orgId, orgId), eq(discordLinks.discordUserId, discordUserId)));
  return row ?? null;
}

export async function touchLink(linkId: string) {
  await systemDb().update(discordLinks).set({ lastUsedAt: new Date() }).where(eq(discordLinks.id, linkId));
}

/** /unlink from Discord: the person holding the Discord account removes its link. */
export async function unlinkDiscordUser(orgId: string, discordUserId: string) {
  const link = await findLink(orgId, discordUserId);
  if (!link) return false;
  await withSystemOrg(
    orgId,
    async (ctx) => {
      await ctx.tx.delete(discordLinks).where(eq(discordLinks.id, link.id));
      await forgetLookups(ctx, link.userId);
      await ctx.audit({ action: 'discord.unlinked', module: 'discord', targetType: 'user', targetId: link.userId, targetLabel: link.discordUsername, before: { discordUsername: link.discordUsername }, after: { via: 'discord' } });
    },
    'discord /unlink',
  );
  return true;
}

export async function myLink(ctx: ServiceContext) {
  const userId = assertPerson(ctx);
  const [row] = await ctx.tx.select().from(discordLinks).where(eq(discordLinks.userId, userId));
  return row ?? null;
}

export async function listLinks(ctx: ServiceContext) {
  ctx.assert('settings:read');
  return ctx.tx
    .select({ id: discordLinks.id, userId: discordLinks.userId, userName: users.name, discordUsername: discordLinks.discordUsername, createdAt: discordLinks.createdAt, lastUsedAt: discordLinks.lastUsedAt })
    .from(discordLinks)
    .leftJoin(users, eq(users.id, discordLinks.userId))
    .orderBy(desc(discordLinks.createdAt));
}

/** Unlinking also removes the person from the lookup log; the counts stay for the label's metrics. */
async function forgetLookups(ctx: ServiceContext, userId: string) {
  await ctx.tx.update(discordLookups).set({ userId: null }).where(eq(discordLookups.userId, userId));
}

/** Anyone may remove their own link; removing someone else's needs member management rights. */
export async function removeLink(ctx: ServiceContext, id: string) {
  const [link] = await ctx.tx.select().from(discordLinks).where(eq(discordLinks.id, id));
  if (!link) throw new NotFoundError('Discord link');
  if (!(ctx.actor.type === 'user' && ctx.actor.id === link.userId)) ctx.assert('settings:members');
  await ctx.tx.delete(discordLinks).where(eq(discordLinks.id, id));
  await forgetLookups(ctx, link.userId);
  await ctx.audit({ action: 'discord.unlinked', module: 'discord', targetType: 'user', targetId: link.userId, targetLabel: link.discordUsername, before: { discordUsername: link.discordUsername } });
  return { ok: true };
}

/* ------------------------------------------------------------ the app -- */

export type DiscordApp = { orgId: string; applicationId: string; publicKey: string };

const appCache = new Map<string, { at: number; app: DiscordApp | null }>();
const APP_CACHE_MS = 30_000;
/** Short, so saving the integration and then the endpoint URL in Discord works straight away. */
const UNKNOWN_APP_CACHE_MS = 5_000;
/** Application IDs arrive before any check, so the cache must not grow with whatever strangers send. */
const APP_CACHE_MAX = 200;

/**
 * The label whose Discord app this is, from the non-secret fields of its
 * Discord integration. Interactions name their application; its public key
 * then proves the request came from Discord.
 */
export async function appForApplicationId(applicationId: string): Promise<DiscordApp | null> {
  if (!isSnowflake(applicationId)) return null;
  const hit = appCache.get(applicationId);
  if (hit && Date.now() - hit.at < (hit.app ? APP_CACHE_MS : UNKNOWN_APP_CACHE_MS)) return hit.app;
  const [row] = await systemDb()
    .select({ orgId: credentials.orgId, metadata: credentials.metadata })
    .from(credentials)
    .where(and(eq(credentials.provider, 'discord'), isNull(credentials.revokedAt), sql`${credentials.metadata}->>'applicationId' = ${applicationId}`))
    .orderBy(desc(credentials.createdAt))
    .limit(1);
  const publicKey = typeof row?.metadata.publicKey === 'string' ? row.metadata.publicKey.toLowerCase() : '';
  const app = row && isPublicKeyHex(publicKey) ? { orgId: row.orgId, applicationId, publicKey } : null;
  if (appCache.size >= APP_CACHE_MAX) appCache.clear();
  appCache.set(applicationId, { at: Date.now(), app });
  return app;
}

/** Test hook. */
export function forgetDiscordApps() {
  appCache.clear();
}

export const interactionsUrl = () => `${env().APP_URL.replace(/\/$/, '')}/api/discord/interactions`;

/** Setup state for the Discord settings page. Reads only non-secret fields, so it works in the web process. */
export async function discordStatus(ctx: ServiceContext) {
  const handle = await getCredentialHandle(ctx, 'discord');
  const applicationId = typeof handle?.metadata.applicationId === 'string' ? handle.metadata.applicationId : null;
  const publicKey = typeof handle?.metadata.publicKey === 'string' ? handle.metadata.publicKey : null;
  const [state] = await ctx.tx.select().from(discordState);
  const problems: string[] = [];
  if (handle && (!applicationId || !isSnowflake(applicationId))) problems.push('The application ID should be a long number (General Information → Application ID).');
  if (handle && (!publicKey || !isPublicKeyHex(publicKey))) problems.push('The public key should be 64 letters and digits (General Information → Public Key).');
  const ready = Boolean(handle) && problems.length === 0;
  return {
    connected: Boolean(handle),
    ready,
    problems,
    applicationId,
    interactionsUrl: interactionsUrl(),
    /** Install to your own account: the commands then work in any server and DM. */
    userInstallUrl: ready ? `https://discord.com/oauth2/authorize?client_id=${applicationId}&integration_type=1&scope=applications.commands` : null,
    /** Add to a server (the label's own): the commands work there for every linked member. */
    serverInstallUrl: ready ? `https://discord.com/oauth2/authorize?client_id=${applicationId}&integration_type=0&scope=applications.commands` : null,
    commandsRegisteredAt: state?.applicationId === applicationId ? state?.commandsRegisteredAt ?? null : null,
    commandsError: state?.applicationId === applicationId ? state?.commandsError ?? null : null,
  };
}

/** Register (or refresh) the slash commands. The bot token is decrypted only in the worker job. */
export async function requestCommandRegistration(ctx: ServiceContext) {
  ctx.assert('settings:manage');
  const status = await discordStatus(ctx);
  if (!status.connected) throw new ValidationError('Connect Discord under Settings → Integrations first');
  if (!status.ready) throw new ValidationError(status.problems.join(' '));
  enqueueAfterCommit(ctx, 'discord.register-commands', { requestedBy: ctx.actor.type === 'system' ? 'system' : `${ctx.actor.type}:${ctx.actor.id}` }, { attempts: 1, jobId: `discord-commands-${ctx.orgId}-${Date.now()}` });
  await ctx.audit({ action: 'discord.commands_requested', module: 'discord', targetType: 'discord_app', targetId: status.applicationId ?? undefined, targetLabel: 'Discord commands' });
  return { ok: true };
}

export async function recordCommandRegistration(ctx: ServiceContext, applicationId: string, error: string | null) {
  const values = { applicationId, commandsRegisteredAt: error ? null : new Date(), commandsError: error };
  await ctx.tx.insert(discordState).values(values).onConflictDoUpdate({ target: discordState.orgId, set: values });
}

/* ------------------------------------------------------------ settings -- */

export type SharingSettings = { allowSharing: boolean; shareDistributor: boolean; shareStreams: boolean };
export type DiscordSettings = SharingSettings & { dailyReadings: number };
const DEFAULT_SETTINGS: DiscordSettings = { allowSharing: true, shareDistributor: true, shareStreams: true, dailyReadings: 0 };
/** Daily readings cost one SpotScraper request per song per day, so the cap is kept modest. */
export const MAX_DAILY_READINGS = 200;

/** What members may post for everyone, read before any member context exists (interactions endpoint). */
export async function sharingFor(orgId: string): Promise<SharingSettings> {
  const [row] = await systemDb().select({ allowSharing: discordState.allowSharing, shareDistributor: discordState.shareDistributor, shareStreams: discordState.shareStreams }).from(discordState).where(eq(discordState.orgId, orgId));
  return row ?? DEFAULT_SETTINGS;
}

export const SettingsPatch = z.object({
  allowSharing: z.boolean().optional(),
  shareDistributor: z.boolean().optional(),
  shareStreams: z.boolean().optional(),
  dailyReadings: z.number().int().min(0).max(MAX_DAILY_READINGS).optional(),
});

export async function discordSettings(ctx: ServiceContext): Promise<DiscordSettings> {
  const [row] = await ctx.tx.select().from(discordState);
  return row ? { allowSharing: row.allowSharing, shareDistributor: row.shareDistributor, shareStreams: row.shareStreams, dailyReadings: row.dailyReadings } : DEFAULT_SETTINGS;
}

export async function updateDiscordSettings(ctx: ServiceContext, patch: z.infer<typeof SettingsPatch>) {
  ctx.assert('settings:manage');
  const before = await discordSettings(ctx);
  const after = { ...before, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
  await ctx.tx.insert(discordState).values(after).onConflictDoUpdate({ target: discordState.orgId, set: after });
  await ctx.audit({ action: 'discord.settings_updated', module: 'discord', targetType: 'discord_app', targetLabel: 'Discord settings', before, after });
  return after;
}

/* --------------------------------------------------------- corrections -- */

const FIELD_VALUES = CORRECTABLE_FIELDS.map((f) => f.value) as [string, ...string[]];
export const CorrectionInput = z.object({
  ref: z.string().regex(/^(isrc:[A-Z]{2}[A-Z0-9]{3}\d{7}|upc:\d{12,14})$/),
  subject: z.string().trim().min(1).max(300),
  field: z.enum(FIELD_VALUES),
  currentValue: z.string().max(1000).nullable().optional(),
  proposedValue: z.string().trim().min(1).max(500),
  note: z.string().trim().max(500).nullable().optional(),
});

/** A member suggests a correction; people who can edit the catalogue are told it is waiting. */
export async function createCorrection(ctx: ServiceContext, input: z.input<typeof CorrectionInput>) {
  const userId = assertPerson(ctx);
  ctx.assert(USE_PERMISSION);
  const data = CorrectionInput.parse(input);
  const [row] = await ctx.tx.insert(discordCorrections).values({ ...data, currentValue: data.currentValue ?? null, note: data.note || null, submittedBy: userId }).returning();
  const field = CORRECTABLE_FIELDS.find((f) => f.value === data.field)?.name ?? data.field;
  await notify(ctx, {
    permission: 'catalogue:write',
    kind: 'system',
    title: `Correction suggested: ${field} of "${data.subject}"`,
    body: `${ctx.actor.name} suggests "${data.proposedValue}"${data.currentValue ? ` instead of "${data.currentValue}"` : ''}.`,
    href: '/settings/discord',
    entityType: 'discord_correction',
    entityId: row.id,
  });
  await ctx.audit({ action: 'discord.correction_suggested', module: 'discord', targetType: 'discord_correction', targetId: row.id, targetLabel: data.subject, after: { field: data.field, proposedValue: data.proposedValue } });
  return row;
}

export async function listCorrections(ctx: ServiceContext, status: 'pending' | 'reviewed' = 'pending') {
  ctx.assert(USE_PERMISSION);
  const submitter = sql<string | null>`(select name from users where users.id = ${discordCorrections.submittedBy})`;
  const reviewer = sql<string | null>`(select name from users where users.id = ${discordCorrections.reviewedBy})`;
  return ctx.tx
    .select({ row: discordCorrections, submittedByName: submitter, reviewedByName: reviewer })
    .from(discordCorrections)
    .where(status === 'pending' ? eq(discordCorrections.status, 'pending') : inArray(discordCorrections.status, ['approved', 'rejected']))
    .orderBy(desc(status === 'pending' ? discordCorrections.createdAt : discordCorrections.reviewedAt))
    .limit(50);
}

export const ReviewInput = z.object({ decision: z.enum(['approved', 'rejected']), note: z.string().trim().max(500).nullable().optional() });

export async function reviewCorrection(ctx: ServiceContext, id: string, input: z.infer<typeof ReviewInput>) {
  ctx.assert('catalogue:write');
  const userId = assertPerson(ctx);
  const [row] = await ctx.tx
    .update(discordCorrections)
    .set({ status: input.decision, reviewedBy: userId, reviewedAt: new Date(), reviewNote: input.note || null })
    .where(and(eq(discordCorrections.id, id), eq(discordCorrections.status, 'pending')))
    .returning();
  if (!row) throw new NotFoundError('Pending correction');
  // An approved value replaces an earlier approved one for the same field.
  if (input.decision === 'approved') {
    await ctx.tx
      .update(discordCorrections)
      .set({ status: 'superseded' })
      .where(and(eq(discordCorrections.ref, row.ref), eq(discordCorrections.field, row.field), eq(discordCorrections.status, 'approved'), sql`${discordCorrections.id} <> ${row.id}`));
  }
  await ctx.audit({ action: `discord.correction_${input.decision}`, module: 'discord', targetType: 'discord_correction', targetId: id, targetLabel: row.subject, after: { field: row.field, proposedValue: row.proposedValue, note: input.note ?? null } });
  return row;
}

/** Approved corrections for a song or release, as cards show them. */
export async function approvedCorrections(ctx: ServiceContext, ref: string) {
  const rows = await ctx.tx
    .select({ field: discordCorrections.field, value: discordCorrections.proposedValue, reviewer: sql<string | null>`(select name from users where users.id = ${discordCorrections.reviewedBy})` })
    .from(discordCorrections)
    .where(and(eq(discordCorrections.ref, ref), eq(discordCorrections.status, 'approved')))
    .orderBy(desc(discordCorrections.reviewedAt));
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.field) ? false : (seen.add(r.field), true)));
}

/* ------------------------------------------------------------ readings -- */

/** Keep the platform's public count from a lookup; at most one reading per song and platform per hour. */
export async function recordReading(ctx: ServiceContext, r: { isrc: string; platform: string; source: string; count: number }) {
  const [recent] = await ctx.tx
    .select({ id: discordPlayReadings.id })
    .from(discordPlayReadings)
    .where(and(eq(discordPlayReadings.isrc, r.isrc), eq(discordPlayReadings.platform, r.platform), gte(discordPlayReadings.capturedAt, new Date(Date.now() - 3600_000))))
    .limit(1);
  if (recent) return;
  await ctx.tx.insert(discordPlayReadings).values(r);
}

export async function readingsFor(ctx: ServiceContext, isrc: string, platform = 'spotify') {
  return ctx.tx
    .select({ count: discordPlayReadings.count, capturedAt: discordPlayReadings.capturedAt, source: discordPlayReadings.source })
    .from(discordPlayReadings)
    .where(and(eq(discordPlayReadings.isrc, isrc), eq(discordPlayReadings.platform, platform), gte(discordPlayReadings.capturedAt, new Date(Date.now() - 365 * 86400_000))))
    .orderBy(discordPlayReadings.capturedAt)
    .limit(500);
}

/* ------------------------------------------------------------- metrics -- */

export type LookupLog = { userId: string | null; command: string; inputKind: string; outcome: string; ref: string | null; cached: boolean; durationMs: number; coverage?: Record<string, string> | null; sources?: SourceCall[] | null };

export async function recordLookup(ctx: ServiceContext, log: LookupLog) {
  await ctx.tx.insert(discordLookups).values({ ...log, durationMs: Math.max(0, Math.round(log.durationMs)), coverage: log.coverage ?? null, sources: log.sources?.length ? log.sources : null });
}

/** Source outcomes that mean the answer may be missing something. */
export const DEGRADED = ['error', 'timeout', 'rate_limited', 'busy', 'paused'];

/** Launch metrics for Settings → Discord: the last `days` of commands. */
export async function lookupStats(ctx: ServiceContext, days = 7) {
  ctx.assert('settings:read');
  const since = new Date(Date.now() - days * 86400_000);
  const sinceSql = sql`${since.toISOString()}::timestamptz`;
  const degraded = sql.raw(DEGRADED.map((d) => `'${d}'`).join(', '));
  const [row] = await ctx.tx
    .select({
      total: sql<number>`count(*)::int`,
      cards: sql<number>`count(*) filter (where ${discordLookups.outcome} = 'card')::int`,
      pickers: sql<number>`count(*) filter (where ${discordLookups.outcome} = 'picker')::int`,
      notFound: sql<number>`count(*) filter (where ${discordLookups.outcome} = 'not_found')::int`,
      errors: sql<number>`count(*) filter (where ${discordLookups.outcome} = 'error')::int`,
      cached: sql<number>`count(*) filter (where ${discordLookups.cached})::int`,
      codes: sql<number>`count(*) filter (where ${discordLookups.inputKind} in ('isrc', 'upc'))::int`,
      codesFound: sql<number>`count(*) filter (where ${discordLookups.inputKind} in ('isrc', 'upc') and ${discordLookups.outcome} = 'card')::int`,
      fresh: sql<number>`count(*) filter (where ${discordLookups.sources} is not null)::int`,
      partial: sql<number>`count(*) filter (where exists (select 1 from jsonb_array_elements(${discordLookups.sources}) as e where e->>'outcome' in (${degraded})))::int`,
      p50: sql<number | null>`percentile_cont(0.5) within group (order by ${discordLookups.durationMs})`,
      p95: sql<number | null>`percentile_cont(0.95) within group (order by ${discordLookups.durationMs})`,
    })
    .from(discordLookups)
    .where(gte(discordLookups.createdAt, since));
  const coverage = (await ctx.tx.execute(
    sql`select kv.key as field, kv.value as status, count(*)::int as n from discord_lookups, jsonb_each_text(discord_lookups.coverage) as kv where discord_lookups.created_at >= ${sinceSql} and discord_lookups.outcome = 'card' group by 1, 2`,
  )) as unknown as Array<{ field: string; status: string; n: number }>;
  const sources = (await ctx.tx.execute(
    sql`select e->>'source' as source, e->>'outcome' as outcome, count(*)::int as n,
          percentile_cont(0.5) within group (order by (e->>'ms')::int) as p50,
          percentile_cont(0.95) within group (order by (e->>'ms')::int) as p95
        from discord_lookups, jsonb_array_elements(discord_lookups.sources) as e
        where discord_lookups.created_at >= ${sinceSql} and discord_lookups.sources is not null
        group by 1, 2`,
  )) as unknown as Array<{ source: string; outcome: string; n: number; p50: number | null; p95: number | null }>;
  const [corrections] = await ctx.tx
    .select({ pending: sql<number>`count(*) filter (where ${discordCorrections.status} = 'pending')::int`, recent: sql<number>`count(*) filter (where ${discordCorrections.createdAt} >= ${sinceSql})::int` })
    .from(discordCorrections);
  return { days, ...row, p50: row.p50 == null ? null : Math.round(row.p50), p95: row.p95 == null ? null : Math.round(row.p95), coverage, sources: sourceHealth(sources), paused: await pausedForLabel(ctx.orgId), corrections };
}

/** Outcomes where the source was never asked. */
const NOT_CALLED = ['skipped', 'paused', 'busy'];

export type SourceHealth = { source: string; calls: number; outcomes: Record<string, number>; p50: number | null; p95: number | null };

/** One row per source: outcome counts, and timing over the calls that reached it. */
export function sourceHealth(rows: Array<{ source: string; outcome: string; n: number; p50: number | null; p95: number | null }>): SourceHealth[] {
  const by = new Map<string, SourceHealth & { timed: number }>();
  for (const r of rows) {
    const h = by.get(r.source) ?? { source: r.source, calls: 0, outcomes: {}, p50: null, p95: null, timed: 0 };
    h.outcomes[r.outcome] = (h.outcomes[r.outcome] ?? 0) + r.n;
    if (!NOT_CALLED.includes(r.outcome)) h.calls += r.n;
    // Timing: the answered calls' figures are the useful ones; else whatever was timed.
    if (r.p50 != null && (r.outcome === 'answered' || h.p50 == null)) {
      h.p50 = Math.round(Number(r.p50));
      h.p95 = r.p95 == null ? null : Math.round(Number(r.p95));
    }
    by.set(r.source, h);
  }
  return [...by.values()].map(({ timed: _, ...h }) => h).sort((a, b) => b.calls - a.calls || a.source.localeCompare(b.source));
}

/** Sources paused right now that affect this label: shared ones, and the label's own keyed ones. */
async function pausedForLabel(orgId: string) {
  return (await pausedSources()).filter((p) => p.scope === null || p.scope === orgId).map((p) => ({ source: p.source, secondsLeft: p.secondsLeft, own: p.scope !== null }));
}

/** Clear a pause by hand, after fixing a key or when the outage is over. Shared pauses clear for everyone. */
export async function resumePausedSource(ctx: ServiceContext, source: string) {
  ctx.assert('settings:manage');
  if (!/^[a-z]{2,20}$/.test(source)) throw new ValidationError('Unknown source');
  await resumeSource(source, null);
  await resumeSource(source, ctx.orgId);
  await ctx.audit({ action: 'discord.source_resumed', module: 'discord', targetType: 'metadata_source', targetLabel: source });
  return { ok: true };
}

/* ------------------------------------------------------------ evidence -- */

export type EvidenceRow = { ref: string; field: string; source: string; value: string; sourceUrl: string | null; firstSeenAt: Date; lastSeenAt: Date };

/**
 * How long each source's values stay in the history, in days, following
 * each provider's terms (docs/discord-providers.md). 0 means never kept:
 * the value is shown at lookup time (and cached for an hour) only.
 * - MusicBrainz core data is CC0: kept two years.
 * - iTunes Search encourages caching its text metadata: kept 30 days.
 * - Spotify forbids storing its content beyond temporary caching; Discogs
 *   forbids keeping API data longer than needed (and older than 6 hours on
 *   screen); Deezer and Apple Music limit use; SpotScraper is scraped
 *   Spotify data; licensed vendors depend on the contract: none are kept.
 */
export const EVIDENCE_RETENTION_DAYS: Record<string, number> = { default: 0, musicbrainz: 730, itunes: 30 };
export const retentionDays = (source: string) => EVIDENCE_RETENTION_DAYS[source] ?? EVIDENCE_RETENTION_DAYS.default;

/** The rows a lookup adds to the history: recording fields under the ISRC, release fields under each source's own UPC. */
export function evidenceRows(md: ResolvedMetadata): Array<Pick<EvidenceRow, 'ref' | 'field' | 'source' | 'value' | 'sourceUrl'>> {
  const isrcRef = md.isrc ? `isrc:${md.isrc}` : null;
  const out = new Map<string, Pick<EvidenceRow, 'ref' | 'field' | 'source' | 'value' | 'sourceUrl'>>();
  for (const c of md.claims ?? []) {
    if (retentionDays(c.source) <= 0) continue;
    const releaseRef = c.upc ? `upc:${c.upc}` : md.upc ? `upc:${md.upc}` : null;
    for (const [field, value] of Object.entries(c.values)) {
      if (!value || field === 'isrc') continue;
      const ref = RECORDING_FIELDS.includes(field as ClaimField) ? isrcRef : releaseRef;
      if (!ref) continue;
      const row = { ref, field, source: c.source, value: value.slice(0, 500), sourceUrl: c.url };
      out.set(`${row.ref}|${row.field}|${row.source}|${row.value}`, row);
    }
  }
  return [...out.values()];
}

/** Keep what each source said. A new value is a new row; a value seen again only moves `last_seen_at`. */
export async function recordEvidence(ctx: ServiceContext, md: ResolvedMetadata, seenAt = new Date()) {
  const rows = evidenceRows(md);
  if (!rows.length) return 0;
  await ctx.tx
    .insert(discordEvidence)
    .values(rows.map((r) => ({ ...r, firstSeenAt: seenAt, lastSeenAt: seenAt })))
    .onConflictDoUpdate({ target: [discordEvidence.orgId, discordEvidence.ref, discordEvidence.field, discordEvidence.source, discordEvidence.value], set: { lastSeenAt: seenAt, sourceUrl: sql`coalesce(excluded.source_url, ${discordEvidence.sourceUrl})` } });
  return rows.length;
}

/** The history for a song or release (its ISRC and UPC refs). */
export async function evidenceFor(ctx: ServiceContext, refs: string[]): Promise<EvidenceRow[]> {
  if (!refs.length) return [];
  return ctx.tx
    .select({ ref: discordEvidence.ref, field: discordEvidence.field, source: discordEvidence.source, value: discordEvidence.value, sourceUrl: discordEvidence.sourceUrl, firstSeenAt: discordEvidence.firstSeenAt, lastSeenAt: discordEvidence.lastSeenAt })
    .from(discordEvidence)
    .where(inArray(discordEvidence.ref, refs))
    .orderBy(discordEvidence.field, discordEvidence.source, discordEvidence.firstSeenAt)
    .limit(500);
}

/* ---------------------------------------------------------- benchmarks -- */

export const BenchmarkInput = z.object({ sample: z.coerce.number().int().min(5).max(50).default(20), includeBilled: z.boolean().default(false) });

/** Look up a sample of the label's own songs through every source and score them against the catalogue. One at a time per label. */
export async function startBenchmark(ctx: ServiceContext, input: z.input<typeof BenchmarkInput>) {
  ctx.assert('settings:manage');
  const userId = assertPerson(ctx);
  const data = BenchmarkInput.parse(input);
  const [running] = await ctx.tx
    .select({ id: discordBenchmarks.id })
    .from(discordBenchmarks)
    .where(and(inArray(discordBenchmarks.status, ['queued', 'running']), gte(discordBenchmarks.createdAt, new Date(Date.now() - 3600_000))))
    .limit(1);
  if (running) throw new ConflictError('A benchmark is already running. It takes a few minutes.');
  const [row] = await ctx.tx.insert(discordBenchmarks).values({ requestedBy: userId, sample: data.sample, includeBilled: data.includeBilled }).returning();
  enqueueAfterCommit(ctx, 'discord.benchmark', { benchmarkId: row.id }, { attempts: 1, jobId: `discord-benchmark-${row.id}` });
  await ctx.audit({ action: 'discord.benchmark_started', module: 'discord', targetType: 'discord_benchmark', targetId: row.id, targetLabel: `Source benchmark (${data.sample} songs)`, after: data });
  return row;
}

/** Members limited to some artists don't see the per-song disagreements: the sample may include other artists' songs. */
const forViewer = (ctx: ServiceContext, row: typeof discordBenchmarks.$inferSelect) => (ctx.artistScope && row.results ? { ...row, results: { ...row.results, misses: [] } } : row);

export async function listBenchmarks(ctx: ServiceContext) {
  ctx.assert('settings:read');
  const rows = await ctx.tx.select().from(discordBenchmarks).orderBy(desc(discordBenchmarks.createdAt)).limit(5);
  return rows.map((r) => forViewer(ctx, r));
}

export async function getBenchmark(ctx: ServiceContext, id: string) {
  ctx.assert('settings:read');
  const [row] = await ctx.tx.select().from(discordBenchmarks).where(eq(discordBenchmarks.id, id));
  if (!row) throw new NotFoundError('Benchmark');
  return forViewer(ctx, row);
}

/* ------------------------------------------------------ daily readings -- */

/** Labels that keep daily readings, across labels (system pool). */
export async function labelsWithDailyReadings() {
  return systemDb().select({ orgId: discordState.orgId, limit: discordState.dailyReadings }).from(discordState).where(gt(discordState.dailyReadings, 0));
}

/**
 * The songs to read today: the most recently looked-up ISRCs of the last 30
 * days, newest first. Songs in the label's catalogue are left out: Streams
 * tracks those daily already.
 */
export async function songsToFollow(ctx: ServiceContext, limit: number) {
  const rows = (await ctx.tx.execute(
    sql`select substr(ref, 6) as isrc, max(created_at) as last from discord_lookups
        where ref like 'isrc:%' and created_at >= now() - interval '30 days'
          and substr(ref, 6) not in (select isrc from tracks where isrc is not null)
        group by 1 order by 2 desc limit ${Math.max(0, Math.min(MAX_DAILY_READINGS, limit))}`,
  )) as unknown as Array<{ isrc: string }>;
  return rows.map((r) => r.isrc);
}

/** Daily housekeeping across labels (system pool): old lookup logs, spent link codes, evidence past its retention. */
export async function purgeOld() {
  const db = systemDb();
  await db.delete(discordLookups).where(lt(discordLookups.createdAt, new Date(Date.now() - 180 * 86400_000)));
  await db.delete(discordLinkCodes).where(or(lt(discordLinkCodes.expiresAt, new Date(Date.now() - 86400_000)), lt(discordLinkCodes.usedAt, new Date(Date.now() - 86400_000))));
  for (const [source, days] of Object.entries(EVIDENCE_RETENTION_DAYS)) {
    const old = lt(discordEvidence.lastSeenAt, new Date(Date.now() - days * 86400_000));
    const others = Object.keys(EVIDENCE_RETENTION_DAYS).filter((s) => s !== 'default');
    await db.delete(discordEvidence).where(source === 'default' ? (others.length ? and(old, notInArray(discordEvidence.source, others)) : old) : and(old, eq(discordEvidence.source, source)));
  }
  await db.delete(discordBenchmarks).where(lt(discordBenchmarks.createdAt, new Date(Date.now() - 365 * 86400_000)));
}
