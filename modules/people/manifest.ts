import type { ModuleManifest } from '@labelconsole/core/modules';

export const PEOPLE_SECTION = { id: 'people', label: 'People', icon: 'account_circle', sub: 'Artists, onboarding, staff', order: 30 };

export const manifest: ModuleManifest = {
  id: 'people',
  name: 'People',
  description: 'Artist profiles, onboarding and the staff directory.',
  icon: 'account_circle',
  plans: ['starter', 'growth', 'scale'],
  permissions: [
    { key: 'people:read', description: 'View artists and staff' },
    { key: 'people:write', description: 'Create and edit artists and staff profiles' },
    { key: 'people:delete', description: 'Delete artists' },
  ],
  nav: [
    {
      section: PEOPLE_SECTION,
      tabs: [
        { id: 'artists', label: 'Artists', href: '/people/artists', permission: 'people:read', order: 10 },
        { id: 'onboarding', label: 'Onboarding', href: '/people/onboarding', permission: 'people:read', order: 20 },
        { id: 'staff', label: 'Staff', href: '/people/staff', permission: 'people:read', order: 40 },
      ],
    },
  ],
  events: { emits: ['people.artist.created', 'people.artist.updated', 'people.artist.status_changed'], listens: [] },
  tools: ['people_get_artist', 'people_list_roster', 'people_update_artist_status'],
};
