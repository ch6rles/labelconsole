import { z } from 'zod';
import { runActorForTool } from '@labelconsole/core/apify';
import { spotifyIdFrom, spotScraperFor, type SpotScraperClient } from '@labelconsole/core/spotscraper';
import { clip, defineTool, type ToolContext } from '@labelconsole/core/tools';
import { recordUsage } from '@labelconsole/core/usage';
import * as svc from '../service';

/**
 * Spotify for agents. Lookups by link go through SpotScraper (cheap, one
 * request each); keyword search, which SpotScraper doesn't offer, goes
 * through an Apify scraper and is then filled in with SpotScraper's numbers.
 * Everything is normalised here, and anything already in the label's
 * catalogue is marked.
 */
const SEARCH_ACTOR = 'automation-lab/spotify-scraper';
const NO_KEY = 'No SpotScraper key is configured for this label (Settings → Integrations → SpotScraper).';

/** Run fn with the label's SpotScraper client and bill its requests. */
async function withSpotScraper<T>(t: ToolContext, fn: (client: SpotScraperClient) => Promise<T>): Promise<T | { error: string }> {
  const client = await t.withOrg((ctx) => spotScraperFor(ctx));
  if (!client) return { error: NO_KEY };
  try {
    return await fn(client);
  } finally {
    if (client.requests) await t.withOrg((ctx) => recordUsage(ctx, 'spotscraper_requests', client.requests));
  }
}

const link = (kind: string, id: string) => `https://open.spotify.com/${kind}/${id}`;
const LINK = (kind: string) => z.string().trim().min(10).max(300).describe(`open.spotify.com/${kind}/… link, spotify:${kind}: URI or ID`);
type Obj = Record<string, unknown>;
const s = (v: unknown, max = 200) => (typeof v === 'string' && v.trim() ? clip(v.trim(), max) : null);

