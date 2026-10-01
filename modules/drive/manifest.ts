import type { ModuleManifest } from '@labelconsole/core/modules';

export const manifest: ModuleManifest = {
  id: 'drive',
  name: 'Drive',
  description: 'Label file storage with folders, per-folder permissions, previews and a Google Drive connector.',
  icon: 'folder',
  plans: ['starter', 'growth', 'scale'],
  permissions: [
    { key: 'drive:read', description: 'Browse and download files' },
    { key: 'drive:write', description: 'Upload files and create folders' },
    { key: 'drive:delete', description: 'Delete files and folders' },
    { key: 'drive:manage', description: 'Set folder permissions and connect Google Drive' },
  ],
  nav: [{ section: { id: 'drive', label: 'Drive', icon: 'folder_open', sub: 'Label file storage', order: 70 }, tabs: [{ id: 'files', label: 'Files', href: '/drive', permission: 'drive:read' }] }],
  events: { emits: ['drive.file.uploaded', 'drive.folder.synced'], listens: [] },
  tools: ['drive_list_files', 'drive_read_file', 'drive_save_file'],
};
