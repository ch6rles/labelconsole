import { RateLimitedError } from './errors';
import { redis } from './redis';

/**
 * Token bucket in Redis, shared by every web and worker process. Used for
 * per-provider limits (MusicBrainz 1 rps, Deezer 50 per 5 s, YouTube quota),
 * per-tool and per-org limits for agents, and per-user API limits.
 */
const SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_per_ms = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local state = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])
if tokens == nil then tokens = capacity; ts = now end
local elapsed = math.max(0, now - ts)
tokens = math.min(capacity, tokens + elapsed * refill_per_ms)
local allowed = 0
local wait = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  wait = math.ceil((cost - tokens) / refill_per_ms)
end
redis.call('HMSET', key, 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', key, math.ceil(capacity / refill_per_ms) + 1000)
return {allowed, wait}
`;

export type BucketSpec = { capacity: number; refillPerSec: number };

export async function tryAcquire(key: string, spec: BucketSpec, cost = 1): Promise<{ allowed: boolean; waitMs: number }> {
  const res = (await redis().eval(SCRIPT, 1, `lc:rl:${key}`, spec.capacity, spec.refillPerSec / 1000, Date.now(), cost)) as [number, number];
  return { allowed: res[0] === 1, waitMs: res[1] };
}

/**
 * Wait for a token up to `maxWaitMs`, then give up with RateLimitedError so the
 * caller (an agent run or a job) can reschedule instead of spinning.
 */
export async function acquire(key: string, spec: BucketSpec, opts: { cost?: number; maxWaitMs?: number; signal?: AbortSignal } = {}) {
  const deadline = Date.now() + (opts.maxWaitMs ?? 10_000);
  for (;;) {
    const { allowed, waitMs } = await tryAcquire(key, spec, opts.cost ?? 1);
    if (allowed) return;
    if (Date.now() + waitMs > deadline) throw new RateLimitedError(waitMs, `Rate limit on ${key}`);
    await new Promise((r) => setTimeout(r, Math.min(waitMs, 1000)));
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  }
}
