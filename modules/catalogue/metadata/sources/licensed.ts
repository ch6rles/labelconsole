import type { Query, SourceResult } from './types';

/**
 * Licensed data provider adapter. The vendor (Chartmetric, Songstats,
 * Soundcharts...) is chosen after a pricing and terms review; each vendor
 * implements this interface in its own file and is registered below.
 * Until a vendor is configured the source reports itself as skipped.
 */
export type LicensedSecret = { vendor: string; baseUrl: string; apiKey: string };

export interface LicensedMetadataProvider {
  vendor: string;
  lookup(secret: LicensedSecret, q: Query): Promise<SourceResult | null>;
}

const providers = new Map<string, LicensedMetadataProvider>();

export function registerLicensedMetadataProvider(p: LicensedMetadataProvider) {
  providers.set(p.vendor.toLowerCase(), p);
}

export function licensedMetadataProvider(vendor: string | undefined) {
  return vendor ? providers.get(vendor.toLowerCase()) ?? null : null;
}