export const tools = [
  defineTool({
    name: 'spotify_search',
    module: 'streams',
    description:
      'Search Spotify by keyword for playlists, artists, tracks or albums (for example playlists to pitch, or artists in a scene). Results come with their numbers: followers and curator for playlists, monthly listeners for artists, play counts for tracks, label and UPC for albums. Items already in the catalogue are marked. Billed per result, so keep limits small.',
    input: z.object({ query: z.string().trim().min(2).max(100), type: z.enum(['playlists', 'artists', 'tracks', 'albums']).default('playlists'), limit: z.number().int().min(1).max(15).default(8) }),
    permission: 'streams:read',
    risk: 'read',
    idempotent: true,
    timeoutMs: 300_000,
    preview: (i) => `Search Spotify ${i.type} for "${i.query}"`,
    execute: async (t, i) => {
      const items = (await runActorForTool(t, SEARCH_ACTOR, { mode: 'search', searchTerms: [i.query], searchType: i.type, maxResults: i.limit }, { maxItems: i.limit, what: 'Spotify search' }))
        .map((x) => (x && typeof x === 'object' ? (x as Obj) : {}))
        .filter((x) => typeof x.id === 'string' && /^[A-Za-z0-9]{22}$/.test(x.id));
      const ids = items.map((x) => x.id as string);
      const inCatalogue = i.type === 'tracks' || i.type === 'albums' ? await t.withOrg((ctx) => svc.catalogueBySpotifyIds(ctx, i.type === 'tracks' ? 'track' : 'release', ids)) : new Map<string, { id: string; title: string }>();
      const results = await withSpotScraper(t, async (client) =>
        Promise.all(
          items.map(async (x) => {
            const id = x.id as string;
            const base = { name: s(x.name), url: s(x.url, 300) ?? link(i.type.slice(0, -1), id) };
            if (i.type === 'playlists') {
              const p = await client.playlist(id).catch(() => null);
              return { ...base, curator: p?.ownerName ?? s(x.owner), followers: p?.followers ?? null, trackCount: p?.trackCount ?? null, description: s(p?.description ?? x.description, 240) };
            }
            if (i.type === 'artists') {
              const a = await client.artist(id).catch(() => null);
              return { ...base, monthlyListeners: a?.monthlyListeners ?? null, followers: a?.followers ?? null, verified: a?.verified ?? null, genres: a?.genres.slice(0, 5) ?? [] };
            }
            if (i.type === 'tracks') {
              const tr = await client.track(id).catch(() => null);
              return { ...base, artists: tr?.artists.map((a) => a.name) ?? s(x.artists), album: tr?.album?.name ?? s(x.albumName), playCount: tr?.playCount ?? null, popularity: tr?.popularity ?? null, inCatalogue: inCatalogue.get(id) ?? null };
            }
            const al = await client.album(id).catch(() => null);
            return { ...base, artists: al?.artists.map((a) => a.name) ?? [], label: al?.label ?? null, releaseDate: al?.releaseDate ?? null, upc: al?.upc ?? null, tracks: al?.totalTracks ?? null, inCatalogue: inCatalogue.get(id) ?? null };
          }),
        ),
      );
      return 'error' in results ? results : { query: i.query, type: i.type, results };
    },
  }),
  defineTool({
    name: 'spotify_track_lookup',
    module: 'streams',
    description: "Look up a track on Spotify by link or ISRC: its all-time play count, popularity, artists, release and length. Says whether it's in the label's catalogue.",
    input: z.object({ track: z.string().trim().min(10).max(300).describe('open.spotify.com/track/… link, spotify:track: URI or an ISRC') }),
    permission: 'streams:read',
    risk: 'read',
    idempotent: true,
    execute: async (t, i) => {
      const id = spotifyIdFrom(i.track, 'track');
      const isrc = id ? null : i.track.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!id && !/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(isrc ?? '')) return { error: 'Give a Spotify track link or an ISRC' };
      return withSpotScraper(t, async (client) => {
        const tr = id ? await client.track(id) : ((await client.searchIsrc(isrc!))[0] ?? null);
        if (!tr) return { error: id ? 'No Spotify track with that ID' : 'No track on Spotify carries that ISRC' };
        const inCatalogue = (await t.withOrg((ctx) => svc.catalogueBySpotifyIds(ctx, 'track', [tr.id]))).get(tr.id) ?? null;
        return { name: tr.name, url: link('track', tr.id), artists: tr.artists.map((a) => a.name), album: tr.album?.name ?? null, playCount: tr.playCount, popularity: tr.popularity, durationMs: tr.durationMs, explicit: tr.explicit, isrc: tr.isrc ?? isrc, inCatalogue };
      });
    },
  }),
  defineTool({
    name: 'spotify_album_lookup',
    module: 'streams',
    description: "Look up a release on Spotify by link: UPC, label, release date, ℗ line and each track's play count. Says whether it's in the label's catalogue.",
    input: z.object({ album: LINK('album') }),
    permission: 'streams:read',
    risk: 'read',
    idempotent: true,
    execute: async (t, i) => {
      const id = spotifyIdFrom(i.album, 'album');
      if (!id) return { error: 'Not a Spotify album link' };
      return withSpotScraper(t, async (client) => {
        const a = await client.album(id);
        if (!a) return { error: 'No Spotify release with that ID' };
        const inCatalogue = (await t.withOrg((ctx) => svc.catalogueBySpotifyIds(ctx, 'release', [a.id]))).get(a.id) ?? null;
        return { name: a.name, url: link('album', a.id), artists: a.artists.map((x) => x.name), upc: a.upc, label: a.label, releaseDate: a.releaseDate, copyright: a.copyright, inCatalogue, tracks: a.tracks.map((x) => ({ position: x.trackNumber, name: x.name, playCount: x.playCount, url: link('track', x.id) })) };
      });
    },
  }),
  defineTool({
    name: 'spotify_playlist_lookup',
    module: 'streams',
    description:
      "Look up a Spotify playlist by link: curator, followers, description and its tracks in order (play counts and when each was added). labelTracks lists the label's own songs on it, so you can check placements before or after a pitch.",
    input: z.object({ playlist: LINK('playlist'), tracks: z.number().int().min(0).max(100).default(30).describe('How many of its tracks to list (0 for none); label tracks are always checked') }),
    permission: 'streams:read',
    risk: 'read',
    idempotent: true,
    execute: async (t, i) => {
      const id = spotifyIdFrom(i.playlist, 'playlist');
      if (!id) return { error: 'Not a Spotify playlist link' };
      return withSpotScraper(t, async (client) => {
        const [p, list] = await Promise.all([client.playlist(id), client.playlistTracks(id)]);
        if (!p) return { error: 'No Spotify playlist with that ID (or it is private)' };
        const ours = await t.withOrg((ctx) => svc.catalogueBySpotifyIds(ctx, 'track', list.map((x) => x.id)));
        const view = (x: (typeof list)[number]) => ({ position: x.position, name: x.name, artists: x.artists.map((a) => a.name), playCount: x.playCount, addedAt: x.addedAt?.slice(0, 10) ?? null });
        return {
          name: p.name,
          url: link('playlist', p.id),
          curator: p.ownerName,
          followers: p.followers,
          trackCount: p.trackCount ?? list.length,
          description: p.description ? clip(p.description, 300) : null,
          labelTracks: list.filter((x) => ours.has(x.id)).map((x) => ({ ...view(x), catalogueTrack: ours.get(x.id) })),
          tracks: list.slice(0, i.tracks).map(view),
        };
      });
    },
  }),
  defineTool({
    name: 'spotify_artist_discography',
    module: 'streams',
    description: "An artist's albums, singles and EPs on Spotify, newest first, with release dates and track counts, and which are already in the catalogue. To bring a roster artist's missing releases into the catalogue, use catalogue_sync_spotify_artist.",
    input: z.object({ artist: LINK('artist'), limit: z.number().int().min(1).max(100).default(30) }),
    permission: 'streams:read',
    risk: 'read',
    idempotent: true,
    execute: async (t, i) => {
      const id = spotifyIdFrom(i.artist, 'artist');
      if (!id) return { error: 'Not a Spotify artist link' };
      return withSpotScraper(t, async (client) => {
        const releases = await client.discography(id);
        if (!releases) return { error: 'No Spotify artist with that ID' };
        const known = await t.withOrg((ctx) => svc.catalogueBySpotifyIds(ctx, 'release', releases.map((r) => r.id)));
        return { total: releases.length, inCatalogue: releases.filter((r) => known.has(r.id)).length, releases: releases.slice(0, i.limit).map((r) => ({ name: r.name, type: r.type, releaseDate: r.releaseDate, tracks: r.trackCount, url: link('album', r.id), inCatalogue: known.get(r.id) ?? null })) };
      });
    },
  }),
];
