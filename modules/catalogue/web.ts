import { defineWeb } from '@labelconsole/core/web';
import { manifest } from './manifest';
import DemosPage from './ui/demos';
import ImportPage from './ui/import';
import ImportReviewPage from './ui/import-review';
import ReleaseDetailPage from './ui/release-detail';
import ReleasesPage from './ui/releases';
import SplitsPage from './ui/splits';
import TrackDetailPage from './ui/track-detail';
import TracksPage from './ui/tracks';
import { artistReleasesPanel } from './ui/panels';

export default defineWeb({
  manifest,
  pages: [
    { path: 'catalog/releases', permission: 'catalogue:read', component: ReleasesPage },
    { path: 'catalog/releases/:id', permission: 'catalogue:read', component: ReleaseDetailPage },
    { path: 'catalog/tracks', permission: 'catalogue:read', component: TracksPage },
    { path: 'catalog/tracks/:id', permission: 'catalogue:read', component: TrackDetailPage },
    { path: 'catalog/demos', permission: 'catalogue:read', component: DemosPage },
    { path: 'catalog/import', permission: 'catalogue:write', component: ImportPage },
    { path: 'catalog/import/:id', permission: 'catalogue:read', component: ImportReviewPage },
    { path: 'finance/splits', permission: 'catalogue:read', component: SplitsPage },
  ],
  panels: [{ id: 'catalogue-artist-releases', entityType: 'artist', title: 'Releases', order: 10, permission: 'catalogue:read', component: artistReleasesPanel }],
});
