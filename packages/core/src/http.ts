import { env } from './env';
import { ProviderError } from './errors';
import { acquire, type BucketSpec } from './ratelimit';

export type FetchOptions = {
  provider: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  retries?: number;
  /** Shared token bucket so every process respects the provider's limit. */
  rateLimit?: { key: string } & BucketSpec;
  signal?: AbortSignal;
  /** Return null instead of throwing on 404. */
  allow404?: boolean;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function retryAfterMs(res: Response): number | undefined {
  const h = res.headers.get('retry-after');
  if (!h) return undefined;
  const secs = Number(h);
  if (!Number.isNaN(secs)) return secs * 1000;
  const date = Date.parse(h);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/**
 * JSON fetch for third-party APIs: timeout, retry with exponential backoff on
 * 429/5xx/network errors (honouring Retry-After), shared rate limiting and a
 * descriptive User-Agent.
 */
export async function fetchJson<T = unknown>(url: string, opts: FetchOptions): Promise<T | null> {
  const retries = opts.retries ?? 3;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (opts.rateLimit) await acquire(opts.rateLimit.key, opts.rateLimit, { maxWaitMs: 30_000, signal: opts.signal });
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 15_000);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    try {
      const res = await fetch(url, {
        method: opts.method ?? 'GET',
        headers: {
          'user-agent': env().HTTP_USER_AGENT,
          accept: 'application/json',
          ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...opts.headers,
        },
        body: opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body),
        signal,
      });
      if (res.status === 404 && opts.allow404) return null;
      if (res.ok) {
        const text = await res.text();
        return (text ? JSON.parse(text) : null) as T;
      }
      const transient = res.status === 429 || res.status >= 500;
      const wait = retryAfterMs(res);
      const body = await res.text().catch(() => '');
      lastErr = new ProviderError(opts.provider, `HTTP ${res.status} ${body.slice(0, 200)}`, { status: res.status, transient, retryAfterMs: wait });
      if (!transient || attempt === retries) throw lastErr;
      await sleep(wait ?? Math.min(30_000, 500 * 2 ** attempt + Math.random() * 250));
    } catch (err) {
      if (err instanceof ProviderError && !err.transient) throw err;
      if (opts.signal?.aborted) throw err;
      lastErr = err instanceof ProviderError ? err : new ProviderError(opts.provider, (err as Error).message ?? 'network error', { transient: true });
      if (attempt === retries) throw lastErr;
      await sleep(Math.min(30_000, 500 * 2 ** attempt + Math.random() * 250));
    }
  }
  throw lastErr;
}

/** Download bytes from an authenticated API (e.g. Google Drive file content). */
export async function fetchBinary(url: string, opts: { provider: string; headers?: Record<string, string>; timeoutMs?: number; maxBytes?: number; signal?: AbortSignal }) {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 120_000);
  const res = await fetch(url, { headers: { 'user-agent': env().HTTP_USER_AGENT, ...opts.headers }, signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout });
  if (!res.ok) throw new ProviderError(opts.provider, `HTTP ${res.status} downloading file`, { status: res.status });
  const len = Number(res.headers.get('content-length') ?? 0);
  if (opts.maxBytes && len > opts.maxBytes) throw new ProviderError(opts.provider, `File too large (${len} bytes)`, { transient: false });
  const buf = Buffer.from(await res.arrayBuffer());
  if (opts.maxBytes && buf.length > opts.maxBytes) throw new ProviderError(opts.provider, `File too large (${buf.length} bytes)`, { transient: false });
  return { body: buf, contentType: res.headers.get('content-type') ?? 'application/octet-stream' };
}
