export type SourceTrack = { title: string; isrc: string | null; durationMs: number | null; position: number; explicit: boolean | null; artists: string[] };
export type PlatformRef = { platform: string; entity: 'track' | 'release'; externalId: string; url: string | null; source: string };

/** One source's normalised answer. Every field optional: sources know different things. */
export type SourceResult = {
  source: string;
  isrc?: string | null;
  upc?: string | null;
  title?: string | null;
  artists?: string[];
  releaseTitle?: string | null;
  releaseType?: string | null;
  releaseDate?: string | null;
  labelName?: string | null;
  pLine?: string | null;
  cLine?: string | null;
  durationMs?: number | null;
  explicit?: boolean | null;
  tracks?: SourceTrack[];
  platformIds?: PlatformRef[];
  /** A distributor field reported directly by the source (licensed providers). */
  distributor?: string | null;
  /** Label names from MusicBrainz label relationships. */
  labels?: string[];
};

export type Query = { isrc?: string | null; upc?: string | null; title?: string | null; artist?: string | null };

export const normType = (t: string | null | undefined): string | null => {
  if (!t) return null;
  const s = t.toLowerCase();
  if (s === 'compile' || s === 'compilation') return 'compilation';
  if (s === 'ep') return 'ep';
  if (s === 'single') return 'single';
  if (s === 'album') return 'album';
  return null;
};
