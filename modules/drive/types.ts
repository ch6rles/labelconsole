export {};

declare module '@labelconsole/core/events' {
  interface DomainEventMap {
    'drive.file.uploaded': { fileId: string; name: string; mime: string; folderId: string | null };
    'drive.folder.synced': { folderId: string; added: number; updated: number };
  }
}

declare module '@labelconsole/core/queue' {
  interface JobMap {
    'drive.scan-file': { fileId: string };
    'drive.sync-folder': { folderId: string };
    'drive.sync-all': Record<string, never>;
  }
}
