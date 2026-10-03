import type { ModuleManifest } from '@labelconsole/core/modules';

export const CATALOG_SECTION = { id: 'catalog', label: 'Catalog', icon: 'album', sub: 'Releases, tracks, demos', order: 10 };
export const FINANCE_SECTION = { id: 'finance', label: 'Finance', icon: 'account_balance_wallet', sub: 'Statements, royalties, splits', order: 50 };

export const manifest: ModuleManifest = {
  id: 'catalogue',
  name: 'Catalogue',
  description: 'Releases, tracks, demos and assets, with ISRC/UPC lookup on import.',
  icon: 'album',
  plans: ['starter', 'growth', 'scale'],
  dependsOn: ['people', 'drive'],
  permissions: [
    { key: 'catalogue:read', description: 'View releases, tracks, demos and splits' },
    { key: 'catalogue:write', description: 'Create and edit releases, tracks, demos, credits and splits' },
    { key: 'catalogue:delete', description: 'Delete releases, tracks and demos' },
    { key: 'catalogue:export', description: 'Export catalogue data' },
  ],
  nav: [
    {
      section: CATALOG_SECTION,
      tabs: [
        { id: 'releases', label: 'Releases', href: '/catalog/releases', permission: 'catalogue:read', order: 10 },
        { id: 'tracks', label: 'All Tracks', href: '/catalog/tracks', permission: 'catalogue:read', order: 20 },
        { id: 'demos', label: 'Demos', href: '/catalog/demos', permission: 'catalogue:read', order: 30 },
        { id: 'import', label: 'Track Import', href: '/catalog/import', permission: 'catalogue:write', order: 40 },
      ],
    },
    { section: FINANCE_SECTION, tabs: [{ id: 'splits', label: 'Splits', href: '/finance/splits', permission: 'catalogue:read', order: 30 }] },
  ],
  events: {
    emits: ['catalogue.release.created', 'catalogue.release.updated', 'catalogue.track.created', 'catalogue.track.imported', 'catalogue.demo.submitted', 'catalogue.demo.scored'],
    listens: [],
  },
  tools: ['catalogue_search', 'catalogue_get_track', 'catalogue_get_release', 'catalogue_create_release_draft', 'catalogue_update_release', 'catalogue_list_demos', 'catalogue_score_demo', 'catalogue_release_checklist', 'catalogue_sync_spotify_artist'],
};
