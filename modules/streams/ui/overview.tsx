import Link from 'next/link';
import type { PageProps } from '@labelconsole/core/web';
import { Banner, Card, DataTable, Page, PageHeader, StatCard, Summary, fmt, type Column } from '@labelconsole/ui';
import { ActionButton } from '@labelconsole/ui/client';
import { TimeSeriesChart } from '@labelconsole/ui/timeseries';
import * as svc from '../service';
import { platformLabel } from '../sources/types';
import { PLAY_RANGES, platformLines } from './shared';

type Mover = Awaited<ReturnType<typeof svc.movers>>['gainers'][number];

export default async function StreamsOverviewPage({ run, session, searchParams, path }: PageProps) {
  const window = searchParams.window === '28d' ? '28d' : '7d';
  const [o, m, sources] = await run((ctx) => Promise.all([svc.overview(ctx), svc.movers(ctx, { window, limit: 8 }), svc.sourceStatus(ctx)]));
  const canManage = session.permissions.has('streams:manage');

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
        description="Plays per day from Spotify play counts (SpotScraper), YouTube Music (each track's art track) and YouTube video views, plus exact statement counts. Sources are never blended."
        actions={canManage && <ActionButton endpoint="/streams/poll" body={{}} label="Refresh now" icon="refresh" success="Polling queued" />}
      />
      <Summary>
        {o.tracking.tracking} tracks tracked · {o.tracking.pendingMatch} waiting for a match · {o.tracking.paused} paused{o.throughDay ? ` · through ${o.throughDay}` : ''} · Spotify plays {sources.spotify ? 'on' : 'off'} · YouTube Music and YouTube {sources.youtubeViaApify ? 'daily via Apify' : sources.youtube ? 'on' : 'off'}{sources.licensed ? ' · licensed DSP counts configured' : ''}
      </Summary>
      {!sources.spotify && (
        <Banner icon="key" warn>
          Spotify play counts need a SpotScraper key. {session.permissions.has('settings:credentials') ? <Link href="/settings/integrations">Add it under Settings → Integrations</Link> : 'Ask an admin to add one under Settings → Integrations'}. Tracks are matched by ISRC; each poll is one request per track.
        </Banner>
      )}
      {!sources.youtube && (
        <Banner icon="key" warn>
          YouTube Music plays and YouTube views need a YouTube Data API key (free from Google Cloud) or an Apify token. {session.permissions.has('settings:credentials') ? <Link href="/settings/integrations">Add one under Settings → Integrations</Link> : 'Ask an admin to add one under Settings → Integrations'}. The key reads views as often as Streams polls at no cost; Apify reads them once a day for about $0.0005 per video.
        </Banner>
      )}
      <div className="lc-grid-stats">
        <StatCard label="PLAYS · 28D" icon="visibility" value={o.throughDay ? fmt.compact(o.plays28d) : '—'} delta={o.changePct != null ? fmt.pct(o.changePct, { signed: true, decimals: 1 }) : undefined} deltaDown={(o.changePct ?? 0) < 0} note="vs the 28 days before · polled sources" />
        {(['spotify', 'youtube_music', 'youtube'] as const).map((platform) => {
          const p = o.byPlatform.find((x) => x.platform === platform);
          // YouTube video views only when some are tracked; Spotify and YouTube Music always, so a gap is visible.
          if (!p && platform === 'youtube') return null;
          const ready = platform === 'spotify' ? sources.spotify : sources.youtube;
          return (
            <StatCard
              key={platform}
              label={`${platformLabel(platform).toUpperCase()} · 28D`}
              icon={platform === 'spotify' ? 'graphic_eq' : platform === 'youtube_music' ? 'library_music' : 'smart_display'}
              value={p ? fmt.compact(p.current) : '—'}
              delta={p && p.previous > 0 ? fmt.pct(((p.current - p.previous) / p.previous) * 100, { signed: true }) : undefined}
              deltaDown={p ? p.current < p.previous : false}
              note={p ? (platform === 'spotify' ? 'Spotify play counts' : platform === 'youtube_music' ? 'plays of the art tracks' : 'official video views') : !ready ? (platform === 'spotify' ? 'needs a SpotScraper key' : 'needs a YouTube key or an Apify token') : platform === 'youtube_music' ? 'art tracks being matched' : 'first readings pending'}
            />
          );
        })}
        <StatCard label="LATEST STATEMENT" icon="receipt_long" value={o.statement ? fmt.compact(o.statement.units) : '—'} note={o.statement ? `units, period ending ${fmt.date(o.statement.periodEnd)}` : 'import one under Finance'} href="/finance/statements" />
        <StatCard label="OPEN ALERTS" icon="notifications_active" value={String(o.openAlerts)} note="spikes, drops, milestones" href="/streams/alerts" />
      </div>
      <Card title="Plays per day" sub="Polled sources, one line per platform. Hover or tap the chart to read a date.">
        <TimeSeriesChart title="Plays per day" series={platformLines(o.daily)} ranges={PLAY_RANGES} defaultRange={90} height={260} />
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
