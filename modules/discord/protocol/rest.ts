import { fetchJson } from '@labelconsole/core/http';
import { ProviderError } from '@labelconsole/core/errors';
import { commandDefinitions } from './commands';
import { IntegrationType } from './types';
import { isSnowflake } from './verify';
import type { MessageFile, MessagePayload } from './types';

const API = 'https://discord.com/api/v10';
/** Discord asks every caller to identify itself this way, or requests may be blocked. */
const USER_AGENT = 'DiscordBot (https://labelconsole.app, 0.1)';

function webhookPath(applicationId: string, token: string) {
  if (!isSnowflake(applicationId) || !/^[\w.-]{20,500}$/.test(token)) throw new Error('Malformed interaction reference');
  return `${API}/webhooks/${applicationId}/${token}/messages/@original`;
}

/**
 * Replace the reply to an interaction (after a deferred response). Needs no
 * bot token: the interaction token is the credential, valid for 15 minutes.
 * Returns false when Discord no longer knows the interaction.
 */
export async function editOriginal(applicationId: string, token: string, message: MessagePayload, files: MessageFile[] = []): Promise<boolean> {
  if (files.length) return editWithFiles(webhookPath(applicationId, token), message, files);
  const res = await fetchJson(webhookPath(applicationId, token), {
    provider: 'discord',
    method: 'PATCH',
    headers: { 'user-agent': USER_AGENT },
    // Without explicit allowed_mentions an edit is parsed with the default (user pings allowed).
    body: { ...message, allowed_mentions: { parse: [] } },
    retries: 2,
    timeoutMs: 10_000,
    allow404: true,
  });
  return res !== null;
}

/**
 * The same edit with files attached (multipart: `payload_json` plus
 * `files[n]`). fetchJson sends JSON only, so this one call uses fetch directly;
 * a 404 means the interaction is gone, like above.
 */
async function editWithFiles(url: string, message: MessagePayload, files: MessageFile[]): Promise<boolean> {
  const form = new FormData();
  const payload: MessagePayload = { ...message, allowed_mentions: { parse: [] }, attachments: files.map((f, i) => ({ id: i, filename: f.name, ...(f.description ? { description: f.description } : {}) })) };
  form.append('payload_json', JSON.stringify(payload));
  files.forEach((f, i) => form.append(`files[${i}]`, new Blob([new Uint8Array(f.data)], { type: f.contentType }), f.name));
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { method: 'PATCH', headers: { 'user-agent': USER_AGENT }, body: form, signal: AbortSignal.timeout(20_000) });
    if (res.status === 404) return false;
    if (res.ok) return true;
    const retryAfter = Number(res.headers.get('retry-after') ?? 0);
    if (res.status !== 429 && res.status < 500) throw new ProviderError('discord', `HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`, { status: res.status });
    await new Promise((r) => setTimeout(r, Math.min(10_000, retryAfter ? retryAfter * 1000 : 500 * 2 ** attempt)));
  }
  throw new ProviderError('discord', 'Discord did not accept the upload', { transient: true });
}

/**
 * Overwrite the app's global commands with this module's set. Commands may
 * only name install types the app has switched on (Installation page), so
 * those are read from the app first.
 */
export async function registerCommands(applicationId: string, botToken: string) {
  if (!isSnowflake(applicationId)) throw new Error('The Discord application ID should be a long number');
  const auth = { authorization: `Bot ${botToken.trim()}`, 'user-agent': USER_AGENT };
  const app = await fetchJson<{ id: string; integration_types_config?: Record<string, unknown> }>(`${API}/applications/@me`, { provider: 'discord', headers: auth, retries: 2, timeoutMs: 15_000 });
  if (app && app.id !== applicationId) throw new Error('The bot token belongs to a different Discord application than the application ID');
  const enabled = Object.keys(app?.integration_types_config ?? {})
    .map(Number)
    .filter((t) => t === IntegrationType.GUILD_INSTALL || t === IntegrationType.USER_INSTALL);
  if (!enabled.length) throw new Error('Turn on User Install (or Guild Install) on the Installation page of the Discord app first');
  return fetchJson<Array<{ id: string; name: string }>>(`${API}/applications/${applicationId}/commands`, {
    provider: 'discord',
    method: 'PUT',
    headers: auth,
    body: commandDefinitions(enabled),
    retries: 2,
    timeoutMs: 15_000,
  });
}
