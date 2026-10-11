import type { ModuleManifest } from '@labelconsole/core/modules';

export const manifest: ModuleManifest = {
  id: 'discord',
  name: 'Discord',
  description: 'A private Discord app for the label: members link their Discord account, then look up songs and releases from any server or DM with /song.',
  icon: 'forum',
  plans: ['starter', 'growth', 'scale'],
  dependsOn: ['catalogue'],
  // Using the app needs catalogue:read; setting it up needs settings:credentials and settings:manage.
  permissions: [],
  nav: [
    {
      section: { id: 'settings', label: 'Settings', icon: 'settings', sub: 'Workspace, apps, integrations', order: 110 },
      tabs: [{ id: 'discord', label: 'Discord', href: '/settings/discord', order: 25 }],
    },
  ],
  events: { emits: [], listens: [] },
  tools: [],
};
