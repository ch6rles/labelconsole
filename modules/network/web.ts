import { defineWeb } from '@labelconsole/core/web';
import { manifest } from './manifest';
import ContactDetailPage from './ui/contact-detail';
import ContactsPage from './ui/contacts';
import PlaylistsPage from './ui/playlists';

export default defineWeb({
  manifest,
  pages: [
    { path: 'marketing/contacts', permission: 'network:read', component: ContactsPage },
    { path: 'marketing/contacts/:id', permission: 'network:read', component: ContactDetailPage },
    { path: 'marketing/playlists', permission: 'network:read', component: PlaylistsPage },
  ],
});
