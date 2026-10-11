import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedMetadata } from '../schema';
import { fetchCredits } from './credits';
import { inferDistributor } from './distributor';
import { discogsCredits, discogsLookup, fromDiscogs, type DgRelease } from './sources/discogs';

const RELEASE: DgRelease = {
  id: 249504,
  title: 'Discovery',
  released: '2001-03-12',
  artists: [{ name: 'Daft Punk' }],
  labels: [{ name: 'Virgin (2)', catno: 'V2940' }],
  companies: [
    { name: 'EMI', entity_type_name: 'Distributed By' },
    { name: 'Daft Life Ltd.', entity_type_name: 'Phonographic Copyright (p)' },
  ],
  formats: [{ name: 'CD', descriptions: ['Album'] }],
  identifiers: [{ type: 'Barcode', value: '7 24384 96065 0' }],
  extraartists: [{ name: 'Thomas Bangalter', role: 'Producer, Written-By' }],
  tracklist: [{ position: '4', title: 'Harder, Better, Faster, Stronger', duration: '3:44', extraartists: [{ name: 'Edwin Birdsong', role: 'Written-By [Sample]' }] }],
  images: [{ type: 'primary', uri: 'https://i.discogs.com/discovery.jpg' }],
};

const md = (platformIds: ResolvedMetadata['platformIds']): ResolvedMetadata => ({
  input: {},
  isrc: 'GBDUW0000059',
  upc: '0724384960650',
  title: 'Harder, Better, Faster, Stronger',
  artists: ['Daft Punk'],
  releaseTitle: 'Discovery',
  releaseType: 'album',
  releaseDate: null,
  labelName: null,
  pLine: null,
  cLine: null,
  durationMs: null,
  explicit: null,
  tracks: [],
  platformIds,
  distributor: { name: null, confidence: 0, evidence: [] },
  conflicts: [],
  sources: [],
});

function stub(responses: Array<[string, unknown]>) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(String(url));
      const hit = responses.find(([k]) => String(url).includes(k));
      return new Response(JSON.stringify(hit ? hit[1] : {}), { status: hit ? 200 : 404, headers: { 'content-type': 'application/json' } });
    }),
  );
  return calls;
}

describe('Discogs', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads a release: barcode, label, catalogue number, companies and artwork', () => {
    expect(fromDiscogs(RELEASE)).toMatchObject({
      source: 'discogs',
      upc: '0724384960650',
      releaseTitle: 'Discovery',
      releaseType: 'album',
      releaseDate: '2001-03-12',
      labelName: 'Virgin',
      catalogNumber: 'V2940',
      companies: [
        { role: 'Distributed By', name: 'EMI' },
        { role: 'Phonographic Copyright (p)', name: 'Daft Life Ltd.' },
      ],
      artworkUrl: 'https://i.discogs.com/discovery.jpg',
      platformIds: [{ platform: 'discogs', entity: 'release', externalId: '249504', url: 'https://www.discogs.com/release/249504' }],
    });
  });

  it('finds a release by barcode with the token', async () => {
    const calls = stub([
      ['/database/search', { results: [{ id: 249504, type: 'release' }] }],
      ['/releases/249504', RELEASE],
    ]);
    const r = await discogsLookup({ token: 'tok' }, { upc: '0724384960650' });
    expect(r?.catalogNumber).toBe('V2940');
    expect(calls[0]).toContain('barcode=724384960650');
  });

  it('lists credits per role, with the matching track’s own credits', () => {
    expect(discogsCredits(RELEASE, 'Harder, Better, Faster, Stronger')).toEqual([
      { name: 'Daft Punk', role: 'Main Artist' },
      { name: 'Edwin Birdsong', role: 'Written-By' },
      { name: 'Thomas Bangalter', role: 'Producer' },
      { name: 'Thomas Bangalter', role: 'Written-By' },
    ]);
  });

  it('counts "Distributed By" as evidence, never as proof', () => {
    const r = inferDistributor({ reportedDistributors: ['Believe Digital'] }, [{ distributor: 'Believe', pattern: 'believe', weight: 0.6 }], []);
    expect(r.name).toBe('Believe');
    expect(r.evidence[0]).toMatchObject({ source: 'Discogs', signal: 'Distributed By', weight: 0.6 });
    expect(r.confidence).toBeLessThan(0.7);
  });
});

describe('credits for songs outside the catalogue', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('use MusicBrainz relationships and the work’s writers when SpotScraper is not set up', async () => {
    stub([
      [
        '/ws/2/recording/11111111-2222-3333-4444-555555555555',
        {
          'artist-credit': [{ name: 'Daft Punk' }],
          relations: [
            { type: 'producer', 'target-type': 'artist', artist: { name: 'Thomas Bangalter' } },
            { type: 'instrument', 'target-type': 'artist', attributes: ['guitar'], artist: { name: 'Guy-Manuel de Homem-Christo' } },
            { type: 'performance', 'target-type': 'work', work: { title: 'HBFS', relations: [{ type: 'composer', artist: { name: 'Edwin Birdsong' } }, { type: 'lyricist', artist: { name: 'Thomas Bangalter' } }] } },
          ],
        },
      ],
    ]);
    const r = await fetchCredits({}, md([{ platform: 'musicbrainz', entity: 'track', externalId: '11111111-2222-3333-4444-555555555555', url: null, source: 'musicbrainz' }]));
    expect(r).toEqual({
      source: 'musicbrainz',
      credits: [
        { name: 'Daft Punk', role: 'Main Artist' },
        { name: 'Thomas Bangalter', role: 'Producer' },
        { name: 'Guy-Manuel de Homem-Christo', role: 'Guitar' },
        { name: 'Edwin Birdsong', role: 'Composer' },
        { name: 'Thomas Bangalter', role: 'Lyricist' },
      ],
    });
  });

  it('prefer Spotify’s credits through SpotScraper, and fall back to Discogs', async () => {
    const spotscraper = { credits: vi.fn(async () => ({ credits: [{ name: 'Nikita Makarov', role: 'Composer' }], copyright: null })) };
    const withSpotify = await fetchCredits({ spotscraper: spotscraper as never }, md([{ platform: 'spotify', entity: 'track', externalId: '5W3cjX2J3tjhG8zb6u0qHn', url: null, source: 'spotify' }]));
    expect(withSpotify).toEqual({ source: 'spotscraper', credits: [{ name: 'Nikita Makarov', role: 'Composer' }] });

    stub([['/releases/249504', RELEASE]]);
    const discogs = await fetchCredits({ discogs: { token: 't' } }, md([{ platform: 'discogs', entity: 'release', externalId: '249504', url: null, source: 'discogs' }]));
    expect(discogs?.source).toBe('discogs');
    expect(await fetchCredits({}, md([]))).toBeNull();
  });
});
