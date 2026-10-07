import type { PageProps } from '@labelconsole/core/web';
import * as svc from '../service';
import { fileKind } from '../kinds';
import { FileShell } from './file-shell';

/** Where a record a file is attached to lives in the console. */
const RECORD: Record<string, { label: string; href: (id: string) => string; icon: string }> = {
  artist: { label: 'Artist', href: (id) => `/people/artists/${id}`, icon: 'person' },
  release: { label: 'Release', href: (id) => `/catalog/releases/${id}`, icon: 'album' },
  track: { label: 'Track', href: (id) => `/catalog/tracks/${id}`, icon: 'music_note' },
  campaign: { label: 'Campaign', href: (id) => `/marketing/campaigns/${id}`, icon: 'campaign' },
  contact: { label: 'Contact', href: (id) => `/marketing/contacts/${id}`, icon: 'contact_page' },
};

/** A Drive file on its own page: the viewer full size, with the file's details and actions around it. */
export default async function FilePage({ run, params, session }: PageProps) {
  const data = await run(async (ctx) => {
    const file = await svc.getFile(ctx, params.id);
    const folder = file.folderId ? await svc.getFolder(ctx, file.folderId) : null;
    const access = await svc.folderAccess(ctx, folder);
    const canEdit = session.permissions.has('drive:write') && (access === 'edit' || access === 'manage') && !file.externalProvider;
    const [crumbs, nav, links, folders] = await Promise.all([
      svc.breadcrumb(ctx, folder),
      svc.siblings(ctx, file.id),
      svc.linksOf(ctx, file.id),
      canEdit ? svc.folderOptions(ctx) : Promise.resolve([] as Array<{ value: string; label: string }>),
    ]);
    return { file, crumbs, nav, links, folders, canEdit };
  });
  const f = data.file;
  const folderHref = f.folderId ? `/drive?folder=${f.folderId}` : '/drive';
  return (
    <FileShell
      file={{ id: f.id, name: f.name, mime: f.mime, size: f.size, kind: fileKind(f.name, f.mime) }}
      details={{
        createdAt: new Date(f.createdAt).toISOString(),
        checksum: f.checksum,
        scanStatus: f.scanStatus,
        quarantined: f.status === 'quarantined',
        confidential: f.confidential,
        source: f.externalProvider === 'google_drive' ? 'Google Drive mirror' : null,
      }}
      crumbs={data.crumbs}
      folderHref={folderHref}
      nav={data.nav}
      links={data.links.map((l) => {
        const r = RECORD[l.entityType];
        return { id: l.entityId, label: r?.label ?? l.entityType, icon: r?.icon ?? 'link', href: r ? r.href(l.entityId) : null };
      })}
      folders={data.folders}
      can={{ edit: data.canEdit, delete: data.canEdit && session.permissions.has('drive:delete'), confidential: data.canEdit && (session.permissions.has('documents:read_confidential') || session.permissions.has('drive:manage')) }}
    />
  );
}
