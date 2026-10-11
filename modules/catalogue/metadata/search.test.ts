import { afterEach, describe, expect, it, vi } from 'vitest';
import { mergeResults } from './resolve';
import { searchCandidates, unambiguousCandidate, type SearchCandidate } from './search';

function stubFetch(responses: Array<[string, unknown]>) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(String(url));
      const hit = responses.find(([k]) => decodeURIComponent(String(url)).includes(k));
      return new Response(JSON.stringify(hit ? hit[1] : { data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  return calls;
}

const dz = (id: number, title: string, artist: string, album: string, duration = 240) => ({ id, title, duration, explicit_lyrics: false, artist: { name: artist }, album: { title: album } });

describe('candidate search', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps every plausible match, shows a recording once, and puts exact matches first', async () => {
    stubFetch([
      [
        'q=Midnight City',
        {
          data: [
            dz(1, 'Midnight City (Eric Prydz Remix)', 'M83', 'Midnight City (Remixes)', 300),
            dz(2, 'Midnight City', 'M83', "Hurry Up, We're Dreaming", 243),
            dz(3, 'Midnight City', 'M83', 'Midnight City', 244), // same recording on the single
            dz(4, 'Midnight City', 'Cover Band', 'Covers Vol. 2', 230),
          ],
        },
      ],
    ]);
    const c = await searchCandidates('Midnight City', null);
    expect(c.map((x) => x.key)).toEqual(['dz:2', 'dz:4', 'dz:1']);
    expect(c.filter((x) => x.exact).map((x) => x.artists[0])).toEqual(['M83', 'Cover Band']);
    // Two exact titles and no artist given: ask.
    expect(unambiguousCandidate(c, null)).toBeNull();
  });

  it('picks without asking only when the named artist leaves one exact match', async () => {
    stubFetch([['artist:"M83" track:"Midnight City"', { data: [dz(2, 'Midnight City', 'M83', "Hurry Up, We're Dreaming"), dz(1, 'Midnight City (Eric Prydz Remix)', 'M83', 'Remixes', 300)] }]]);
    const c = await searchCandidates('Midnight City', 'M83');
    expect(unambiguousCandidate(c, 'M83')?.key).toBe('dz:2');
  });

  it('does not treat a remix or a lone near-miss as a match', () => {
    const base = { source: 'deezer' as const, artists: ['M83'], album: null, durationMs: null, year: null, explicit: null };
    const remix: SearchCandidate = { ...base, key: 'dz:1', title: 'Midnight City (Remix)', exact: false };
    expect(unambiguousCandidate([remix], 'M83')).toBeNull();
    expect(unambiguousCandidate([{ ...remix, title: 'Midnight City', exact: true }], null)?.key).toBe('dz:1');
  });

  it('retries a swapped "Title - Artist" query and still recognises the match', async () => {
    const calls = stubFetch([
      ['artist:"Midnight City" track:"M83"', { data: [] }],
      ['q=Midnight City M83', { data: [dz(2, 'Midnight City', 'M83', "Hurry Up, We're Dreaming")] }],
    ]);
    const c = await searchCandidates('M83', 'Midnight City');
    expect(calls).toHaveLength(2);
    expect(c[0]).toMatchObject({ key: 'dz:2', exact: true });
    expect(unambiguousCandidate(c, 'Midnight City')?.key).toBe('dz:2');
  });

  it('falls back to MusicBrainz recordings that carry an ISRC', async () => {
    stubFetch([
      ['api.deezer.com', { data: [] }],
      [
        'musicbrainz.org/ws/2/recording',
        {
          recordings: [
            { id: 'r1', title: 'Tidewater', score: 100, length: 201000, isrcs: ['NLA1Z2600123'], 'artist-credit': [{ name: 'Mara Ellis' }], releases: [{ title: 'Slow Dissolve', date: '2026-01-10', status: 'Official' }] },
            { id: 'r2', title: 'Tidewater', score: 95, 'artist-credit': [{ name: 'Someone' }] }, // no ISRC: cannot be resolved
            { id: 'r3', title: 'Tide', score: 40, isrcs: ['USAAA2600001'] }, // weak match
          ],
        },
      ],
    ]);
    const c = await searchCandidates('Tidewater', null);
    expect(c).toEqual([{ key: 'isrc:NLA1Z2600123', source: 'musicbrainz', title: 'Tidewater', artists: ['Mara Ellis'], album: 'Slow Dissolve', durationMs: 201000, year: '2026', explicit: null, exact: true }]);
  });
});

describe('merge provenance', () => {
  it('records which sources agree on each chosen value and the best artwork', () => {
    const m = mergeResults(
      { input: 'x' },
      [
        { source: 'musicbrainz', isrc: 'GBDUW0000059', labelName: 'Virgin', artists: ['Daft Punk'] },
        { source: 'deezer', isrc: 'GBDUW0000059', labelName: 'Parlophone (France)', artists: ['Daft Punk'], artworkUrl: 'https://cdn-images.dzcdn.net/cover.jpg' },
        { source: 'itunes', artworkUrl: 'https://is1-ssl.mzstatic.com/600x600bb.jpg' },
      ],
      { aliases: [], hints: [] },
      [],
    );
    expect(m.fieldSources?.isrc).toEqual(['deezer', 'musicbrainz']);
    expect(m.fieldSources?.labelName).toEqual(['deezer']);
    expect(m.fieldSources?.artists).toEqual(['deezer']);
    expect(m.artworkUrl).toBe('https://cdn-images.dzcdn.net/cover.jpg');
    expect(m.conflicts.map((c) => c.field)).toEqual(['labelName']);
  });
});
