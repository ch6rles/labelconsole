import { DeadlineError, isTransient, ProviderError, RateLimitedError } from '@labelconsole/core/errors';
import { redis } from '@labelconsole/core/redis';

/**
 * A circuit breaker per source, shared by every worker through Redis. After
 * repeated outages (timeouts, 5xx, 429s) a source is paused for a while and
 * lookups answer from the others instead of waiting on it. One success
 * clears the count; one failure right after a pause pauses it again.
 *
 * Sources that use the label's own key are paused per label, so one label's
 * bad key never pauses the source for anyone else.
 */
export const BREAKER = { failures: 5, windowS: 300, pauseS: 120 };

const KEYED = new Set(['spotify', 'spotscraper', 'apple', 'discogs', 'licensed']);
const id = (source: string, scope?: string | null) => (KEYED.has(source) && scope ? `${source}:${scope}` : source);
const failKey = (k: string) => `lc:cb:fail:${k}`;
const pauseKey = (k: string) => `lc:cb:open:${k}`;

/**
 * How a source call ended, for health metrics. `busy`: skipped because no
 * request slot came free within the lookup's time budget (the source is
 * fine; Label Console is using its whole rate limit).
 */
export type SourceOutcome = 'answered' | 'no_match' | 'error' | 'rate_limited' | 'timeout' | 'busy' | 'paused' | 'skipped';

export function classify(err: unknown): Exclude<SourceOutcome, 'answered' | 'no_match' | 'paused' | 'skipped'> {
  if (err instanceof DeadlineError) return err.waiting === 'queue' ? 'busy' : 'timeout';
  if (err instanceof RateLimitedError || (err instanceof ProviderError && err.upstreamStatus === 429)) return 'rate_limited';
  const e = err as { name?: string; message?: string } | null;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError' || /timeout|timed out|aborted/i.test(e?.message ?? '')) return 'timeout';
  return 'error';
}

/** Seconds left on a pause, or null when the source may be called. Redis trouble never blocks a lookup. */
export async function pausedFor(source: string, scope?: string | null): Promise<number | null> {
  const ttl = await redis()
    .ttl(pauseKey(id(source, scope)))
    .catch(() => -2);
  return ttl > 0 ? ttl : null;
}

export async function recordSuccess(source: string, scope?: string | null) {
  await redis()
    .del(failKey(id(source, scope)))
    .catch(() => undefined);
}

/** Count an outage. Returns true when this failure paused the source. Errors that retrying can't fix (a bad request) don't count. */
export async function recordFailure(source: string, scope: string | null | undefined, err: unknown): Promise<boolean> {
  const kind = classify(err);
  if (kind === 'busy' || (!isTransient(err) && kind === 'error')) return false;
  const k = id(source, scope);
  try {
    const r = redis();
    const n = await r.incr(failKey(k));
    if (n === 1) await r.expire(failKey(k), BREAKER.windowS);
    if (n < BREAKER.failures) return false;
    await r.set(pauseKey(k), '1', 'EX', BREAKER.pauseS);
    // Half-open: the next failure after the pause pauses it again straight away.
    await r.set(failKey(k), String(BREAKER.failures - 1), 'EX', BREAKER.windowS);
    return true;
  } catch {
    return false;
  }
}

/** Sources paused right now, across labels (label-keyed ones are counted once per label). */
export async function pausedSources(): Promise<Array<{ source: string; scope: string | null; secondsLeft: number }>> {
  const out: Array<{ source: string; scope: string | null; secondsLeft: number }> = [];
  try {
    const r = redis();
    let cursor = '0';
    do {
      const [next, keys] = await r.scan(cursor, 'MATCH', 'lc:cb:open:*', 'COUNT', 200);
      cursor = next;
      for (const key of keys) {
        const ttl = await r.ttl(key);
        if (ttl <= 0) continue;
        const [source, scope] = key.slice('lc:cb:open:'.length).split(':');
        out.push({ source, scope: scope ?? null, secondsLeft: ttl });
      }
    } while (cursor !== '0');
  } catch {
    // Metrics only: an unreachable Redis shows up elsewhere.
  }
  return out;
}

/** Clear a pause by hand (Settings → Discord → Sources). */
export async function resumeSource(source: string, scope?: string | null) {
  const k = id(source, scope);
  await redis().del(pauseKey(k), failKey(k));
}
