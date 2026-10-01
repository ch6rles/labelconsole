import { SpotScraperClient, type SpotifyAlbum, type SpotifyArtistStats, type SpotifyCredit, type SpotifyPlaylist, type SpotifyTrack } from '@labelconsole/core/spotscraper';

/**
 * A SpotScraper client that answers from an in-memory catalogue instead of
 * the network (tests only). It counts requests the way the real client does.
 */
export class FakeSpotScraper extends SpotScraperClient {
  tracks = new Map<string, SpotifyTrack>();
  albums = new Map<string, SpotifyAlbum>();
  credit = new Map<string, SpotifyCredit[]>();
  artists = new Map<string, SpotifyArtistStats>();
  playlists = new Map<string, SpotifyPlaylist>();
  searches: string[] = [];
  constructor() {
    super('test-key');
  }
  override async track(id: string) {
    this.requests++;
    return this.tracks.get(id) ?? null;
  }
  override async searchIsrc(isrc: string) {
    this.requests++;
    this.searches.push(isrc);
    return [...this.tracks.values()].filter((t) => t.isrc === isrc).sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0));
  }
  override async credits(id: string) {
    this.requests++;
    return this.credit.has(id) ? { credits: this.credit.get(id)!, copyright: null } : null;
  }
  override async album(id: string) {
    this.requests++;
    return this.albums.get(id) ?? null;
  }
  override async artist(id: string) {
    this.requests++;
    return this.artists.get(id) ?? null;
  }
  override async discoveredOn() {
    this.requests++;
    return [
      { id: '37i9dQZF1DX4UtSsGT1Sbe', name: 'Late Night Indie', description: null, ownerId: null, ownerName: 'Spotify', followers: null, trackCount: null, personalized: null },
      { id: '0A9tWS2qryvdrFJBObAque', name: 'my mix', description: null, ownerId: null, ownerName: 'fld5wrzio6qv6nus8yln7v71o', followers: null, trackCount: null, personalized: null },
    ];
  }
  override async playlist(id: string) {
    this.requests++;
    return this.playlists.get(id) ?? null;
  }
}

export const spTrack = (id: string, isrc: string, artist: string, popularity: number, playCount: number): SpotifyTrack => ({ id, name: 'Tidewater', isrc, durationMs: 214_000, explicit: false, popularity, playCount, artists: [{ id: `artist${id}`.slice(0, 22), name: artist }], album: null });
