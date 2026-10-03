import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderError, RateLimitedError } from './errors';
import { copyrightLines, pickIsrcMatch, SpotScraperClient, spotifyIdFrom } from './spotscraper';

// The shared token bucket lives in Redis; these tests only exercise HTTP and parsing.
vi.mock('./ratelimit', () => ({ acquire: async () => {} }));

/** Live responses recorded from api.spotscraper.com (images and long texts trimmed). */
const fixture = (name: string) => readFileSync(join(__dirname, '__fixtures__/spotscraper', name), 'utf8');
const ok = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });

function serve(routes: Record<string, () => Response>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), headers: init.headers as Record<string, string> });
      const path = String(url).replace('https://api.spotscraper.com/v1', '');
      const hit = Object.entries(routes).find(([p]) => path.startsWith(p));
      return hit ? hit[1]() : new Response(JSON.stringify({ success: false, error: 'Track not found', status: 404 }), { status: 404 });
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('SpotScraperClient', () => {
  it('reads a track: play count, artists, album and copyright', async () => {
    const calls = serve({ '/tracks/4uLU6hMCjMI75M1A2tKUQC': () => ok(fixture('track.json')) });
    const t = await new SpotScraperClient('ss-key').track('4uLU6hMCjMI75M1A2tKUQC');
    expect(calls[0].url).toBe('https://api.spotscraper.com/v1/tracks/4uLU6hMCjMI75M1A2tKUQC');
    expect(calls[0].headers['x-api-key']).toBe('ss-key');
    expect(t).toMatchObject({ id: '4uLU6hMCjMI75M1A2tKUQC', name: 'Never Gonna Give You Up', playCount: 1185218315, durationMs: 213573, isrc: null, artists: [{ id: '0gxyHStUsqpMadRV0Di1Qt', name: 'Rick Astley' }] });
    expect(t?.album).toMatchObject({ id: '6N9PS4QXF1D0OWPk0Sxtb4', copyright: expect.stringMatching(/^\(P\) 1987/) });
  });

  it('searches by ISRC, most popular release first', async () => {
    const calls = serve({ '/tracks/search/isrc/GBARL9300135': () => ok(fixture('isrc-search.json')) });
    const results = await new SpotScraperClient('k').searchIsrc('gb-arl-93-00135');
    expect(calls[0].url).toContain('/tracks/search/isrc/GBARL9300135?limit=20');
    expect(results).toHaveLength(5);
    expect(results.every((r) => r.isrc === 'GBARL9300135')).toBe(true);
    expect(results.map((r) => r.popularity)).toEqual([83, 39, 22, 15, 10]);
    // Invalid codes never reach the API.
    expect(await new SpotScraperClient('k').searchIsrc('not-an-isrc')).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('reads credits in the shape the live API returns', async () => {
    serve({ '/tracks/4uLU6hMCjMI75M1A2tKUQC/credits': () => ok(fixture('credits.json')) });
    const c = await new SpotScraperClient('k').credits('4uLU6hMCjMI75M1A2tKUQC');
    expect(c?.credits).toContainEqual({ name: 'Stock Aitken Waterman', role: 'Producer' });
    expect(c?.credits.filter((x) => x.role === 'Composer').map((x) => x.name)).toEqual(['Mike Stock', 'Matt Aitken', 'Pete Waterman']);
    expect(c?.copyright).toMatch(/Sony Music/);
  });

  it('reads an album: UPC, label, release date and tracklist with artist IDs from URIs', async () => {
    serve({ '/albums/6N9PS4QXF1D0OWPk0Sxtb4': () => ok(fixture('album.json')) });
    const a = await new SpotScraperClient('k').album('6N9PS4QXF1D0OWPk0Sxtb4');
    expect(a).toMatchObject({ upc: '035627515026', label: 'Sony Music CG', releaseDate: '1987-11-12', totalTracks: 10 });
    expect(a?.tracks[0]).toMatchObject({ id: '4uLU6hMCjMI75M1A2tKUQC', trackNumber: 1, playCount: 1185218315, artists: [{ id: '0gxyHStUsqpMadRV0Di1Qt', name: 'Rick Astley' }] });
  });

  it('reads artist audience, playlists and discovered-on', async () => {
    serve({
      '/artists/0gxyHStUsqpMadRV0Di1Qt/discovered_on': () => ok(fixture('discovered-on.json')),
      '/artists/0gxyHStUsqpMadRV0Di1Qt': () => ok(fixture('artist.json')),
      '/playlists/37i9dQZF1DXcBWIGoYBM5M': () => ok(fixture('playlist.json')),
    });
    const client = new SpotScraperClient('k');
    const artist = await client.artist('0gxyHStUsqpMadRV0Di1Qt');
    // Spotify reports rank 0 for artists outside the ranking: that is no rank, not first place.
    expect(artist).toMatchObject({ name: 'Rick Astley', monthlyListeners: 8575581, followers: 1617392, worldRank: null, verified: true });
    expect(artist?.topCities[0]).toEqual({ city: 'Mexico City', country: 'MX', listeners: 191746 });
    const discovered = await client.discoveredOn('0gxyHStUsqpMadRV0Di1Qt', 3);
    expect(discovered.map((p) => p.name)).toContain('All Out 80s');
    expect(discovered.find((p) => p.name === 'All Out 80s')?.ownerName).toBe('Spotify');
    const playlist = await client.playlist('37i9dQZF1DXcBWIGoYBM5M');
    expect(playlist).toMatchObject({ name: 'Today’s Top Hits', followers: 33754783, trackCount: 50, ownerName: 'Spotify' });
    expect(client.requests).toBe(3);
  });

  it('reads an artist discography, newest first, and a playlist tracklist', async () => {
    serve({
      '/artists/0gxyHStUsqpMadRV0Di1Qt/discography': () => ok(fixture('discography.json')),
      '/playlists/4yjrxdwEZc6S8fnExS2sXC/tracks': () => ok(fixture('playlist-tracks.json')),
    });
    const client = new SpotScraperClient('k');
    const releases = await client.discography('0gxyHStUsqpMadRV0Di1Qt');
    expect(releases).toHaveLength(6);
    expect(releases?.map((r) => r.type).sort()).toEqual(['album', 'album', 'ep', 'ep', 'single', 'single']);
    expect(releases?.[0]).toMatchObject({ id: '2WlZ6L68eq4Wy7QUSI2ffK', name: '50 (10th Anniversary Deluxe Edition)', type: 'album', releaseDate: '2026-06-15', trackCount: 15, imageUrl: expect.stringMatching(/^https:\/\/i\.scdn\.co\//) });
    expect(releases?.map((r) => r.releaseDate)).toEqual([...releases!.map((r) => r.releaseDate)].sort().reverse());
    const tracks = await client.playlistTracks('4yjrxdwEZc6S8fnExS2sXC');
    expect(tracks).toHaveLength(3);
    expect(tracks[0]).toMatchObject({ id: '7N3H0T7EgeflYdKd68lvIV', name: 'MONTAGEM URANIUM - Slowed', position: 1, playCount: 22612116, artists: [{ id: '41rOXkwf7ccICwE9yRnEKi', name: 'ZAYLO' }], album: { id: '02v4wwlrIwnowie9SrjSuY', name: 'MONTAGEM URANIUM' } });
    expect(await client.discography('not-an-id')).toBeNull();
    expect(client.requests).toBe(2);
  });

  it('returns null for unknown IDs, refuses malformed ones, and reports key and rate-limit trouble plainly', async () => {
    serve({});
    const client = new SpotScraperClient('k');
    expect(await client.track('0000000000000000000000')).toBeNull();
    expect(await client.track('../../etc')).toBeNull();
    expect(client.requests).toBe(1);

    vi.stubGlobal('fetch', vi.fn(async () => new Response('An error occurred while processing your request.', { status: 400 })));
    const rejected = await client.track('4uLU6hMCjMI75M1A2tKUQC').catch((e: unknown) => e);
    expect(rejected).toBeInstanceOf(ProviderError);
    expect((rejected as ProviderError).transient).toBe(false);
    expect((rejected as Error).message).toMatch(/refused the API key/);

    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"slow down"}', { status: 429, headers: { 'retry-after': '0' } })));
    await expect(client.track('4uLU6hMCjMI75M1A2tKUQC')).rejects.toBeInstanceOf(RateLimitedError);
  });
});

describe('Spotify helpers', () => {
  it('takes IDs from links, URIs and bare IDs, only of the asked kind', () => {
    expect(spotifyIdFrom('https://open.spotify.com/intl-de/track/4uLU6hMCjMI75M1A2tKUQC?si=abc', 'track')).toBe('4uLU6hMCjMI75M1A2tKUQC');
    expect(spotifyIdFrom('spotify:artist:0gxyHStUsqpMadRV0Di1Qt', 'artist')).toBe('0gxyHStUsqpMadRV0Di1Qt');
    expect(spotifyIdFrom('0gxyHStUsqpMadRV0Di1Qt', 'artist')).toBe('0gxyHStUsqpMadRV0Di1Qt');
    expect(spotifyIdFrom('https://open.spotify.com/album/6N9PS4QXF1D0OWPk0Sxtb4', 'track')).toBeNull();
    expect(spotifyIdFrom('https://evil.example/track/4uLU6hMCjMI75M1A2tKUQC', 'track')).toBeNull();
    expect(spotifyIdFrom('', 'track')).toBeNull();
  });

  it('splits copyright lines', () => {
    expect(copyrightLines('(P) 1987 Sony Music')).toEqual({ pLine: '(P) 1987 Sony Music', cLine: null });
    expect(copyrightLines('© 2024 Night Ferries')).toEqual({ pLine: null, cLine: '© 2024 Night Ferries' });
    expect(copyrightLines('Some Label')).toEqual({ pLine: null, cLine: null });
  });

  it('picks the release by the track’s own artist, then the most popular', () => {
    const t = (id: string, artist: string, popularity: number) => ({ id, name: 'Song', isrc: 'NLA1Z2600123', durationMs: null, explicit: null, popularity, playCount: 10, artists: [{ id: `a${id}`, name: artist }], album: null });
    const results = [t('1', 'Various Artists', 60), t('2', 'Mara Ellis', 20), t('3', 'Mára Ellis', 40)];
    expect(pickIsrcMatch(results, 'NLA1Z2600123', ['Mara Ellis'])?.id).toBe('3');
    expect(pickIsrcMatch(results, 'NLA1Z2600123', [])?.id).toBe('1');
    expect(pickIsrcMatch(results, 'GBARL9300135', ['Mara Ellis'])).toBeNull();
  });
});
