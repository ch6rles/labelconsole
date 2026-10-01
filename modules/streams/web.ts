import { defineWeb } from '@labelconsole/core/web';
import { manifest } from './manifest';
import StreamAlertsPage from './ui/alerts';
import StreamMatchingPage from './ui/matching';
import StreamsOverviewPage from './ui/overview';
import { artistStreamsPanel, trackStreamsPanel } from './ui/panels';
import StreamTrackPage from './ui/track-detail';
import StreamTracksPage from './ui/tracks';

export default defineWeb({
  manifest,
  pages: [
    { path: 'streams', permission: 'streams:read', component: StreamsOverviewPage },
    { path: 'streams/tracks', permission: 'streams:read', component: StreamTracksPage },
    { path: 'streams/tracks/:id', permission: 'streams:read', component: StreamTrackPage },
    { path: 'streams/matching', permission: 'streams:manage', component: StreamMatchingPage },
    { path: 'streams/alerts', permission: 'streams:read', component: StreamAlertsPage },
  ],
  panels: [
    { id: 'streams-track', entityType: 'track', title: 'Streams', order: 15, permission: 'streams:read', component: trackStreamsPanel },
    { id: 'streams-artist', entityType: 'artist', title: 'Streams', order: 15, permission: 'streams:read', component: artistStreamsPanel },
  ],
});
