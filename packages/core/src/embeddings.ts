import type { ServiceContext } from './context';
import { env } from './env';
import { ProviderError, RateLimitedError } from './errors';
import { fetchJson } from './http';
import { getCredentialHandle, readSecret } from './vault';

/**
 * Text embeddings for semantic recall (agent memory). Anthropic has no
 * embedding model and recommends Voyage AI, so that is the provider here; the
 * interface keeps another one swappable. Vectors are 1024-dimensional to match
 * the `vector(1024)` columns, and Voyage returns them normalised to length 1,
 * so cosine similarity and dot product rank the same.
 */
export const EMBEDDING_DIMENSIONS = 1024;
export type EmbedKind = 'document' | 'query';

export interface EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  embed(texts: string[], kind: EmbedKind, signal?: AbortSignal): Promise<{ vectors: number[][]; tokens: number }>;
}

type VoyageResponse = { data: Array<{ embedding: number[]; index: number }>; model: string; usage?: { total_tokens?: number } };

/** Voyage keeps requests well under its per-call input and token limits at this batch size. */
const VOYAGE_BATCH = 64;

export class VoyageProvider implements EmbeddingProvider {
  readonly id = 'voyage';

  constructor(
    private readonly apiKey: string,
    readonly model: string = env().VOYAGE_MODEL,
  ) {}

  async embed(texts: string[], kind: EmbedKind, signal?: AbortSignal) {
    const vectors: number[][] = [];
    let tokens = 0;
    for (let i = 0; i < texts.length; i += VOYAGE_BATCH) {
      const batch = texts.slice(i, i + VOYAGE_BATCH);
      let res: VoyageResponse | null;
      try {
        res = await fetchJson<VoyageResponse>('https://api.voyageai.com/v1/embeddings', {
          provider: 'voyage',
          method: 'POST',
          headers: { authorization: `Bearer ${this.apiKey}` },
          // input_type matters for retrieval quality: queries and documents get different prompts.
          body: { input: batch, model: this.model, input_type: kind, output_dimension: EMBEDDING_DIMENSIONS },
          timeoutMs: 30_000,
          retries: 2,
          signal,
        });
      } catch (err) {
        if (err instanceof ProviderError && err.upstreamStatus === 429) throw new RateLimitedError(err.retryAfterMs ?? 30_000, 'Voyage AI rate limit');
        if (err instanceof ProviderError && (err.upstreamStatus === 401 || err.upstreamStatus === 403)) {
          throw new ProviderError('voyage', 'The Voyage AI key was rejected. Update it under Settings → Integrations.', { status: err.upstreamStatus, transient: false });
        }
        throw err;
      }
      const data = [...(res?.data ?? [])].sort((a, b) => a.index - b.index);
      if (data.length !== batch.length || data.some((d) => d.embedding?.length !== EMBEDDING_DIMENSIONS)) {
        throw new ProviderError('voyage', `Unexpected embeddings response (${data.length} of ${batch.length} vectors)`, { transient: false });
      }
      vectors.push(...data.map((d) => d.embedding));
      tokens += res?.usage?.total_tokens ?? 0;
    }
    return { vectors, tokens };
  }
}

type Factory = (ctx: ServiceContext) => Promise<EmbeddingProvider | null>;
let override: Factory | null = null;

/** Tests swap in a deterministic provider here; production uses Voyage. */
export function setEmbeddingProviderFactory(f: Factory | null) {
  override = f;
}

/** Whether semantic recall is available, without decrypting anything (safe in the web process). */
export async function embeddingsConfigured(ctx: ServiceContext): Promise<boolean> {
  if (override) return Boolean(await override(ctx));
  if (env().VOYAGE_API_KEY) return true;
  return Boolean(await getCredentialHandle(ctx, 'voyage'));
}

/** The model new embeddings are made with (memories embedded with another model get re-embedded). */
export function embeddingModel(): string {
  return env().VOYAGE_MODEL;
}

/**
 * The label's own Voyage key from the vault if set, else the platform key, or
 * null when neither exists (callers fall back to full-text search). Worker only
 * for vault keys.
 */
export async function embeddingProviderFor(ctx: ServiceContext): Promise<EmbeddingProvider | null> {
  if (override) return override(ctx);
  const own = await getCredentialHandle(ctx, 'voyage');
  if (own) {
    const secret = await readSecret(ctx, 'voyage');
    if (secret?.secret.apiKey) return new VoyageProvider(secret.secret.apiKey);
  }
  return env().VOYAGE_API_KEY ? new VoyageProvider(env().VOYAGE_API_KEY!) : null;
}

/** pgvector literal for a query parameter: `[0.1,0.2,...]`. */
export function toVectorLiteral(v: number[]): string {
  return `[${v.map((x) => (Number.isFinite(x) ? x : 0)).join(',')}]`;
}
