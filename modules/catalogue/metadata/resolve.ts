import { withBudget } from '@labelconsole/core/http';
import { logger } from '@labelconsole/core/logger';
import type { SpotScraperClient } from '@labelconsole/core/spotscraper';
import type { DistributorEvidence, ResolvedMetadata } from '../schema';
import { classify, pausedFor, recordFailure, recordSuccess } from './breaker';
import { inferDistributor, type Alias, type Hint } from './distributor';
import { normalizeIsrc, normalizeUpc, type ParsedInput } from './input';
import { appleLookup, itunesLookup, type AppleSecret } from './sources/apple';
import { deezerLookup, deezerSearch } from './sources/deezer';
import { discogsLookup, type DiscogsSecret } from './sources/discogs';
import { licensedMetadataProvider, type LicensedSecret } from './sources/licensed';
import { musicbrainzLookup, musicbrainzSearch } from './sources/musicbrainz';
import { spotifyLookup, spotifyOEmbedTitle, type SpotifySecret } from './sources/spotify';
import { spotScraperLookup } from './sources/spotscraper';
import type { Query, SourceResult } from './sources/types';
import { splitVideoTitle, youtubeTitle } from './sources/youtube';
import type { AudioTags } from './tags';

export type ResolveCredentials = { spotify?: SpotifySecret | null; apple?: AppleSecret | null; youtubeApiKey?: string | null; licensed?: LicensedSecret | null; spotscraper?: SpotScraperClient | null; discogs?: DiscogsSecret | null };
/**
 * `scope` (the label) keys the circuit breaker for sources that use the
 * label's own credentials. `budget` bounds each source call, for replies
 * that should answer with what they have (see withBudget).
 */
export type ResolveContext = { creds: ResolveCredentials; aliases: Alias[]; hints: Hint[]; tags?: AudioTags | null; scope?: string | null; budget?: { queueMs: number; totalMs: number } | null };

/** When sources disagree, the first in this order wins and the conflict is reported. */
const PRIORITY = ['spotify', 'spotscraper', 'apple', 'deezer', 'musicbrainz', 'discogs', 'licensed', 'itunes', 'tags', 'search'];
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
  const fieldSources: NonNullable<ResolvedMetadata['fieldSources']> = {};
  const choose = <F extends Field>(field: F) => {
    const values = pick(field);
    const distinct = new Set(values.map((v) => canon(field, v.value)));
    if (distinct.size > 1 && field !== 'explicit') conflicts.push({ field, values: values.map((v) => ({ source: v.source, value: String(v.value) })) });
    if (values.length) fieldSources[field] = values.filter((v) => canon(field, v.value) === canon(field, values[0].value)).map((v) => v.source);
    return values[0]?.value ?? null;
  };

  const isrc = choose('isrc');
  const upc = choose('upc');
  const releaseDate = choose('releaseDate');
  const explicit = pick('explicit').some((v) => v.value === true) ? true : pick('explicit').length ? false : null;
  const artistSource = ordered.find((r) => r.artists?.length);
  const artists = artistSource?.artists ?? [];
  if (artistSource) fieldSources.artists = [artistSource.source];
  const artwork = ordered.find((r) => r.artworkUrl);
  if (artwork) fieldSources.artworkUrl = [artwork.source];
  // Spotify's markets are the most complete availability list; Deezer's is the free fallback.
  const avail = ordered.filter((r) => r.availableCountries?.length).sort((a, b) => Number(b.source === 'spotify') - Number(a.source === 'spotify'))[0];
  const played = ordered.find((r) => r.playCount != null);
  const catalogNumber = ordered.find((r) => r.catalogNumber)?.catalogNumber ?? null;
  const companies = ordered.flatMap((r) => (r.companies ?? []).map((c) => ({ source: r.source, ...c })));

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
    { labelName, pLine, cLine, upc, licensedDistributor: ordered.find((r) => r.distributor)?.distributor ?? null, mbLabels: ordered.flatMap((r) => r.labels ?? []), reportedDistributors: companies.filter((c) => /distributed by/i.test(c.role)).map((c) => c.name) },
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
    artworkUrl: artwork?.artworkUrl ?? null,
    fieldSources,
    previewUrl: ordered.find((r) => r.previewUrl)?.previewUrl ?? null,
    availability: avail ? { source: avail.source, countries: [...new Set(avail.availableCountries!.map((c) => c.toUpperCase()))].sort() } : null,
    plays: played ? { platform: 'spotify', source: played.source, count: played.playCount!, at: new Date().toISOString() } : null,
    catalogNumber,
    companies,
    claims: claimsOf(ordered),
  };
}

const PLATFORM_OF: Record<string, string> = { spotscraper: 'spotify', itunes: 'apple' };

