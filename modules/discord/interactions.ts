import './types';
import { eq } from 'drizzle-orm';
import { memberAccess } from '@labelconsole/core/auth';
import { systemDb } from '@labelconsole/core/db/client';
import { organizations } from '@labelconsole/core/db/schema';
import { env } from '@labelconsole/core/env';
import { logger } from '@labelconsole/core/logger';
import { enabledModuleIds } from '@labelconsole/core/modules';
import { enqueue } from '@labelconsole/core/queue';
import { tryAcquire } from '@labelconsole/core/ratelimit';
import { normalizeIsrc, normalizeUpc, parseInput } from '@labelconsole/catalogue/service';
import { MESSAGE_COMMAND } from './protocol/commands';
import { InteractionType, MessageFlags, ResponseType, type DiscordUser, type Interaction, type InteractionResponse, type MessagePayload } from './protocol/types';
import { verifyDiscordSignature } from './protocol/verify';
import { parseCustomId } from './render';
import { appForApplicationId, findLink, redeemLinkCode, unlinkDiscordUser, USE_PERMISSION, type DiscordApp } from './service';
import type { DiscordAction } from './types';

/**
 * The HTTPS endpoint Discord sends interactions to. Discord needs an answer
 * within 3 seconds, so anything slow is handed to the worker: commands get a
 * deferred (ephemeral) reply that the worker later edits.
 */
const MAX_BODY = 512 * 1024;
/** Signed requests older than this are refused, so a captured request cannot be replayed later. */
const MAX_AGE_MS = 5 * 60_000;
/** Budget for each Redis call, well inside Discord's 3 second limit. */
const REDIS_BUDGET_MS = 1500;

const unauthorized = () => new Response('invalid request signature', { status: 401 });
const respond = (body: InteractionResponse) => Response.json(body, { headers: { 'cache-control': 'no-store' } });

/** A private reply only the person who used the command sees. */
export const ephemeral = (content: string, extra: Partial<MessagePayload> = {}): InteractionResponse => ({
  type: ResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
  data: { content, flags: MessageFlags.EPHEMERAL, allowed_mentions: { parse: [] }, ...extra },
});

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timed out')), ms).unref?.())]);
}

export async function handleInteraction(req: Request): Promise<Response> {
  const signature = req.headers.get('x-signature-ed25519') ?? '';
  const timestamp = req.headers.get('x-signature-timestamp') ?? '';
  if (!signature || !timestamp) return unauthorized();
  const body = Buffer.from(await req.arrayBuffer());
  if (body.length > MAX_BODY) return unauthorized();
  let interaction: Interaction;
  try {
    interaction = JSON.parse(body.toString('utf8')) as Interaction;
  } catch {
    return unauthorized();
  }
  // The payload names its application; only that application's public key can have signed it.
  const app = typeof interaction?.application_id === 'string' ? await appForApplicationId(interaction.application_id) : null;
  if (!app || !verifyDiscordSignature(app.publicKey, signature, timestamp, body)) return unauthorized();
  if (Math.abs(Date.now() - Number(timestamp) * 1000) > MAX_AGE_MS) return unauthorized();

  if (interaction.type === InteractionType.PING) return respond({ type: ResponseType.PONG });
  try {
    return respond(await dispatch(app, interaction));
  } catch (err) {
    logger.error({ err, interactionType: interaction.type }, 'discord interaction failed');
    return respond(ephemeral('Something went wrong in Label Console. Try again in a moment.'));
  }
}

const consoleUrl = () => `${env().APP_URL.replace(/\/$/, '')}/settings/discord`;
const displayName = (u: DiscordUser) => u.global_name || u.username;

/** A string option on one line: Discord lets string options span several lines. */
function option(i: Interaction, name: string) {
  const v = i.data?.options?.find((o) => o.name === name)?.value;
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
}

async function dispatch(app: DiscordApp, i: Interaction): Promise<InteractionResponse> {
  const user = i.member?.user ?? i.user;
  if (!user?.id) return ephemeral('Discord did not say who you are, so Label Console cannot answer.');
  const [org] = await systemDb().select({ id: organizations.id, plan: organizations.plan, name: organizations.name }).from(organizations).where(eq(organizations.id, app.orgId));
  if (!org || !(await enabledModuleIds(systemDb(), org)).has('discord')) return ephemeral('The Discord app is switched off for this label in Label Console.');

  if (i.type === InteractionType.AUTOCOMPLETE) return { type: ResponseType.AUTOCOMPLETE_RESULT, data: { choices: [] } };

  if (i.type === InteractionType.APPLICATION_COMMAND) {
    const name = i.data?.name;
    if (name === 'link') return linkCommand(app, user, option(i, 'code'));
    if (name === 'unlink') {
      const removed = await unlinkDiscordUser(app.orgId, user.id);
      return ephemeral(removed ? 'Your Discord account is no longer linked to Label Console.' : "Your Discord account wasn't linked.");
    }
    let action: DiscordAction;
    if (name === 'song') {
      const input = option(i, 'query');
      if (!input) return ephemeral('Add a link, ISRC, UPC or "Artist - Title" to look up.');
      action = { kind: 'lookup', input: input.slice(0, 300), artist: option(i, 'artist').slice(0, 100) || null };
    } else if (name === MESSAGE_COMMAND) {
      const input = songInMessage(i);
      if (!input) return ephemeral('That message has no song link, ISRC or UPC in it.');
      action = { kind: 'lookup', input };
    } else {
      return ephemeral('Label Console does not know this command. An admin can refresh the commands under Settings → Discord.');
    }
    return defer(app, i, user, action, { type: ResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: MessageFlags.EPHEMERAL } });
  }

  if (i.type === InteractionType.MESSAGE_COMPONENT) {
    const action = parseCustomId(i.data?.custom_id ?? '', i.data?.values);
    if (!action) return ephemeral('That button no longer works. Run /song again.');
    // A pick replaces the list at once (no double picks); a view switch keeps the card until the new one is ready.
    const ack: InteractionResponse =
      action.kind === 'pick'
        ? { type: ResponseType.UPDATE_MESSAGE, data: { content: 'Looking it up…', embeds: [], components: [], allowed_mentions: { parse: [] } } }
        : { type: ResponseType.DEFERRED_UPDATE_MESSAGE };
    return defer(app, i, user, action, ack);
  }

  return ephemeral('Label Console cannot handle that kind of interaction.');
}

