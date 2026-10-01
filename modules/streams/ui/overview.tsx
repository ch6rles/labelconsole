import Link from 'next/link';
import type { PageProps } from '@labelconsole/core/web';
import { Banner, Card, DataTable, Legend, LineChart, Page, PageHeader, StatCard, Summary, fmt, type Column } from '@labelconsole/ui';
import { ActionButton } from '@labelconsole/ui/client';
import * as svc from '../service';
import { platformLabel } from '../sources/types';
import { platformColor, playsSeries } from './shared';

type Mover = Awaited<ReturnType<typeof svc.movers>>['gainers'][number];

export default async function StreamsOverviewPage({ run, session, searchParams, path }: PageProps) {
  const window = searchParams.window === '28d' ? '28d' : '7d';
  const [o, m, sources] = await run((ctx) => Promise.all([svc.overview(ctx), svc.movers(ctx, { window, limit: 8 }), svc.sourceStatus(ctx)]));
  const canManage = session.permissions.has('streams:manage');
  const series = playsSeries(o.daily, 90);

  const moverCols: Column<Mover>[] = [
    { key: 't', header: 'Track', width: 'minmax(200px,1.4fr)', render: (r) => <span className="lc-cell-stack"><span className="lc-cell-strong lc-ellipsis">{r.title}</span><span className="lc-cell-sub lc-ellipsis">{r.artists.join(', ') || '—'}</span></span> },
    { key: 'c', header: `Plays ${window}`, width: '110px', align: 'right', render: (r) => <span className="lc-cell-num">{fmt.compact(r.current)}</span> },
    { key: 'p', header: 'Before', width: '100px', align: 'right', render: (r) => <span className="lc-cell-num lc-muted">{fmt.compact(r.previous)}</span> },
    { key: 'd', header: 'Change', width: '110px', align: 'right', render: (r) => <span className="lc-cell-num" style={{ color: r.change < 0 ? 'var(--lc-danger)' : 'var(--lc-accent-hover)' }}>{r.changePct != null ? fmt.pct(r.changePct, { signed: true }) : fmt.compact(r.change, { signed: true })}</span> },
  ];

  return (
    <Page>
      <PageHeader
        title="Streams"
        description="Plays per day from Spotify play counts (SpotScraper) and official YouTube views, plus exact statement counts. Sources are never blended."
        actions={canManage && <ActionButton endpoint="/streams/poll" body={{}} label="Refresh now" icon="refresh" success="Polling queued" />}
      />
      <Summary>
        {o.tracking.tracking} tracks tracked · {o.tracking.pendingMatch} waiting for a match · {o.tracking.paused} paused{o.throughDay ? ` · through ${o.throughDay}` : ''} · Spotify plays {sources.spotify ? 'on' : 'off'}{sources.licensed ? ' · licensed DSP counts configured' : ''}
      </Summary>
      {!sources.spotify && (
        <Banner icon="key" warn>
          Spotify play counts need a SpotScraper key. {session.permissions.has('settings:credentials') ? <Link href="/settings/integrations">Add it under Settings → Integrations</Link> : 'Ask an admin to add one under Settings → Integrations'}. Tracks are matched by ISRC; each poll is one request per track.
        </Banner>
      )}
      {!sources.youtube && (
        <Banner icon="key" warn>
          YouTube views need a YouTube Data API key. {session.permissions.has('settings:credentials') ? <Link href="/settings/integrations">Add it under Settings → Integrations</Link> : 'Ask an admin to add one under Settings → Integrations'}. Polling uses videos.list, 1 quota unit per 50 videos.
        </Banner>
      )}
      <div className="lc-grid-stats">
        <StatCard label="PLAYS · 28D" icon="visibility" value={o.throughDay ? fmt.compact(o.plays28d) : '—'} delta={o.changePct != null ? fmt.pct(o.changePct, { signed: true, decimals: 1 }) : undefined} deltaDown={(o.changePct ?? 0) < 0} note="vs the 28 days before · polled sources" />
        {o.byPlatform.slice(0, 1).map((p) => (
          <StatCard key={p.platform} label={`${platformLabel(p.platform).toUpperCase()} · 28D`} icon={p.platform === 'youtube' ? 'smart_display' : 'graphic_eq'} value={fmt.compact(p.current)} delta={p.previous > 0 ? fmt.pct(((p.current - p.previous) / p.previous) * 100, { signed: true }) : undefined} deltaDown={p.current < p.previous} note={p.platform === 'youtube' ? 'official view counts' : p.platform === 'spotify' ? 'Spotify play counts' : 'licensed provider'} />
        ))}
        {o.byPlatform.length === 0 && <StatCard label="YOUTUBE · 28D" icon="smart_display" value="—" note={sources.youtube ? 'first readings pending' : 'needs an API key'} />}
        <StatCard label="LATEST STATEMENT" icon="receipt_long" value={o.statement ? fmt.compact(o.statement.units) : '—'} note={o.statement ? `units, period ending ${fmt.date(o.statement.periodEnd)}` : 'import one under Finance'} href="/finance/statements" />
        <StatCard label="OPEN ALERTS" icon="notifications_active" value={String(o.openAlerts)} note="spikes, drops, milestones" href="/streams/alerts" />
      </div>
      <Card title="Plays per day · 90 days" actions={<Legend items={series.map((s, i) => ({ label: s.name, color: s.color ?? platformColor('', i) }))} />}>
        <LineChart series={series} height={240} />
      </Card>
      <div className="lc-row" style={{ justifyContent: 'space-between' }}>
        <h2 className="lc-h2" style={{ fontSize: 17 }}>Top movers</h2>
        <span className="lc-row" style={{ gap: 6 }}>
          <Link className={`lc-btn lc-btn--sm${window === '7d' ? ' lc-btn--primary' : ''}`} href={`${path}?window=7d`}>7 days</Link>
          <Link className={`lc-btn lc-btn--sm${window === '28d' ? ' lc-btn--primary' : ''}`} href={`${path}?window=28d`}>28 days</Link>
        </span>
      </div>
      <div className="lc-grid-2">
        <DataTable title="Gaining" rows={m.gainers} rowKey={(r) => r.trackId} rowHref={(r) => `/streams/tracks/${r.trackId}`} columns={moverCols} minWidth={480} empty="No gains yet. Movers appear after two windows of readings." />
        <DataTable title="Slowing" rows={m.decliners} rowKey={(r) => r.trackId} rowHref={(r) => `/streams/tracks/${r.trackId}`} columns={moverCols} minWidth={480} empty="Nothing slowing down." />
      </div>
    </Page>
  );
}