/** Each source's own values, as published (only trimmed and length-capped), for the evidence history. */
function claimsOf(results: SourceResult[]): NonNullable<ResolvedMetadata['claims']> {
  const text = (v: unknown) => (v == null || v === '' ? undefined : String(v).trim().slice(0, 500) || undefined);
  return results
    .filter((r) => r.source !== 'search')
    .map((r) => {
      const platform = PLATFORM_OF[r.source] ?? r.source;
      const own = (r.platformIds ?? []).filter((p) => p.platform === platform && p.url);
      const reported = (r.companies ?? []).filter((c) => /distributed by/i.test(c.role)).map((c) => c.name);
      const values: NonNullable<ResolvedMetadata['claims']>[number]['values'] = {
        isrc: text(r.isrc ? normalizeIsrc(r.isrc) ?? r.isrc : null),
        title: text(r.title),
        artists: text(r.artists?.join(', ')),
        durationMs: text(r.durationMs),
        upc: text(r.upc ? normalizeUpc(r.upc) ?? r.upc : null),
        releaseTitle: text(r.releaseTitle),
        releaseType: text(r.releaseType),
        releaseDate: text(r.releaseDate ? String(r.releaseDate).slice(0, 10) : null),
        labelName: text(r.labelName),
        pLine: text(r.pLine),
        cLine: text(r.cLine),
        catalogNumber: text(r.catalogNumber),
        distributor: text(r.distributor ?? (reported.length ? reported.join(', ') : null)),
      };
      for (const k of Object.keys(values) as Array<keyof typeof values>) if (values[k] === undefined) delete values[k];
      return { source: r.source, upc: values.upc ?? null, url: (own.find((p) => p.entity === 'track') ?? own[0])?.url ?? null, values };
    })
    .filter((c) => Object.keys(c.values).length > 0);
}

type Runner = (name: string, fn: () => Promise<SourceResult | null>, skipped?: string) => Promise<SourceResult | null>;

/** Call one source: skip it when it isn't set up or is paused, time it, and record how it ended. */
function runner(sources: ResolvedMetadata['sources'], scope: string | null | undefined, budget: ResolveContext['budget']): Runner {
  return async (name, call, skipped) => {
    const fn = budget ? () => withBudget(budget, call) : call;
    if (skipped) {
      sources.push({ source: name, ok: false, skipped, outcome: 'skipped' });
      return null;
    }
    const paused = await pausedFor(name, scope);
    if (paused) {
      sources.push({ source: name, ok: false, skipped: `Paused after repeated errors; tried again in ${paused}s`, outcome: 'paused' });
      return null;
    }
    const started = Date.now();
    try {
      const r = await fn();
      await recordSuccess(name, scope);
      sources.push({ source: name, ok: Boolean(r), ms: Date.now() - started, outcome: r ? 'answered' : 'no_match', ...(r ? {} : { error: 'no match' }) });
      return r;
    } catch (err) {
      const ms = Date.now() - started;
      const pausedNow = await recordFailure(name, scope, err);
      logger.warn({ err, source: name, paused: pausedNow }, 'metadata source failed');
      sources.push({ source: name, ok: false, ms, outcome: classify(err), error: (err as Error).message.slice(0, 200) });
      return null;
    }
  };
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
  const run = runner(sources, ctx.scope, ctx.budget);

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
    q.deezerTrackId || q.deezerAlbumId ? run('deezer', () => deezerLookup({ ...q, withTracklist: Boolean(q.deezerAlbumId) })) : null,
    q.spotifyTrackId || q.spotifyAlbumId ? (creds.spotify ? run('spotify', () => spotifyLookup(creds.spotify!, q)) : run('spotscraper', () => spotScraperLookup(creds.spotscraper!, q))) : null,
    q.appleSongId || q.appleAlbumId ? run('apple', () => appleLookup(creds.apple!, q)) : null,
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
    done.has('deezer') ? null : run('deezer', () => deezerLookup({ isrc: q.isrc, upc: q.upc, withTracklist: parsed.kind === 'upc' })),
    run('musicbrainz', () => musicbrainzLookup({ isrc: q.isrc, upc: q.upc })),
    done.has('spotify') ? null : run('spotify', () => spotifyLookup(creds.spotify!, { isrc: q.isrc, upc: q.upc }), creds.spotify ? undefined : 'Not connected (Settings → Integrations)'),
    done.has('spotscraper') ? null : run('spotscraper', () => spotScraperLookup(creds.spotscraper!, { isrc: q.isrc }), !creds.spotscraper ? 'Not connected (Settings → Integrations)' : q.isrc ? undefined : 'Needs an ISRC'),
    done.has('apple') ? null : run('apple', () => appleLookup(creds.apple!, { isrc: q.isrc, upc: q.upc }), creds.apple ? undefined : 'Not connected (Settings → Integrations)'),
    run('itunes', () => itunesLookup({ upc: q.upc, itunesId: q.itunesId ?? undefined }), q.upc || q.itunesId ? undefined : 'Needs a UPC'),
    run('licensed', () => licensed!.lookup(creds.licensed!, { isrc: q.isrc, upc: q.upc }), licensed ? undefined : 'No licensed provider configured'),
    run('discogs', () => discogsLookup(creds.discogs!, { upc: q.upc }), !creds.discogs ? 'Not connected (Settings → Integrations)' : q.upc ? undefined : 'Needs a UPC'),
  ]);
  for (const r of second) if (r) results.push(r);

  // A UPC learned in pass 2 (from Deezer or MusicBrainz, on an ISRC lookup) unlocks the sources that only search by UPC.
  const upc = q.upc ?? results.map((r) => r.upc).find(Boolean);
  if (upc && !q.upc) {
    const again = (name: string) => {
      const idx = sources.findIndex((s) => s.source === name);
      if (idx >= 0) sources.splice(idx, 1);
    };
    const third = await Promise.all([
      results.some((r) => r.source === 'itunes') ? null : (again('itunes'), run('itunes', () => itunesLookup({ upc }))),
      !creds.discogs || results.some((r) => r.source === 'discogs') ? null : (again('discogs'), run('discogs', () => discogsLookup(creds.discogs!, { upc }))),
    ]);
    for (const r of third) if (r) results.push(r);
  }

  return mergeResults(raw, results, ctx, sources);
}
