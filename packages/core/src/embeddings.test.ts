import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMBEDDING_DIMENSIONS, toVectorLiteral, VoyageProvider } from './embeddings';
import { ProviderError, RateLimitedError } from './errors';

const vec = (seed: number) => Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === seed ? 1 : 0));
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

afterEach(() => vi.unstubAllGlobals());

describe('VoyageProvider', () => {
  it('sends the documented request and returns vectors in input order', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      // Out of order on purpose: the provider must sort by index.
      return json({ object: 'list', data: body.input.map((_: string, i: number) => ({ embedding: vec(i), index: i })).reverse(), model: body.model, usage: { total_tokens: 7 } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const out = await new VoyageProvider('vk-test', 'voyage-4').embed(['first', 'second'], 'document');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.voyageai.com/v1/embeddings');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer vk-test');
    expect(JSON.parse(String(init.body))).toEqual({ input: ['first', 'second'], model: 'voyage-4', input_type: 'document', output_dimension: 1024 });
    expect(out.vectors.map((v) => v.indexOf(1))).toEqual([0, 1]);
    expect(out.tokens).toBe(7);
  });

  it('batches large inputs', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return json({ data: body.input.map((_: string, i: number) => ({ embedding: vec(i), index: i })), model: 'voyage-4', usage: { total_tokens: body.input.length } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const out = await new VoyageProvider('vk', 'voyage-4').embed(Array.from({ length: 150 }, (_, i) => `memory ${i}`), 'document');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(out.vectors).toHaveLength(150);
    expect(out.tokens).toBe(150);
  });

  it('reports a rejected key plainly, backs off on rate limits, and refuses malformed vectors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ detail: 'bad key' }, 401)));
    const rejected = await new VoyageProvider('bad', 'voyage-4').embed(['x'], 'query').catch((e: unknown) => e);
    expect(rejected).toBeInstanceOf(ProviderError);
    expect((rejected as ProviderError).transient).toBe(false);
    expect((rejected as Error).message).toMatch(/Voyage AI key was rejected/);

    vi.stubGlobal('fetch', vi.fn(async () => json({ detail: 'slow down' }, 429, { 'retry-after': '0' })));
    await expect(new VoyageProvider('k', 'voyage-4').embed(['x'], 'query')).rejects.toBeInstanceOf(RateLimitedError);

    vi.stubGlobal('fetch', vi.fn(async () => json({ data: [{ embedding: [0.1, 0.2], index: 0 }], model: 'voyage-4' })));
    await expect(new VoyageProvider('k', 'voyage-4').embed(['x'], 'query')).rejects.toThrow(/Unexpected embeddings response/);
  });

  it('formats pgvector literals', () => {
    expect(toVectorLiteral([0.5, -1, Number.NaN])).toBe('[0.5,-1,0]');
  });
});
