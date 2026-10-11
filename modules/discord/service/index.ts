import '../types';
import { createHmac, randomInt } from 'node:crypto';
import { and, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { memberAccess } from '@labelconsole/core/auth';
import { withOrg, withSystemOrg, type ServiceContext } from '@labelconsole/core/context';
import { systemDb } from '@labelconsole/core/db/client';
import { credentials, users } from '@labelconsole/core/db/schema';
import { env } from '@labelconsole/core/env';
import { ForbiddenError, NotFoundError, ValidationError } from '@labelconsole/core/errors';
import { enqueueAfterCommit } from '@labelconsole/core/queue';
import { getCredentialHandle } from '@labelconsole/core/vault';
import { isPublicKeyHex, isSnowflake } from '../protocol/verify';
import { discordLinkCodes, discordLinks, discordState } from '../schema';

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

/** Anyone may remove their own link; removing someone else's needs member management rights. */
export async function removeLink(ctx: ServiceContext, id: string) {
  const [link] = await ctx.tx.select().from(discordLinks).where(eq(discordLinks.id, id));
  if (!link) throw new NotFoundError('Discord link');
  if (!(ctx.actor.type === 'user' && ctx.actor.id === link.userId)) ctx.assert('settings:members');
  await ctx.tx.delete(discordLinks).where(eq(discordLinks.id, id));
  await ctx.audit({ action: 'discord.unlinked', module: 'discord', targetType: 'user', targetId: link.userId, targetLabel: link.discordUsername, before: { discordUsername: link.discordUsername } });
  return { ok: true };
}

/* ------------------------------------------------------------ the app -- */

export type DiscordApp = { orgId: string; applicationId: string; publicKey: string };

const appCache = new Map<string, { at: number; app: DiscordApp | null }>();
const APP_CACHE_MS = 30_000;
/** Short, so saving the integration and then the endpoint URL in Discord works straight away. */
const UNKNOWN_APP_CACHE_MS = 5_000;

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
