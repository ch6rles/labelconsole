import { Redis, type RedisOptions } from 'ioredis';
import { env } from './env';

let shared: Redis | undefined;

/** Create a dedicated connection (subscribers and BullMQ need their own). */
export function createRedis(opts: RedisOptions = {}): Redis {
  return new Redis(env().REDIS_URL, {
    // Look up IPv4 and IPv6 addresses: some private networks (Railway's older environments) are IPv6-only.
    family: 0,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
    ...opts,
  });
}

/** Shared command connection for publishing, rate limiting and caches. */
export function redis(): Redis {
  if (!shared) shared = createRedis();
  return shared;
}

export async function closeRedis() {
  if (shared) {
    await shared.quit().catch(() => shared?.disconnect());
    shared = undefined;
  }
}
