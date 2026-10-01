import type { Redis } from 'ioredis';
import { logger } from './logger';
import { createRedis, redis } from './redis';

/**
 * Realtime channel per org, fed by Redis pub/sub. Workers publish agent steps,
 * stream alerts and job progress; the web app's SSE endpoint fans them out to
 * open browsers. One subscriber connection per web process, shared by all
 * open streams.
 */
export type RealtimeMessage = {
  type: string;
  data: Record<string, unknown>;
  /** Restrict delivery to one user (notifications); omit for the whole org. */
  userId?: string;
  at?: string;
};

const channelFor = (orgId: string) => `lc:rt:${orgId}`;

export async function publish(orgId: string, message: RealtimeMessage) {
  const payload = JSON.stringify({ ...message, at: message.at ?? new Date().toISOString() });
  await redis().publish(channelFor(orgId), payload);
}

type Listener = (msg: RealtimeMessage) => void;

class RealtimeHub {
  private sub: Redis | undefined;
  private listeners = new Map<string, Set<Listener>>();

  private ensure() {
    if (this.sub) return this.sub;
    this.sub = createRedis();
    this.sub.on('pmessage', (_pattern, channel, raw) => {
      const orgId = channel.slice('lc:rt:'.length);
      const set = this.listeners.get(orgId);
      if (!set?.size) return;
      let msg: RealtimeMessage;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      for (const l of set) {
        try {
          l(msg);
        } catch (err) {
          logger.warn({ err }, 'realtime listener threw');
        }
      }
    });
    void this.sub.psubscribe('lc:rt:*');
    return this.sub;
  }

  subscribe(orgId: string, listener: Listener): () => void {
    this.ensure();
    let set = this.listeners.get(orgId);
    if (!set) {
      set = new Set();
      this.listeners.set(orgId, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.listeners.delete(orgId);
    };
  }

  async close() {
    await this.sub?.quit().catch(() => undefined);
    this.sub = undefined;
    this.listeners.clear();
  }
}

const globalForHub = globalThis as unknown as { __lcRealtimeHub?: RealtimeHub };
export const realtimeHub: RealtimeHub = globalForHub.__lcRealtimeHub ?? (globalForHub.__lcRealtimeHub = new RealtimeHub());
