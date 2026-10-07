import { defineWeb } from '@labelconsole/core/web';
import { manifest } from './manifest';
import DrivePage from './ui/browser';
import FilePage from './ui/file-page';
import { filesPanel } from './ui/panel';

export default defineWeb({
  manifest,
  pages: [
    { path: 'drive', permission: 'drive:read', component: DrivePage },
    { path: 'drive/files/:id', permission: 'drive:read', component: FilePage },
  ],
  panels: ['artist', 'release', 'track', 'campaign', 'contact'].map((entityType) => ({ id: `drive-files-${entityType}`, entityType, title: 'Files', order: 90, permission: 'drive:read', component: filesPanel(entityType) })),
});
