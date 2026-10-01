import Link from 'next/link';
import { ROLE_LABELS, BUILT_IN_ROLES } from '@labelconsole/core/permissions';
import { getCredentialHandle } from '@labelconsole/core/vault';
import type { PageProps } from '@labelconsole/core/web';
import { Chip, EmptyState, Icon, KV, Page, PageHeader, SectionLabel, Summary, fmt } from '@labelconsole/ui';
import { ActionButton, Drawer, DrawerClose, FormModal, SearchInput, UploadZone } from '@labelconsole/ui/client';
import * as svc from '../service';

const ICON = (mime: string) => (mime.startsWith('image/') ? 'image' : mime.startsWith('audio/') ? 'audio_file' : mime.startsWith('video/') ? 'movie' : mime === 'application/pdf' ? 'picture_as_pdf' : mime.includes('sheet') || mime === 'text/csv' ? 'table' : 'draft');

export default async function DrivePage({ run, session, searchParams }: PageProps) {
  const folderId = searchParams.folder ?? null;
  const data = await run(async (ctx) => {
    const listing = await svc.listFolder(ctx, folderId, { q: searchParams.q });
    const thumbs = Object.fromEntries(
      await Promise.all(listing.files.filter((f) => f.mime.startsWith('image/') && f.status === 'ready').slice(0, 60).map(async (f) => [f.id, await svc.downloadUrl(ctx, f.id, { inline: true }).catch(() => null)] as const)),
    );
    const selected = searchParams.file ? await svc.getFile(ctx, searchParams.file).catch(() => null) : null;
    const selectedUrl = selected && selected.status !== 'quarantined' ? await svc.downloadUrl(ctx, selected.id, { inline: true }) : null;
    const grants = listing.folder ? await svc.listGrants(ctx, listing.folder.id) : [];
    const google = Boolean(await getCredentialHandle(ctx, 'google_drive'));
    const usage = await svc.storageUsage(ctx);
    return { ...listing, thumbs, selected, selectedUrl, grants, google, usage };
  });
  const here = (extra: Record<string, string> = {}) => `/drive?${new URLSearchParams({ ...(folderId ? { folder: folderId } : {}), ...extra })}`;
  const canEdit = data.access === 'edit' || data.access === 'manage';
  const canManage = session.permissions.has('drive:manage');
  const view = searchParams.view === 'list' ? 'list' : 'grid';

  return (
    <Page>
      <PageHeader
        title={data.folder?.name ?? 'Drive'}
        description={data.folder?.externalProvider === 'google_drive' ? `Mirrored from Google Drive${data.folder.lastSyncedAt ? ` · synced ${fmt.relative(data.folder.lastSyncedAt)}` : ' · first sync running'}` : 'Label files: audio, artwork, contracts and anything else, linked to the records they belong to.'}
        actions={
          <>
            {canEdit && <FormModal title="New folder" trigger={{ label: 'New folder', icon: 'create_new_folder' }} endpoint="/drive/folders" extra={{ parentId: folderId }} fields={[{ name: 'name', label: 'Folder name', required: true, full: true }]} columns={1} success="Folder created" />}
            {canManage && data.google && !folderId && (
              <FormModal title="Mirror a Google Drive folder" description="Paste the folder link or ID. Files are copied in read-only and refreshed every 30 minutes." trigger={{ label: 'Connect Google Drive folder', icon: 'add_to_drive' }} endpoint="/drive/google/connect" fields={[{ name: 'name', label: 'Name in Label Console', required: true }, { name: 'externalId', label: 'Google Drive folder link or ID', required: true, full: true }]} success="Folder connected; first sync started" />
            )}
            {canManage && data.folder?.externalProvider === 'google_drive' && <ActionButton endpoint={`/drive/folders/${data.folder.id}/sync`} label="Sync now" icon="sync" success="Sync queued" />}
          </>
        }
      />
      <div className="lc-toolbar">
        <nav className="lc-crumb" style={{ display: 'flex', fontSize: 13 }} aria-label="Folder path">
          <Link href="/drive">Drive</Link>
          {data.breadcrumb.map((b) => (
            <span key={b.id} style={{ display: 'contents' }}>
              <Icon name="chevron_right" size={14} />
              <Link href={`/drive?folder=${b.id}`}>{b.name}</Link>
            </span>
          ))}
        </nav>
        <span className="lc-toolbar-end lc-row" style={{ gap: 8 }}>
          <SearchInput placeholder="Search file names" width={260} />
          <Link className={`lc-tab${view === 'grid' ? ' is-active' : ''}`} href={here()} aria-label="Grid view"><Icon name="grid_view" size={16} /></Link>
          <Link className={`lc-tab${view === 'list' ? ' is-active' : ''}`} href={here({ view: 'list' })} aria-label="List view"><Icon name="list" size={16} /></Link>
        </span>
      </div>
      {data.folder?.syncError && <div className="lc-banner is-warn"><Icon name="sync_problem" /><div>Last sync failed: {data.folder.syncError}</div></div>}
      <Summary>
        {data.folders.length} folders · {data.files.length} files here · {fmt.bytes(data.usage.bytes)} used across Drive
      </Summary>
      {canEdit && !searchParams.q && <UploadZone endpoint="/drive/files" extra={folderId ? { folderId } : {}} />}
      {data.folders.length === 0 && data.files.length === 0 ? (
        <EmptyState icon="folder_open" title={searchParams.q ? 'No files match that search' : 'This folder is empty'}>
          {canEdit ? 'Drop files above, or create a folder.' : 'Nothing has been shared here yet.'}
        </EmptyState>
      ) : view === 'grid' ? (
        <div className="lc-file-grid">
          {data.folders.map((f) => (
            <Link key={f.id} href={`/drive?folder=${f.id}`} className="lc-file-tile">
              <span className="lc-file-thumb"><Icon name={f.externalProvider ? 'drive_folder_upload' : 'folder'} /></span>
              <span className="lc-file-meta">
                <span className="lc-ellipsis" style={{ fontWeight: 600, fontSize: 13 }}>{f.name}</span>
                <span className="lc-muted" style={{ fontSize: 11 }}>Folder</span>
              </span>
            </Link>
          ))}
          {data.files.map((f) => (
            <Link key={f.id} href={here({ file: f.id })} className="lc-file-tile" scroll={false}>
              <span className="lc-file-thumb">{data.thumbs[f.id] ? <img src={data.thumbs[f.id]!} alt="" /> : <Icon name={ICON(f.mime)} />}</span>
              <span className="lc-file-meta">
                <span className="lc-ellipsis" style={{ fontWeight: 600, fontSize: 13 }}>{f.name}</span>
                <span className="lc-muted lc-mono" style={{ fontSize: 11 }}>
                  {fmt.bytes(f.size)} · {fmt.shortDate(f.createdAt)}
                  {f.confidential ? ' · CONFIDENTIAL' : ''}
                </span>
              </span>
            </Link>
          ))}
        </div>
      ) : (
        <div className="lc-list">
          {data.folders.map((f) => (
            <Link key={f.id} href={`/drive?folder=${f.id}&view=list`} className="lc-popover-item" style={{ padding: '10px 16px' }}>
              <Icon name="folder" />
              <span style={{ flex: 1 }}>{f.name}</span>
            </Link>
          ))}
          {data.files.map((f) => (
            <Link key={f.id} href={here({ file: f.id, view: 'list' })} className="lc-popover-item" style={{ padding: '10px 16px' }} scroll={false}>
              <Icon name={ICON(f.mime)} />
              <span style={{ flex: 1 }} className="lc-ellipsis">{f.name}</span>
              <span className="lc-mono lc-muted" style={{ fontSize: 12 }}>{fmt.bytes(f.size)}</span>
              <span className="lc-mono lc-muted" style={{ fontSize: 12, width: 90, textAlign: 'right' }}>{fmt.shortDate(f.createdAt)}</span>
            </Link>
          ))}
        </div>
      )}
      {canManage && data.folder && (
        <section className="lc-card">
          <div className="lc-card-head">
            <div className="lc-card-head-text">
              <span className="lc-card-title">Folder access</span>
              <span className="lc-card-sub">{data.grants.length ? 'Only the people and roles below can open this folder and everything in it.' : 'Everyone with Drive access can open this folder. Add a grant to restrict it.'}</span>
            </div>
            <FormModal
              title="Grant access"
              trigger={{ label: 'Add grant', icon: 'lock_person', size: 'sm' }}
              endpoint={`/drive/folders/${data.folder.id}/permissions`}
              method="PUT"
              initial={{ principalType: 'role', access: 'view' }}
              fields={[
                { name: 'principalType', label: 'Grant to', type: 'select', required: true, options: [{ value: 'role', label: 'A role' }, { value: 'user', label: 'A person (user id)' }] },
                { name: 'principal', label: 'Role or user id', required: true, hint: `Roles: ${BUILT_IN_ROLES.join(', ')}` },
                { name: 'access', label: 'Access', type: 'select', required: true, options: [{ value: 'view', label: 'View' }, { value: 'edit', label: 'Edit' }] },
              ]}
            />
          </div>
          {data.grants.map((g) => (
            <div key={g.id} className="lc-setting-row">
              <Icon name={g.principalType === 'role' ? 'groups' : 'person'} />
              <span style={{ flex: 1, fontSize: 14 }}>{g.principalType === 'role' ? ROLE_LABELS[g.principal as keyof typeof ROLE_LABELS] ?? g.principal : g.principal}</span>
              <Chip tone="blue">{fmt.titleCase(g.access)}</Chip>
              <ActionButton iconOnly icon="close" title="Remove grant" endpoint={`/drive/permissions/${g.id}`} method="DELETE" variant="danger" />
            </div>
          ))}
        </section>
      )}
      {data.selected && (
        <Drawer closeHref={here(view === 'list' ? { view } : {})} wide>
          <div className="lc-drawer-head">
            <span className="lc-cover" style={{ width: 52, height: 52 }}><Icon name={ICON(data.selected.mime)} /></span>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span className="lc-drawer-title" style={{ fontSize: 18, wordBreak: 'break-word' }}>{data.selected.name}</span>
              <div className="lc-row" style={{ gap: 6 }}>
                <Chip>{data.selected.mime}</Chip>
                {data.selected.confidential && <Chip tone="ink">Confidential</Chip>}
                <Chip tone={data.selected.scanStatus === 'clean' ? 'blue' : data.selected.scanStatus === 'infected' ? 'red' : 'neutral'}>Scan: {data.selected.scanStatus}</Chip>
              </div>
            </div>
            <DrawerClose closeHref={here(view === 'list' ? { view } : {})} />
          </div>
          <div className="lc-drawer-section">
            {data.selectedUrl && data.selected.mime.startsWith('image/') && <img src={data.selectedUrl} alt={data.selected.name} style={{ maxWidth: '100%', border: '1px solid var(--lc-border)' }} />}
            {data.selectedUrl && data.selected.mime.startsWith('audio/') && <audio controls src={data.selectedUrl} style={{ width: '100%' }} />}
            {data.selectedUrl && data.selected.mime.startsWith('video/') && <video controls src={data.selectedUrl} style={{ width: '100%' }} />}
            {data.selectedUrl && data.selected.mime === 'application/pdf' && <iframe title="Preview" src={data.selectedUrl} style={{ width: '100%', height: 420, border: '1px solid var(--lc-border)' }} />}
            {!data.selectedUrl && <span className="lc-danger-text">This file failed the virus scan and is quarantined.</span>}
          </div>
          <div className="lc-drawer-section">
            <SectionLabel>Details</SectionLabel>
            <KV k="Size" v={fmt.bytes(data.selected.size)} />
            <KV k="Uploaded" v={`${fmt.date(data.selected.createdAt)} · ${fmt.time(data.selected.createdAt)} UTC`} />
            <KV k="SHA-256" v={<span className="lc-mono" style={{ fontSize: 11 }}>{data.selected.checksum?.slice(0, 16)}…</span>} />
            {data.selected.externalProvider && <KV k="Source" v="Google Drive mirror" />}
          </div>
          <div className="lc-drawer-foot">
            {data.selectedUrl && <a className="lc-btn lc-btn--primary lc-btn--block" href={`/api/v1/drive/files/${data.selected.id}/download`}><Icon name="download" />Download</a>}
            {session.permissions.has('drive:delete') && <ActionButton endpoint={`/drive/files/${data.selected.id}`} method="DELETE" label="Delete" icon="delete" confirm={`Delete ${data.selected.name}?`} redirectTo={here()} />}
          </div>
        </Drawer>
      )}
    </Page>
  );
}
