import type { Snapshot, StreamSourceAdapter, TrackRef } from './types';

/**
 * Licensed stream data (Spotify and other DSP counts) from a vendor such as
 * Chartmetric, Songstats or Soundcharts. No vendor is chosen yet: that waits
 * on a pricing and terms review (SaaS use and AI-agent use must both be
 * allowed). A vendor plugs in by implementing `LicensedStreamProvider` in its
 * own file and calling `registerLicensedStreamProvider`; nothing else changes.
 *
 * Tracks are matched to the vendor by ISRC, so `externalId` here is the ISRC
 * (or the vendor's own track ID once `resolve` has run).
 */
export type LicensedStreamSecret = { vendor: string; baseUrl: string; apiKey: string };

export interface LicensedStreamProvider {
  vendor: string;
  /** Platforms the vendor reports counts for, e.g. ['spotify', 'apple_music']. */
  platforms: string[];
  /** Map ISRCs to the vendor's track IDs. */
  resolve?(secret: LicensedStreamSecret, isrcs: string[], signal?: AbortSignal): Promise<Map<string, string>>;
  /** Cumulative counts for each ref, one entry per platform the vendor covers. */
  counts(secret: LicensedStreamSecret, refs: TrackRef[], signal?: AbortSignal): Promise<Array<{ ref: TrackRef; platform: string; count: number; capturedAt?: Date }>>;
}

const providers = new Map<string, LicensedStreamProvider>();

export function registerLicensedStreamProvider(p: LicensedStreamProvider) {
  providers.set(p.vendor.toLowerCase(), p);
}

export function licensedStreamProvider(vendor: string | undefined | null) {
  return vendor ? providers.get(vendor.toLowerCase()) ?? null : null;
}

export class LicensedProviderNotConfigured extends Error {
  constructor(vendor?: string | null) {
    super(vendor ? `No adapter is installed for the licensed vendor "${vendor}"` : 'No licensed stream data provider is configured');
  }
}

export const licensedAdapter: StreamSourceAdapter<LicensedStreamSecret> = {
  id: 'licensed-provider',
  async fetch(secret, refs, opts) {
    const provider = licensedStreamProvider(secret.vendor);
    if (!provider) throw new LicensedProviderNotConfigured(secret.vendor);
    const rows = await provider.counts(secret, refs, opts?.signal);
    const capturedAt = new Date();
    const snapshots: Snapshot[] = rows.map((r) => ({ trackId: r.ref.trackId, platform: r.platform, source: 'licensed-provider', externalId: r.ref.externalId, capturedAt: r.capturedAt ?? capturedAt, count: r.count }));
    const seen = new Set(rows.map((r) => r.ref.trackId));
    return { snapshots, missing: refs.filter((r) => !seen.has(r.trackId)) };
  },
};
