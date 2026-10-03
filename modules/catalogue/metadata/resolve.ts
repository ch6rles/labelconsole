import { logger } from '@labelconsole/core/logger';
import type { SpotScraperClient } from '@labelconsole/core/spotscraper';
import type { DistributorEvidence, ResolvedMetadata } from '../schema';
import { inferDistributor, type Alias, type Hint } from './distributor';
import { normalizeIsrc, normalizeUpc, type ParsedInput } from './input';
import { appleLookup, itunesLookup, type AppleSecret } from './sources/apple';
import { deezerLookup, deezerSearch } from './sources/deezer';
import { licensedMetadataProvider, type LicensedSecret } from './sources/licensed';
import { musicbrainzLookup, musicbrainzSearch } from './sources/musicbrainz';
import { spotifyLookup, spotifyOEmbedTitle, type SpotifySecret } from './sources/spotify';
import { spotScraperLookup } from './sources/spotscraper';
import type { Query, SourceResult } from './sources/types';
import { splitVideoTitle, youtubeTitle } from './sources/youtube';
import type { AudioTags } from './tags';

export type ResolveCredentials = { spotify?: SpotifySecret | null; apple?: AppleSecret | null; youtubeApiKey?: string | null; licensed?: LicensedSecret | null; spotscraper?: SpotScraperClient | null };
export type ResolveContext = { creds: ResolveCredentials; aliases: Alias[]; hints: Hint[]; tags?: AudioTags | null };

/** When sources disagree, the first in this order wins and the conflict is reported. */
const PRIORITY = ['spotify', 'spotscraper', 'apple', 'deezer', 'musicbrainz', 'licensed', 'itunes', 'tags', 'search'];
const rank = (s: string) => {
  const i = PRIORITY.indexOf(s);
  return i < 0 ? PRIORITY.length : i;
};

type Field = 'isrc' | 'upc' | 'title' | 'releaseTitle' | 'releaseType' | 'releaseDate' | 'labelName' | 'pLine' | 'cLine' | 'durationMs' | 'explicit';

