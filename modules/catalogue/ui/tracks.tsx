import { enrich } from '@labelconsole/core/modules';
import { listArtists } from '@labelconsole/people/service';
import type { PageProps } from '@labelconsole/core/web';
import { Chip, DataTable, FilterPills, Page, PageHeader, Summary, fmt } from '@labelconsole/ui';
import { ActionButton, FormModal, SearchInput } from '@labelconsole/ui/client';
import * as svc from '../service';
import { trackFields } from './fields';
import { SpotifyPlays, YouTubeMusicPlays, type PlaysExtra } from './plays';

export default async function TracksPage({ run, session, searchParams, enabled }: PageProps) {
  const status = searchParams.status === 'ready' || searchParams.status === 'draft' ? searchParams.status : undefined;
  const { rows, all, artistOptions, plays } = await run(async (ctx) => {
    const rows = await svc.listTracks(ctx, { q: searchParams.q, status });
    return {
      rows,
      all: await svc.listTracks(ctx, { q: searchParams.q }),
      artistOptions: ctx.can('people:read') ? (await listArtists(ctx)).map((a) => ({ value: a.id, label: a.name })) : [],
      plays: (await enrich(ctx, enabled, 'track', rows.map((t) => t.id))) as Record<string, PlaysExtra>,
    };
  });
  const missingIsrc = all.filter((t) => !t.isrc).length;
  return (
    <Page>
      <PageHeader title="All tracks" description="Every recording in the catalogue, with what still blocks delivery." actions={
          session.permissions.has('catalogue:write') && (
            <>
              {all.some((t) => t.blockers.includes('No credits')) && <ActionButton endpoint="/catalogue/credits/import" label="Credits from Spotify" icon="download" title="Import Spotify credits for every track that has none" success="Import queued: credits appear as each track is read" />}
              <FormModal title="New track" trigger={{ label: 'New track', icon: 'add', variant: 'primary' }} endpoint="/catalogue/tracks" fields={trackFields(artistOptions)} redirectTo="/catalog/tracks/{id}" wide />
            </>
          )
        }
      />
      <div className="lc-toolbar">
        <SearchInput placeholder="Search title or ISRC" />
        <FilterPills
          items={[
            { label: 'All', count: all.length, href: '/catalog/tracks', active: !status },
            { label: 'Ready', count: all.filter((t) => t.status === 'ready').length, href: '/catalog/tracks?status=ready', active: status === 'ready' },
            { label: 'Blocked', count: all.filter((t) => t.status === 'draft').length, href: '/catalog/tracks?status=draft', active: status === 'draft' },
          ]}
        />
      </div>
      <Summary>{all.length} tracks · {missingIsrc} without ISRC</Summary>
      <DataTable
        rows={rows}
        rowKey={(t) => t.id}
        rowHref={(t) => `/catalog/tracks/${t.id}`}
        minWidth={1160}
        empty="No tracks match."
        columns={[
          { key: 'title', header: 'Track', width: 'minmax(220px,1.3fr)', render: (t) => <span className="lc-cell-stack"><span className="lc-cell-strong lc-ellipsis">{t.title}{t.version ? ` (${t.version})` : ''}</span><span className="lc-cell-sub lc-ellipsis">{t.artists.map((a) => a.name).join(', ') || '—'}</span></span> },
          { key: 'release', header: 'Release', width: 'minmax(160px,1fr)', render: (t) => <span className="lc-ellipsis" style={{ fontSize: 13, color: 'var(--lc-text-2)' }}>{t.releases.map((r) => r.title).join(', ') || '—'}</span> },
          { key: 'isrc', header: 'ISRC', width: '150px', render: (t) => <span className="lc-mono" style={{ fontSize: 12 }}>{svc.formatIsrc(t.isrc) ?? '—'}</span> },
          { key: 'dur', header: 'Length', width: '70px', align: 'right', render: (t) => <span className="lc-cell-num">{fmt.duration(t.durationMs)}</span> },
          { key: 'plays', header: 'Spotify plays', width: '120px', align: 'right', render: (t) => <SpotifyPlays e={plays[t.id]} /> },
          { key: 'ytm', header: 'YouTube Music', width: '120px', align: 'right', render: (t) => <YouTubeMusicPlays e={plays[t.id]} /> },
          { key: 'status', header: 'Status', width: 'minmax(220px,1fr)', render: (t) => (t.blockers.length ? <span className="lc-row" style={{ gap: 4 }}>{t.blockers.slice(0, 3).map((b) => <Chip key={b} tone="red">{b}</Chip>)}</span> : <Chip tone="blue">Ready</Chip>) },
        ]}
      />
    </Page>
  );
}
