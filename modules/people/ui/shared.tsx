import type { Tone } from '@labelconsole/ui';

export const statusTone = (s: string): Tone => (s === 'active' ? 'blue' : s === 'paused' || s === 'alumni' ? 'muted' : 'neutral');
export const contractTone = (c: string): Tone => (c === 'Unsigned' || c === 'None on file' ? 'red' : c.startsWith('Expiring') ? 'ink' : 'neutral');
export const label = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Values other modules contribute to an artist row (catalogue, streams, documents). */
export type ArtistExtras = {
  releases?: number;
  liveReleases?: number;
  streams28d?: number | null;
  contract?: string;
  contractDocumentId?: string | null;
  deal?: string | null;
  split?: string | null;
  advance?: string | null;
  earned12mCents?: number | null;
  currency?: string;
};
