import { describe, expect, it } from 'vitest';
import { FakeSpotScraper, spTrack } from '../../../test/fake-spotscraper';
import { mergeResults } from './resolve';
import { spotScraperLookup } from './sources/spotscraper';

function catalogue() {
  const sp = new FakeSpotScraper();
  sp.tracks.set('4PTG3Z6ehGkBFwjybzWkR8', { ...spTrack('4PTG3Z6ehGkBFwjybzWkR8', 'NLA1Z2600123', 'Mara Ellis', 70, 1), album: { id: '6N9PS4QXF1D0OWPk0Sxtb4', name: 'Tidewater', copyright: '(P) 2026 Northline Records' } });
  sp.albums.set('6N9PS4QXF1D0OWPk0Sxtb4', {
    id: '6N9PS4QXF1D0OWPk0Sxtb4',
    name: 'Tidewater',
    upc: '035627515026',
    label: 'Northline Records',
    copyright: '(P) 2026 Northline Records',
    releaseDate: '2026-03-06',
    artists: [],
    totalTracks: 2,
    tracks: [
      { id: '4PTG3Z6ehGkBFwjybzWkR8', name: 'Tidewater', durationMs: 214_000, trackNumber: 1, playCount: 1, artists: [{ id: '1dfeR4HaWDbWqFHLkxsg1d', name: 'Mara Ellis' }] },
      { id: '6aiKIFjPwa3UvDCD5ecoJj', name: 'Undertow', durationMs: 190_000, trackNumber: 2, playCount: 1, artists: [{ id: '1dfeR4HaWDbWqFHLkxsg1d', name: 'Mara Ellis' }] },
    ],
  });
  return sp;
}

describe('SpotScraper metadata source', () => {
  it('resolves an ISRC to the release: UPC, label, date, ℗ line, tracklist and Spotify IDs', async () => {
    const sp = catalogue();
    const r = await spotScraperLookup(sp, { isrc: 'NLA1Z2600123' });
    expect(r).toMatchObject({ source: 'spotscraper', isrc: 'NLA1Z2600123', title: 'Tidewater', artists: ['Mara Ellis'], upc: '0035627515026', labelName: 'Northline Records', releaseDate: '2026-03-06', pLine: '(P) 2026 Northline Records', cLine: null });
    expect(r?.tracks?.map((t) => `${t.position}. ${t.title}`)).toEqual(['1. Tidewater', '2. Undertow']);
    expect(r?.platformIds?.map((p) => `${p.entity}:${p.externalId}`)).toEqual(['track:4PTG3Z6ehGkBFwjybzWkR8', 'release:6N9PS4QXF1D0OWPk0Sxtb4']);
    expect(sp.requests).toBe(2);
  });

  it('resolves a Spotify link without Spotify Web API credentials, and finds nothing for an unknown ISRC', async () => {
    const sp = catalogue();
    expect(await spotScraperLookup(sp, { spotifyAlbumId: '6N9PS4QXF1D0OWPk0Sxtb4' })).toMatchObject({ upc: '0035627515026', releaseTitle: 'Tidewater', isrc: null });
    expect(await spotScraperLookup(sp, { isrc: 'GBARL9300135' })).toBeNull();
  });

  it('ranks just below the Spotify Web API when sources disagree', () => {
    const merged = mergeResults({}, [{ source: 'deezer', labelName: 'Other Label' }, { source: 'spotscraper', labelName: 'Northline Records' }], { aliases: [], hints: [] }, []);
    expect(merged.labelName).toBe('Northline Records');
    expect(merged.conflicts.map((c) => c.field)).toEqual(['labelName']);
  });
});
