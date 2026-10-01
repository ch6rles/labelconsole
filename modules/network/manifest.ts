import type { ModuleManifest } from '@labelconsole/core/modules';

export const MARKETING_SECTION = { id: 'marketing', label: 'Marketing', icon: 'campaign', sub: 'Campaigns, creator network', order: 20 };

export const manifest: ModuleManifest = {
  id: 'network',
  name: 'Network',
  description: 'Contact CRM for creators, playlist editors, curators and press.',
  icon: 'group',
  plans: ['growth', 'scale'],
  permissions: [
    { key: 'network:read', description: 'View contacts, playlists and interactions' },
    { key: 'network:write', description: 'Add and edit contacts and log interactions' },
    { key: 'network:delete', description: 'Delete contacts' },
  ],
  nav: [
    {
      section: MARKETING_SECTION,
      tabs: [
        { id: 'contacts', label: 'Creators & Contacts', href: '/marketing/contacts', permission: 'network:read', order: 60 },
        { id: 'playlists', label: 'Playlists', href: '/marketing/playlists', permission: 'network:read', order: 70 },
      ],
    },
  ],
  events: { emits: ['network.contact.created', 'network.interaction.logged'], listens: [] },
  tools: ['network_find_contacts', 'network_add_contact', 'network_log_interaction'],
};
