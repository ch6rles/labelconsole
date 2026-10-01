import { afterEach, describe, expect, it, vi } from 'vitest';
import { hintsToLearn, inferDistributor, type Alias } from './distributor';
import { displayUpc, gs1CheckDigit, isValidGtin, normalizeIsrc, normalizeUpc, parseInput } from './input';
import { mergeResults, resolveMetadata } from './resolve';
import { readId3 } from './tags';

const ALIASES: Alias[] = [
  { distributor: 'DistroKid', pattern: 'distrokid', weight: 0.9 },
  { distributor: 'DistroKid', pattern: 'records dk', weight: 0.85 },
  { distributor: 'The Orchard', pattern: 'the orchard', weight: 0.85 },
  { distributor: 'Believe', pattern: 'believe', weight: 0.6 },
];

describe('input parsing', () => {
  it('recognises ISRCs with or without dashes', () => {
    expect(parseInput('GB-DUW-00-00059')).toEqual({ kind: 'isrc', isrc: 'GBDUW0000059' });
    expect(normalizeIsrc('usum71703861')).toBe('USUM71703861');
    expect(normalizeIsrc('US-UM7-17')).toBeNull();
  });

  it('validates UPC/EAN check digits and stores 13 digits', () => {
    expect(gs1CheckDigit('724384960650')).toBe(0);
    expect(isValidGtin('724384960650')).toBe(true);
    expect(isValidGtin('724384960651')).toBe(false);
    expect(normalizeUpc('724384960650')).toBe('0724384960650');
    expect(displayUpc('0724384960650')).toBe('724384960650');
    expect(parseInput('724384960650')).toEqual({ kind: 'upc', upc: '0724384960650' });
    expect(parseInput('724384960651')?.kind).toBe('text');
  });

  it('parses DSP links', () => {
    expect(parseInput('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=x')).toMatchObject({ kind: 'spotify', entity: 'track', id: '4uLU6hMCjMI75M1A2tKUQC' });
    expect(parseInput('https://open.spotify.com/intl-de/album/2noRn2Aes5aoNVsU6iWThc')).toMatchObject({ kind: 'spotify', entity: 'album' });
    expect(parseInput('https://music.apple.com/nl/album/discovery/697194953?i=697195462')).toMatchObject({ kind: 'apple', entity: 'track', id: '697195462', storefront: 'nl' });
    expect(parseInput('https://music.apple.com/us/album/discovery/697194953')).toMatchObject({ kind: 'apple', entity: 'album', id: '697194953' });
    expect(parseInput('https://www.deezer.com/en/track/3135556')).toMatchObject({ kind: 'deezer', entity: 'track', id: '3135556' });
    expect(parseInput('https://music.youtube.com/watch?v=dQw4w9WgXcQ&feature=share')).toMatchObject({ kind: 'youtube', videoId: 'dQw4w9WgXcQ' });
    expect(parseInput('https://youtu.be/dQw4w9WgXcQ')).toMatchObject({ kind: 'youtube', videoId: 'dQw4w9WgXcQ' });
    expect(parseInput('https://example.com/whatever')).toBeNull();
  });

  it('parses "Artist - Title" and "Title by Artist"', () => {
    expect(parseInput('Daft Punk - One More Time')).toEqual({ kind: 'text', title: 'One More Time', artist: 'Daft Punk' });
    expect(parseInput('One More Time by Daft Punk')).toEqual({ kind: 'text', title: 'One More Time', artist: 'Daft Punk' });
  });
});

describe('embedded tags', () => {
  it('reads ID3v2.3 frames including TSRC', () => {
    const frame = (id: string, text: string) => {
      const body = Buffer.concat([Buffer.from([3]), Buffer.from(text, 'utf8')]);
      const h = Buffer.alloc(10);
      h.write(id, 0, 'latin1');
      h.writeUInt32BE(body.length, 4);
      return Buffer.concat([h, body]);
    };
    const frames = Buffer.concat([frame('TIT2', 'Tidewater'), frame('TPE1', 'Mara Ellis'), frame('TSRC', 'NLA1Z2600123'), frame('TPUB', 'Northline Records')]);
    const header = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0]);
    const n = frames.length;
    header[6] = (n >> 21) & 0x7f;
    header[7] = (n >> 14) & 0x7f;
    header[8] = (n >> 7) & 0x7f;
    header[9] = n & 0x7f;
    expect(readId3(Buffer.concat([header, frames]))).toEqual({ title: 'Tidewater', artist: 'Mara Ellis', isrc: 'NLA1Z2600123', label: 'Northline Records' });
  });
});

