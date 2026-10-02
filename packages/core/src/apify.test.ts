import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApifyClient } from './apify';
import { ProviderError } from './errors';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('ApifyClient', () => {
  it('runs an Actor synchronously and returns at most maxItems items', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), init });
        return json([{ id: 1 }, { id: 2 }, { id: 3 }]);
      }),
    );
    const client = new ApifyClient('apify_api_test');
    const items = await client.run('clockworks/tiktok-scraper', { profiles: ['someone'] }, { maxItems: 2, timeoutSecs: 60 });
    expect(items).toEqual([{ id: 1 }, { id: 2 }]);
    expect(client.results).toBe(2);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.apify.com/v2/acts/clockworks~tiktok-scraper/run-sync-get-dataset-items?timeout=60&maxItems=2');
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer apify_api_test');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ profiles: ['someone'] });
  });

  it('waits and retries when the plan’s concurrent-run limit is reached', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ error: { type: 'concurrent-runs-limit-exceeded', message: 'By launching this job you will exceed the concurrent runs limit' } }, 402))
      .mockResolvedValueOnce(json([{ ok: true }]));
    vi.stubGlobal('fetch', fetch);
    const pending = new ApifyClient('t').run('apify/instagram-scraper', {}, { maxItems: 5 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toEqual([{ ok: true }]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('explains token, credit and Actor problems, and never starts a paid run twice on a server error', async () => {
    const client = new ApifyClient('t');
    const failWith = async (status: number, body: unknown) => {
      vi.stubGlobal('fetch', vi.fn(async () => json(body, status)));
      return client.run('a/b', {}, { maxItems: 1 }).then(
        () => {
          throw new Error('expected the run to fail');
        },
        (e: unknown) => e as ProviderError,
      );
    };
    const refused = await failWith(401, { error: { type: 'user-or-token-not-found' } });
    expect(refused).toBeInstanceOf(ProviderError);
    expect(refused.message).toMatch(/refused the API token/);
    expect(refused.transient).toBe(false);
    expect((await failWith(402, { error: { type: 'not-enough-usage-to-run-paid-actor' } })).message).toMatch(/no credit left/);
    expect((await failWith(404, { error: { type: 'record-not-found' } })).message).toMatch(/Actor a\/b was not found/);

    const fetch = vi.fn(async () => json({ error: 'boom' }, 500));
    vi.stubGlobal('fetch', fetch);
    await expect(client.run('a/b', {}, { maxItems: 1 })).rejects.toBeInstanceOf(ProviderError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
