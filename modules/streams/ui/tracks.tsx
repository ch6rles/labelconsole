import type { PageProps } from '@labelconsole/core/web';
import { DataTable, FilterPills, Page, PageHeader, Sparkline, fmt, type Column } from '@labelconsole/ui';
import { ActionButton, SearchInput } from '@labelconsole/ui/client';
import * as svc from '../service';
import { STATUS_CHIP } from './shared';

type Row = Awaited<ReturnType<typeof svc.listTracked>>[number];

export default async function StreamTracksPage({ run, session, searchParams, path }: PageProps) {
  const status = (['tracking', 'pending_match', 'paused'] as const).find((s) => s === searchParams.status);
  const [rows, all] = await run((ctx) => Promise.all([svc.listTracked(ctx, { q: searchParams.q, status }), svc.listTracked(ctx, {})]));
  const n = (s?: string) => all.filter((r) => !s || r.status === s).length;
  const pill = (label: string, s?: string) => ({ label, count: n(s), href: s ? `${path}?status=${s}` : path, active: status === s });

  const columns: Column<Row>[] = [
    {
      key: 'track',
      header: 'Track',
      width: 'minmax(220px,1.5fr)',
      render: (r) => (
        <span className="lc-cell-stack">
          <span className="lc-cell-strong lc-ellipsis">{r.title}</span>
          <span className="lc-cell-sub lc-ellipsis">{r.artists.join(', ') || 'No artist'}{r.isrc ? ` · ${r.isrc}` : ''}</span>
        </span>
      ),
    },
    { key: 'status', header: 'Status', width: '140px', render: (r) => <span className={STATUS_CHIP[r.status]?.className ?? 'lc-chip'}>{STATUS_CHIP[r.status]?.label ?? r.status}</span> },
    { key: 'tier', header: 'Polling', width: '110px', render: (r) => <span style={{ fontSize: 13, color: 'var(--lc-text-2)' }}>{r.status !== 'tracking' ? '—' : r.tier === 'active' ? 'Every 6 h' : 'Daily'}</span> },
    { key: 'sources', header: 'Sources', width: '130px', render: (r) => <span style={{ fontSize: 13, color: 'var(--lc-text-2)' }}>{[r.spotify ? 'Spotify' : null, r.videos ? `${r.videos} video${r.videos === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ') || '—'}</span> },
    { key: 'trend', header: '28 days', width: '100px', render: (r) => <Sparkline values={r.spark} /> },
    { key: 'plays', header: 'Plays 28d', width: '100px', align: 'right', render: (r) => <span className="lc-cell-num">{r.spark.length ? fmt.compact(r.plays28d) : '—'}</span> },
    { key: 'total', header: 'Total', width: '100px', align: 'right', render: (r) => <span className="lc-cell-num lc-muted">{r.total != null ? fmt.compact(r.total) : '—'}</span> },
    {
      key: 'polled',
      header: 'Last reading',
      width: 'minmax(150px,1fr)',
      render: (r) =>
        r.lastError ? (
          <span className="lc-cell-sub lc-ellipsis" style={{ color: 'var(--lc-danger)' }} title={r.lastError}>{r.lastError}</span>
        ) : (
          <span className="lc-mono" style={{ fontSize: 12, color: 'var(--lc-muted)' }}>{r.lastPolledAt ? fmt.relative(r.lastPolledAt) : 'not yet'}</span>
        ),
    },
  ];

  return (
    <Page>
      <PageHeader
        title="Tracked tracks"
        description="Every catalogue track is registered with the tracker. Active tracks (recent releases, live campaigns) poll every 6 hours; back catalogue daily."
        actions={session.permissions.has('streams:manage') && <ActionButton endpoint="/streams/poll" body={{}} label="Refresh now" icon="refresh" success="Polling queued" />}
      />
      <div className="lc-toolbar">
        <FilterPills items={[pill('All'), pill('Tracking', 'tracking'), pill('Needs a match', 'pending_match'), pill('Paused', 'paused')]} />
        <SearchInput placeholder="Search title or ISRC" />
      </div>
      <DataTable rows={rows} rowKey={(r) => r.trackId} rowHref={(r) => `/streams/tracks/${r.trackId}`} columns={columns} minWidth={1060} empty={searchParams.q || status ? 'No tracks match.' : 'No tracks yet. Tracks are registered automatically when they enter the catalogue.'} />
    </Page>
  );
}
