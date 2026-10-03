import type { ModuleManifest } from '@labelconsole/core/modules';

export const manifest: ModuleManifest = {
  id: 'streams',
  name: 'Streams',
  description: 'Per-track and per-artist stream counts from YouTube, licensed providers and statements, with alerts.',
  icon: 'monitoring',
  plans: ['growth', 'scale'],
  dependsOn: ['catalogue'],
  permissions: [
    { key: 'streams:read', description: 'View stream analytics and alerts' },
    { key: 'streams:manage', description: 'Review platform matches, set alert rules and polling' },
  ],
  nav: [
    {
      section: { id: 'streams', label: 'Streams', icon: 'monitoring', sub: 'Live stream analytics', order: 40 },
      tabs: [
        { id: 'overview', label: 'Overview', href: '/streams', permission: 'streams:read', order: 10 },
        { id: 'tracks', label: 'Tracks', href: '/streams/tracks', permission: 'streams:read', order: 20 },
        { id: 'matching', label: 'Matching', href: '/streams/matching', permission: 'streams:manage', order: 30 },
        { id: 'alerts', label: 'Alerts', href: '/streams/alerts', permission: 'streams:read', order: 40 },
      ],
    },
  ],
  events: { emits: ['streams.snapshot.recorded', 'streams.alert'], listens: ['catalogue.track.imported', 'catalogue.track.created', 'documents.statement.parsed', 'people.artist.created', 'people.artist.updated'] },
  tools: ['streams_get_history', 'streams_top_movers', 'streams_artist_audience', 'streams_spotify_artist_lookup', 'spotify_search', 'spotify_track_lookup', 'spotify_album_lookup', 'spotify_playlist_lookup', 'spotify_artist_discography'],
};
