/** spotifyId: the track on Spotify, when the source lists it (lets Streams poll it without an ISRC search). */
export type SourceTrack = { title: string; isrc: string | null; durationMs: number | null; position: number; explicit: boolean | null; artists: string[]; spotifyId?: string | null };
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
  /** Cover art hosted by the source (an https URL on its CDN). */
  artworkUrl?: string | null;
  /** A short public preview of the recording (Deezer's 30 seconds). */
  previewUrl?: string | null;
  /** Countries (ISO 3166-1 alpha-2) where the source says the track can be played. */
  availableCountries?: string[];
  /** The platform's own all-time play count, as shown publicly (Spotify via SpotScraper). */
  playCount?: number | null;
  catalogNumber?: string | null;
  /** Companies a source credits on the release (Discogs: "Distributed By", "Licensed From", ℗/© holders…). */
  companies?: Array<{ role: string; name: string }>;
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
