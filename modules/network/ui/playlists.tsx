import Link from 'next/link';
import type { PageProps } from '@labelconsole/core/web';
import { DataTable, Page, PageHeader, fmt } from '@labelconsole/ui';
import { ActionButton, FilterSelect, FormModal, SearchInput } from '@labelconsole/ui/client';
import * as svc from '../service';
import { playlistFields } from './fields';

export default async function PlaylistsPage({ run, session, searchParams }: PageProps) {
  const [rows, curators] = await run((ctx) => Promise.all([svc.listPlaylists(ctx, { q: searchParams.q, platform: searchParams.platform }), svc.listContacts(ctx, {})]));
  const options = curators.filter((c) => c.type !== 'creator' && !c.goneAt).map((c) => ({ value: c.id, label: c.name }));
  const canWrite = session.permissions.has('network:write');
  return (
    <Page>
      <PageHeader
        title="Playlists"
        description="Playlists and their curators, for playlist outreach. Pitches to them are tracked under Outreach."
        actions={canWrite && <FormModal title="Add playlist" trigger={{ label: 'Add playlist', icon: 'playlist_add', variant: 'primary' }} endpoint="/network/playlists" fields={playlistFields(options)} initial={{ platform: 'spotify' }} success="Playlist added" />}
      />
      <div className="lc-toolbar">
        <SearchInput placeholder="Playlist or curator" />
        <FilterSelect param="platform" allLabel="All platforms" options={['spotify', 'apple_music', 'youtube', 'deezer', 'soundcloud'].map((p) => ({ value: p, label: fmt.titleCase(p.replace('_', ' ')) }))} />
        <span className="lc-toolbar-end">{rows.length} playlists</span>
      </div>
      <DataTable
        rows={rows}
        rowKey={(r) => r.playlist.id}
        minWidth={900}
        empty="No playlists yet."
        columns={[
          { key: 'n', header: 'Playlist', width: 'minmax(220px,1.4fr)', render: (r) => <span className="lc-cell-stack">{r.playlist.url ? <a href={r.playlist.url} target="_blank" rel="noreferrer" className="lc-cell-strong" style={{ color: 'var(--lc-ink)' }}>{r.playlist.name}</a> : <span className="lc-cell-strong">{r.playlist.name}</span>}<span className="lc-cell-sub">{r.playlist.genres.join(', ') || '—'}</span></span> },
          { key: 'p', header: 'Platform', width: '120px', render: (r) => <span style={{ fontSize: 13 }}>{fmt.titleCase(r.playlist.platform.replace('_', ' '))}</span> },
          { key: 'c', header: 'Curator', width: 'minmax(160px,1fr)', render: (r) => (r.playlist.contactId ? <Link href={`/marketing/contacts/${r.playlist.contactId}`}>{r.curator}</Link> : <span className="lc-muted">—</span>) },
          { key: 'f', header: 'Followers', width: '110px', align: 'right', render: (r) => <span className="lc-cell-num">{r.playlist.followers != null ? fmt.compact(r.playlist.followers) : '—'}</span> },
          { key: 'x', header: '', width: '60px', align: 'right', render: (r) => (session.permissions.has('network:delete') ? <ActionButton iconOnly icon="delete" title="Delete" variant="danger" endpoint={`/network/playlists/${r.playlist.id}`} method="DELETE" confirm={`Delete ${r.playlist.name}?`} /> : null) },
        ]}
      />
    </Page>
  );
}