function canon(field: Field, v: unknown): string {
  if (v == null) return '';
  if (field === 'upc') return normalizeUpc(String(v)) ?? String(v);
  if (field === 'isrc') return normalizeIsrc(String(v)) ?? String(v);
  if (field === 'releaseDate') return String(v).slice(0, 10);
  if (field === 'durationMs') return String(Math.round(Number(v) / 2000)); // within ~2s is the same
  if (field === 'title' || field === 'releaseTitle') return String(v).toLowerCase().replace(/\s*[([].*?(remaster|version|edit|mix).*?[)\]]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  return String(v).toLowerCase().trim();
}

/** Merge per-source answers into one record, keeping disagreements visible. */
export function mergeResults(input: Record<string, string>, results: SourceResult[], ctx: Pick<ResolveContext, 'aliases' | 'hints'>, sources: ResolvedMetadata['sources']): ResolvedMetadata {
  const ordered = [...results].sort((a, b) => rank(a.source) - rank(b.source));
  const pick = <F extends Field>(field: F) => {
    const values = ordered.filter((r) => r[field] != null && r[field] !== '').map((r) => ({ source: r.source, value: r[field] as NonNullable<SourceResult[F]> }));
    return values;
  };
  const conflicts: ResolvedMetadata['conflicts'] = [];
  const choose = <F extends Field>(field: F) => {
    const values = pick(field);
    const distinct = new Set(values.map((v) => canon(field, v.value)));
    if (distinct.size > 1 && field !== 'explicit') conflicts.push({ field, values: values.map((v) => ({ source: v.source, value: String(v.value) })) });
    return values[0]?.value ?? null;
  };

  const isrc = choose('isrc');
  const upc = choose('upc');
  const releaseDate = choose('releaseDate');
  const explicit = pick('explicit').some((v) => v.value === true) ? true : pick('explicit').length ? false : null;
  const artists = ordered.find((r) => r.artists?.length)?.artists ?? [];

  // Tracklist: take the longest list and fill ISRCs and Spotify IDs from any source by position or title.
  const lists = ordered.filter((r) => r.tracks?.length).sort((a, b) => b.tracks!.length - a.tracks!.length);
  const base = lists[0]?.tracks ?? [];
  const tracks = base.map((t, i) => {
    let found = t.isrc;
    let spotifyId = t.spotifyId ?? null;
    for (const l of lists) {
      if (found && spotifyId) break;
      const match = l.tracks!.find((x) => x.position === t.position && canon('title', x.title) === canon('title', t.title)) ?? l.tracks!.find((x) => canon('title', x.title) === canon('title', t.title));
      found ??= match?.isrc ?? null;
      spotifyId ??= match?.spotifyId ?? null;
    }
    return { ...t, position: t.position || i + 1, isrc: found ? normalizeIsrc(found) : null, spotifyId };
  });

  const platformIds = new Map<string, ResolvedMetadata['platformIds'][number]>();
  for (const r of ordered) for (const p of r.platformIds ?? []) platformIds.set(`${p.platform}:${p.entity}:${p.externalId}`, p);

  const labelName = choose('labelName');
  const pLine = choose('pLine');
  const cLine = choose('cLine');
  const distributor = inferDistributor(
    { labelName, pLine, cLine, upc, licensedDistributor: ordered.find((r) => r.distributor)?.distributor ?? null, mbLabels: ordered.flatMap((r) => r.labels ?? []) },
    ctx.aliases,
    ctx.hints,
  );

  return {
    input,
    isrc: isrc ? normalizeIsrc(String(isrc)) : null,
    upc: upc ? normalizeUpc(String(upc)) : null,
    title: choose('title') as string | null,
    artists,
    releaseTitle: choose('releaseTitle') as string | null,
    releaseType: choose('releaseType') as string | null,
    releaseDate: releaseDate ? String(releaseDate).slice(0, 10) : null,
    labelName: labelName as string | null,
    pLine: pLine as string | null,
    cLine: cLine as string | null,
    durationMs: choose('durationMs') as number | null,
    explicit,
    tracks,
    platformIds: [...platformIds.values()],
    distributor: { name: distributor.name, confidence: distributor.confidence, evidence: distributor.evidence as DistributorEvidence[] },
    conflicts,
    sources,
  };
}

async function run(name: string, sources: ResolvedMetadata['sources'], fn: () => Promise<SourceResult | null>, skipped?: string): Promise<SourceResult | null> {
  if (skipped) {
    sources.push({ source: name, ok: false, skipped });
    return null;
  }
  try {
    const r = await fn();
    sources.push({ source: name, ok: Boolean(r), ...(r ? {} : { error: 'no match' }) });
    return r;
  } catch (err) {
    logger.warn({ err, source: name }, 'metadata source failed');
    sources.push({ source: name, ok: false, error: (err as Error).message.slice(0, 200) });
    return null;
  }
}

/**
 * Resolve any supported input. Pass 1 turns links, text or tags into
 * identifiers; pass 2 queries every source by ISRC/UPC in parallel.
 */
export async function resolveMetadata(parsed: ParsedInput, raw: Record<string, string>, ctx: ResolveContext): Promise<ResolvedMetadata> {
  const sources: ResolvedMetadata['sources'] = [];
  const results: SourceResult[] = [];
  const q: Query & Record<string, string | null | undefined> = {};
  const { creds } = ctx;

  switch (parsed.kind) {
    case 'isrc':
      q.isrc = parsed.isrc;
      break;
    case 'upc':
      q.upc = parsed.upc;
      break;
    case 'deezer':
      if (parsed.entity === 'track') q.deezerTrackId = parsed.id;
      else q.deezerAlbumId = parsed.id;
      break;
    case 'spotify':
      if (creds.spotify || creds.spotscraper) {
        if (parsed.entity === 'track') q.spotifyTrackId = parsed.id;
        else q.spotifyAlbumId = parsed.id;
      } else {
        const title = await spotifyOEmbedTitle(parsed.url).catch(() => null);
        if (title) Object.assign(q, { title });
        sources.push({ source: 'spotify', ok: false, skipped: 'No Spotify or SpotScraper credentials: resolved the link by title instead' });
      }
      break;
    case 'apple':
      if (creds.apple) {
        if (parsed.entity === 'track') q.appleSongId = parsed.id;
        else q.appleAlbumId = parsed.id;
      }
      if (parsed.entity === 'album') q.itunesId = parsed.id;
      break;
    case 'youtube': {
      const yt = await youtubeTitle(parsed.videoId, creds.youtubeApiKey).catch(() => null);
      if (yt) Object.assign(q, splitVideoTitle(yt.title, yt.channel));
      results.push({ source: 'search', platformIds: [{ platform: 'youtube', entity: 'track', externalId: parsed.videoId, url: parsed.url, source: 'link' }] });
      break;
    }
    case 'text':
      q.title = parsed.title;
      q.artist = parsed.artist;
      break;
    case 'file':
      if (ctx.tags) {
        q.isrc = ctx.tags.isrc ? normalizeIsrc(ctx.tags.isrc) : null;
        q.title = ctx.tags.title ?? null;
        q.artist = ctx.tags.artist ?? null;
        results.push({ source: 'tags', isrc: q.isrc, title: ctx.tags.title ?? null, artists: ctx.tags.artist ? [ctx.tags.artist] : [], releaseTitle: ctx.tags.album ?? null, labelName: ctx.tags.label ?? null, durationMs: ctx.tags.durationMs ?? null });
      }
      break;
  }

  // Matches found by searching a title are suggestions: identities from them go to human review.
  if (parsed.kind === 'text' || parsed.kind === 'youtube' || (parsed.kind === 'spotify' && !creds.spotify && !creds.spotscraper) || (parsed.kind === 'file' && !q.isrc)) raw = { ...raw, matchedBy: 'search' };

  // Free-text: search for an ISRC first (Deezer, then MusicBrainz).
  if (!q.isrc && !q.upc && !q.deezerTrackId && !q.deezerAlbumId && !q.spotifyTrackId && !q.spotifyAlbumId && !q.appleSongId && !q.appleAlbumId && q.title) {
    const dz = await deezerSearch(q.title, q.artist ?? null).catch(() => null);
    if (dz) q.deezerTrackId = dz.trackId;
    else {
      const mb = await musicbrainzSearch(q.title, q.artist ?? null).catch(() => null);
      if (mb?.isrc) q.isrc = mb.isrc;
    }
  }

  // Pass 1b: id-based lookups give us ISRC/UPC for pass 2.
  const first = await Promise.all([
    q.deezerTrackId || q.deezerAlbumId ? run('deezer', sources, () => deezerLookup({ ...q, withTracklist: Boolean(q.deezerAlbumId) })) : null,
    q.spotifyTrackId || q.spotifyAlbumId ? (creds.spotify ? run('spotify', sources, () => spotifyLookup(creds.spotify!, q)) : run('spotscraper', sources, () => spotScraperLookup(creds.spotscraper!, q))) : null,
    q.appleSongId || q.appleAlbumId ? run('apple', sources, () => appleLookup(creds.apple!, q)) : null,
  ]);
  for (const r of first) if (r) results.push(r);
  q.isrc ??= results.map((r) => r.isrc).find(Boolean) ?? null;
  q.upc ??= results.map((r) => r.upc).find(Boolean) ?? null;

  if (!q.isrc && !q.upc) {
    return mergeResults(raw, results, ctx, sources);
  }

  const done = new Set(results.map((r) => r.source));
  const licensed = creds.licensed ? licensedMetadataProvider(creds.licensed.vendor) : null;
  const second = await Promise.all([
    done.has('deezer') ? null : run('deezer', sources, () => deezerLookup({ isrc: q.isrc, upc: q.upc, withTracklist: parsed.kind === 'upc' })),
    run('musicbrainz', sources, () => musicbrainzLookup({ isrc: q.isrc, upc: q.upc })),
    done.has('spotify') ? null : run('spotify', sources, () => spotifyLookup(creds.spotify!, { isrc: q.isrc, upc: q.upc }), creds.spotify ? undefined : 'Not connected (Settings → Integrations)'),
    done.has('spotscraper') ? null : run('spotscraper', sources, () => spotScraperLookup(creds.spotscraper!, { isrc: q.isrc }), !creds.spotscraper ? 'Not connected (Settings → Integrations)' : q.isrc ? undefined : 'Needs an ISRC'),
    done.has('apple') ? null : run('apple', sources, () => appleLookup(creds.apple!, { isrc: q.isrc, upc: q.upc }), creds.apple ? undefined : 'Not connected (Settings → Integrations)'),
    run('itunes', sources, () => itunesLookup({ upc: q.upc, itunesId: q.itunesId ?? undefined }), q.upc || q.itunesId ? undefined : 'Needs a UPC'),
    run('licensed', sources, () => licensed!.lookup(creds.licensed!, { isrc: q.isrc, upc: q.upc }), licensed ? undefined : 'No licensed provider configured'),
  ]);
  for (const r of second) if (r) results.push(r);

  // A UPC learned in pass 2 (e.g. from MusicBrainz) can unlock iTunes.
  const upc = q.upc ?? results.map((r) => r.upc).find(Boolean);
  if (upc && !q.upc && !results.some((r) => r.source === 'itunes')) {
    const idx = sources.findIndex((s) => s.source === 'itunes');
    if (idx >= 0) sources.splice(idx, 1);
    const r = await run('itunes', sources, () => itunesLookup({ upc }));
    if (r) results.push(r);
  }

  return mergeResults(raw, results, ctx, sources);
}