describe('distributor inference', () => {
  it('weights label text, learned UPC prefixes and a licensed field', () => {
    const r = inferDistributor({ labelName: '1234567 Records DK', upc: '0193436123459' }, ALIASES, [{ kind: 'upc_prefix', value: '0193436', distributor: 'DistroKid', confirmations: 3 }]);
    expect(r.name).toBe('DistroKid');
    expect(r.confidence).toBeGreaterThan(0.9);
    expect(r.evidence.map((e) => e.signal)).toEqual(expect.arrayContaining(['label', 'UPC prefix 0193436']));
  });

  it('matches whole words only and reports competition', () => {
    expect(inferDistributor({ labelName: 'Unbelievers Music' }, ALIASES, []).name).toBeNull();
    const r = inferDistributor({ labelName: 'Believe', pLine: '℗ 2026 The Orchard Enterprises' }, ALIASES, []);
    expect(r.name).toBe('The Orchard');
    expect(r.confidence).toBeLessThan(0.85);
  });

  it('prefers a licensed provider distributor field', () => {
    const r = inferDistributor({ labelName: 'Some Label', licensedDistributor: 'AWAL' }, ALIASES, []);
    expect(r.name).toBe('AWAL');
    expect(r.evidence[0].source).toBe('licensed provider');
  });

  it('learns label strings and several UPC prefix lengths', () => {
    expect(hintsToLearn({ upc: '0724384960650', labelName: 'Parlophone' }, 'Warner')).toEqual([
      { kind: 'label_string', value: 'Parlophone', distributor: 'Warner' },
      { kind: 'upc_prefix', value: '0724384', distributor: 'Warner' },
      { kind: 'upc_prefix', value: '07243849', distributor: 'Warner' },
      { kind: 'upc_prefix', value: '072438496', distributor: 'Warner' },
    ]);
  });
});

describe('merge', () => {
  it('takes values by source priority and reports conflicts', () => {
    const m = mergeResults(
      { input: 'x' },
      [
        { source: 'deezer', isrc: 'GBDUW0000059', upc: '0724384960650', title: 'Harder, Better, Faster, Stronger', releaseDate: '2001-03-07', labelName: 'Parlophone (France)', artists: ['Daft Punk'] },
        { source: 'musicbrainz', isrc: 'GBDUW0000059', upc: '0724384960650', title: 'Harder Better Faster Stronger', releaseDate: '2001-03-12', labels: ['Virgin'], artists: ['Daft Punk'] },
      ],
      { aliases: ALIASES, hints: [] },
      [],
    );
    expect(m.isrc).toBe('GBDUW0000059');
    expect(m.title).toBe('Harder, Better, Faster, Stronger');
    expect(m.conflicts.map((c) => c.field)).toEqual(['releaseDate']); // titles differ only in punctuation
  });
});

describe('resolve with recorded API responses', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('resolves an ISRC through Deezer, MusicBrainz and iTunes', async () => {
    const responses: Record<string, unknown> = {
      'api.deezer.com/track/isrc:GBDUW0000059': { id: 3135556, title: 'Harder, Better, Faster, Stronger', isrc: 'GBDUW0000059', duration: 224, explicit_lyrics: false, link: 'https://www.deezer.com/track/3135556', contributors: [{ name: 'Daft Punk', role: 'Main' }], artist: { name: 'Daft Punk' }, album: { id: 302127, title: 'Discovery' } },
      'api.deezer.com/album/302127': { id: 302127, title: 'Discovery', upc: '724384960650', label: 'Parlophone (France)', release_date: '2001-03-07', record_type: 'album', tracks: { data: [{ id: 3135556, title: 'Harder, Better, Faster, Stronger', duration: 224 }] } },
      'api.deezer.com/track/3135556': { id: 3135556, title: 'Harder, Better, Faster, Stronger', isrc: 'GBDUW0000059', duration: 224 },
      'musicbrainz.org/ws/2/release/?query=barcode': { releases: [] },
      'musicbrainz.org/ws/2/isrc/GBDUW0000059': { recordings: [{ id: 'rec-1', releases: [{ id: 'rel-1', status: 'Official', date: '2001-03-12' }] }] },
      'musicbrainz.org/ws/2/release/rel-1': { id: 'rel-1', title: 'Discovery', date: '2001-03-12', barcode: '724384960650', 'label-info': [{ label: { name: 'Virgin' } }], 'release-group': { 'primary-type': 'Album' }, media: [{ position: 1, tracks: [{ position: 1, title: 'Harder, Better, Faster, Stronger', recording: { title: 'Harder, Better, Faster, Stronger', isrcs: ['GBDUW0000059'] } }] }] },
      'itunes.apple.com/lookup?upc=724384960650': { results: [{ wrapperType: 'collection', collectionId: 697194953, collectionName: 'Discovery', copyright: '℗ 2001 Daft Life Ltd. under exclusive license to Parlophone Records Ltd.', releaseDate: '2001-03-07T08:00:00Z' }] },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const key = Object.keys(responses).find((k) => String(url).includes(k));
        return new Response(JSON.stringify(key ? responses[key] : { error: { type: 'DataException', message: 'no data', code: 800 } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
    const r = await resolveMetadata({ kind: 'isrc', isrc: 'GBDUW0000059' }, { input: 'GBDUW0000059' }, { creds: {}, aliases: ALIASES, hints: [] });
    expect(r.isrc).toBe('GBDUW0000059');
    expect(r.upc).toBe('0724384960650');
    expect(r.releaseTitle).toBe('Discovery');
    expect(r.labelName).toBe('Parlophone (France)');
    expect(r.cLine).toContain('Parlophone');
    expect(r.platformIds.map((p) => p.platform)).toEqual(expect.arrayContaining(['deezer', 'musicbrainz', 'apple']));
    expect(r.sources.find((s) => s.source === 'spotify')?.skipped).toMatch(/Not connected/);
    expect(r.sources.find((s) => s.source === 'licensed')?.skipped).toMatch(/No licensed provider/);
    expect(r.conflicts.find((c) => c.field === 'releaseDate')).toBeTruthy();
  });
});
