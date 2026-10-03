import type { ServiceContext } from './context';
import { env } from './env';
import { isTransient, ProviderError } from './errors';
import { fetchJson } from './http';
import type { ToolContext } from './tools';
import { recordUsage } from './usage';
import { getCredentialHandle, readSecret } from './vault';

/**
 * Apify (https://apify.com): runs scraper Actors and returns their dataset
 * items. Used for social research (TikTok, Instagram, YouTube). Runs are
 * synchronous: one request starts the Actor, waits for it and returns the
 * results, so a tool call is one round trip.
 *
 * Callers normalise items before anything reaches an agent; raw items never
 * leave the module that asked for them.
 */
const API = 'https://api.apify.com/v2';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ApifyClient {
  /** Dataset items returned by this client, for usage accounting (Actors bill per result). */
  results = 0;

  constructor(private readonly token: string) {}

  /**
   * Run an Actor and return up to `maxItems` items. The Free plan allows five
   * runs at a time; a run refused for that waits and retries, so several agents
   * scraping at once queue instead of failing.
   */
  async run<T = Record<string, unknown>>(actorId: string, input: Record<string, unknown>, opts: { maxItems: number; timeoutSecs?: number; signal?: AbortSignal }): Promise<T[]> {
    const timeoutSecs = Math.min(opts.timeoutSecs ?? 240, 290);
    const url = `${API}/acts/${actorId.replace('/', '~')}/run-sync-get-dataset-items?timeout=${timeoutSecs}&maxItems=${opts.maxItems}`;
    for (let attempt = 0; ; attempt++) {
      try {
        const items = await fetchJson<T[]>(url, {
          provider: 'apify',
          method: 'POST',
          headers: { authorization: `Bearer ${this.token}` },
          body: input,
          timeoutMs: (timeoutSecs + 20) * 1000,
          // A paid run must not be started twice because a response was slow.
          retries: 0,
          signal: opts.signal,
        });
        const list = Array.isArray(items) ? items.slice(0, opts.maxItems) : [];
        this.results += list.length;
        return list;
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        const status = err.upstreamStatus;
        if (status === 402 && /concurrent/i.test(err.message) && attempt < 5) {
          await sleep(5_000 * (attempt + 1));
          continue;
        }
        if (status === 401 || status === 403) throw new ProviderError('apify', 'Apify refused the API token. Update it under Settings → Integrations.', { status, transient: false });
        if (status === 402) throw new ProviderError('apify', 'The Apify account has no credit left for this run (check usage at console.apify.com).', { status, transient: false });
        if (status === 404) throw new ProviderError('apify', `Apify Actor ${actorId} was not found`, { status, transient: false });
        throw err;
      }
    }
  }
}

/* -------------------------------------------------------- credentials -- */

type Factory = (ctx: ServiceContext) => Promise<ApifyClient | null>;
let override: Factory | null = null;

/** Tests swap in a client backed by recorded items here. */
export function setApifyFactory(f: Factory | null) {
  override = f;
}

/** Whether Apify is available to this label, without decrypting anything (safe in the web process). */
export async function apifyConfigured(ctx: ServiceContext): Promise<boolean> {
  if (override) return Boolean(await override(ctx));
  if (env().APIFY_API_TOKEN) return true;
  return Boolean(await getCredentialHandle(ctx, 'apify'));
}

/** The label's own token from the vault, else the platform token, else null. Worker only for vault tokens. */
export async function apifyFor(ctx: ServiceContext): Promise<ApifyClient | null> {
  if (override) return override(ctx);
  if (await getCredentialHandle(ctx, 'apify')) {
    const own = await readSecret(ctx, 'apify');
    if (own?.secret.apiKey) return new ApifyClient(own.secret.apiKey);
  }
  const token = env().APIFY_API_TOKEN;
  return token ? new ApifyClient(token) : null;
}

export const NO_APIFY_TOKEN = 'No Apify token is configured for this label. Add one under Settings → Integrations → Apify, or set APIFY_API_TOKEN for the platform.';

/**
 * One Actor run for an agent tool: the label's token, results counted in its
 * usage, and a slow or failed run reported to the agent instead of retried,
 * since every retry would pay for the scrape again.
 */
export async function runActorForTool(t: ToolContext, actorId: string, input: Record<string, unknown>, opts: { maxItems: number; what: string }): Promise<unknown[]> {
  const client = await t.withOrg((ctx) => apifyFor(ctx));
  if (!client) throw new ProviderError('apify', NO_APIFY_TOKEN, { transient: false });
  try {
    return await client.run(actorId, input, { maxItems: opts.maxItems, timeoutSecs: 240, signal: t.signal });
  } catch (err) {
    if (isTransient(err)) throw new ProviderError('apify', `The ${opts.what} did not finish (${(err as Error).message}). Try again with a smaller limit, or later.`, { transient: false });
    throw err;
  } finally {
    if (client.results) await t.withOrg((ctx) => recordUsage(ctx, 'apify_results', client.results));
  }
}

