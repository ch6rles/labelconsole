import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeadlineError } from './errors';
import { fetchJson, withBudget } from './http';
import { tryAcquire } from './ratelimit';

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('time budgets', () => {
  it('gives up waiting for a rate-limit slot after the budget’s queue time, without calling the provider', async () => {
    const fetch = vi.fn(async () => json({ ok: true }));
    vi.stubGlobal('fetch', fetch);
    const rateLimit = { key: `budget-test-${Date.now()}`, capacity: 1, refillPerSec: 0.2 };
    expect((await tryAcquire(rateLimit.key, rateLimit)).allowed).toBe(true); // the only slot is taken
    const started = Date.now();
    const err = (await withBudget({ queueMs: 200, totalMs: 5000 }, () => fetchJson('https://api.example.test/x', { provider: 'example', rateLimit })).catch((e: unknown) => e)) as DeadlineError;
    expect(err).toBeInstanceOf(DeadlineError);
    expect(err.waiting).toBe('queue');
    expect(Date.now() - started).toBeLessThan(1500);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('cuts a slow answer, and its retries, at the budget’s total', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            const t = setTimeout(() => resolve(json({ late: true })), 5000);
            init?.signal?.addEventListener('abort', () => {
              clearTimeout(t);
              reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
            });
          }),
      ),
    );
    const started = Date.now();
    const err = (await withBudget({ queueMs: 100, totalMs: 300 }, () => fetchJson('https://api.example.test/slow', { provider: 'example' })).catch((e: unknown) => e)) as DeadlineError;
    expect(err).toBeInstanceOf(DeadlineError);
    expect(err.waiting).toBe('response');
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('leaves calls outside a budget as they were, and an inner budget never extends an outer one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ok: 1 })));
    expect(await fetchJson('https://api.example.test/ok', { provider: 'example' })).toEqual({ ok: 1 });
    const err = (await withBudget({ queueMs: 50, totalMs: 1 }, async () => {
      await new Promise((r) => setTimeout(r, 10));
      return withBudget({ queueMs: 10_000, totalMs: 10_000 }, () => fetchJson('https://api.example.test/ok', { provider: 'example' }));
    }).catch((e: unknown) => e)) as DeadlineError;
    expect(err).toBeInstanceOf(DeadlineError);
  });
});