/** Check the member, rate-limit, hand the work to the worker, and acknowledge Discord. */
async function defer(app: DiscordApp, i: Interaction, user: DiscordUser, action: DiscordAction, ack: InteractionResponse): Promise<InteractionResponse> {
  const link = await findLink(app.orgId, user.id);
  if (!link) {
    return ephemeral(`Link your Discord account first: in Label Console open Settings → Discord, get a code, then run \`/link\` with it.\n${consoleUrl()}`);
  }
  const access = await memberAccess(link.userId, app.orgId);
  if (!access) return ephemeral('The Label Console account linked to your Discord is no longer a member of this label.');
  if (!access.permissions.has(USE_PERMISSION)) return ephemeral("Your role in Label Console doesn't include the catalogue, so lookups aren't available to you.");

  const rl = await withTimeout(tryAcquire(`discord:user:${user.id}`, { capacity: 8, refillPerSec: 1 / 5 }), REDIS_BUDGET_MS).catch(() => null);
  if (!rl) return ephemeral('Label Console is busy right now. Try again in a moment.');
  if (!rl.allowed) return ephemeral(`That's a lot of lookups at once. Try again in ${Math.ceil(rl.waitMs / 1000)} seconds.`);

  try {
    await withTimeout(
      enqueue(
        'discord.interaction',
        app.orgId,
        { interaction: { id: i.id, applicationId: app.applicationId, token: i.token }, userId: link.userId, discordUserId: user.id, action },
        // The token expires after 15 minutes, so there is no point in retrying later; keep it out of Redis soon after.
        { jobId: `discord-${i.id}`, attempts: 1, removeOnComplete: { age: 900 }, removeOnFail: { age: 3600 } },
      ),
      REDIS_BUDGET_MS,
    );
  } catch (err) {
    logger.warn({ err }, 'could not queue a Discord lookup');
    return ephemeral('Label Console is busy right now. Try again in a moment.');
  }
  return ack;
}

async function linkCommand(app: DiscordApp, user: DiscordUser, code: string): Promise<InteractionResponse> {
  const rl = await withTimeout(tryAcquire(`discord:link:${user.id}`, { capacity: 5, refillPerSec: 1 / 120 }), REDIS_BUDGET_MS).catch(() => null);
  if (!rl) return ephemeral('Label Console is busy right now. Try again in a moment.');
  if (!rl.allowed) return ephemeral('Too many link attempts. Wait a few minutes, then get a new code.');
  const result = await redeemLinkCode(app.orgId, code, { id: user.id, username: displayName(user) });
  if (!result.ok) return ephemeral(result.message);
  return ephemeral(`Linked. Your Discord account now acts as **${result.userName}** in ${result.orgName}. Try \`/song\` with a link, ISRC, UPC or "Artist - Title".`);
}

/**
 * The song a message points at, for "Look Up Song": the first supported link,
 * then an ISRC or UPC anywhere in it, then a short single-line message as text.
 */
export function songInMessage(i: Interaction): string | null {
  const target = i.data?.target_id ? i.data.resolved?.messages?.[i.data.target_id] : undefined;
  if (!target) return null;
  // A forwarded message keeps its text in a snapshot, with the top-level content empty.
  const msg = target.content?.trim() ? target : (target.message_snapshots?.[0]?.message ?? target);
  const texts = [msg.content ?? '', ...(msg.embeds ?? []).flatMap((e) => [e.url ?? '', e.title ?? '', e.description ?? ''])];
  const all = texts.join('\n');
  for (const m of all.matchAll(/https?:\/\/[^\s<>()]+/g)) {
    const parsed = parseInput(m[0].replace(/[.,!?]+$/, ''));
    if (parsed && parsed.kind !== 'text') return m[0].replace(/[.,!?]+$/, '');
  }
  for (const m of all.matchAll(/\b[A-Za-z]{2}-?[A-Za-z0-9]{3}-?\d{2}-?\d{5}\b/g)) {
    const isrc = normalizeIsrc(m[0]);
    if (isrc) return isrc;
  }
  for (const m of all.matchAll(/\b\d{12,14}\b/g)) {
    const upc = normalizeUpc(m[0]);
    if (upc) return upc;
  }
  const content = (msg.content ?? '').trim();
  return content && content.length <= 120 && !content.includes('\n') && !/https?:\/\//.test(content) ? content : null;
}
