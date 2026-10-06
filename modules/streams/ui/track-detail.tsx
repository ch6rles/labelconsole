import Link from 'next/link';
import type { PageProps } from '@labelconsole/core/web';
import { BarChart, Card, DataTable, EmptyState, Icon, InlineNote, KV, Page, PageHeader, ShareBars, StatCard, SubTabs, fmt } from '@labelconsole/ui';
import { ActionButton, FormModal } from '@labelconsole/ui/client';
import { TimeSeriesChart } from '@labelconsole/ui/timeseries';
import * as svc from '../service';
import { platformLabel } from '../sources/types';
import { historyLines, seriesName, STATUS_CHIP } from './shared';

export default async function StreamTrackPage({ run, params, session, searchParams, path }: PageProps) {
  const granularity = searchParams.g === 'week' ? 'week' : searchParams.g === 'month' ? 'month' : 'day';
  const range = searchParams.range === '365' ? 365 : searchParams.range === '28' ? 28 : 90;
  const from = new Date(Date.now() - range * 86400_000).toISOString().slice(0, 10);
  const [d, h, statements] = await run((ctx) =>
    Promise.all([svc.getTracked(ctx, params.id), svc.trackHistory(ctx, params.id, { from, granularity }), svc.trackHistory(ctx, params.id, { from: new Date(Date.now() - 730 * 86400_000).toISOString().slice(0, 10), granularity: 'month' })]),
  );
  const canManage = session.permissions.has('streams:manage');
  const polled = h.series.filter((s) => svc.POLLED_SOURCES.includes(s.source as never));
  const stmt = statements.series.filter((s) => s.source === 'statement-import');
  const st = d.tracked;
  const sum = (days: number) => polled.reduce((a, s) => a + s.points.filter((p) => p.day > new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10)).reduce((x, p) => x + p.delta, 0), 0);
  const yt = polled.find((s) => s.platform === 'youtube');
  const sp = polled.find((s) => s.platform === 'spotify' && s.source === 'spotscraper');
  const spPrimary = d.spotify.find((i) => i.variant === 'primary' && i.status === 'confirmed');
  // One card per source the track actually uses, so the row stays at four.
  const showSpotify = d.spotScraper || d.spotify.length > 0;
  const showYouTube = d.youtube.length > 0 || !showSpotify;
  // The first reading of a series has a total but no plays figure yet.
  const isFirst = (s: { since: string | null }, day: string) => granularity === 'day' && s.since === day;
  const latestStmt = stmt.flatMap((s) => s.points.map((p) => ({ ...p, platform: s.platform }))).sort((a, b) => b.day.localeCompare(a.day));
  const lastPeriod = latestStmt[0]?.day;
  const months = [...new Set(stmt.flatMap((s) => s.points.map((p) => p.day)))].sort().slice(-12);
  const latestSplit = stmt.map((s) => ({ platform: s.platform, units: s.points.find((p) => p.day === lastPeriod)?.total ?? 0 })).filter((r) => r.units > 0).sort((a, b) => b.units - a.units);
  const latestTotal = latestSplit.reduce((a, r) => a + r.units, 0);
  const q = (patch: Record<string, string>) => `${path}?${new URLSearchParams({ ...(searchParams.g ? { g: searchParams.g } : {}), ...(searchParams.range ? { range: searchParams.range } : {}), ...patch })}`;

  return (
    <Page>
      <PageHeader
        title={d.track.title}
        description={`${d.artists.join(', ') || 'No artist'}${d.track.isrc ? ` · ISRC ${d.track.isrc}` : ''}`}
        actions={
          <>
            <Link className="lc-btn" href={`/catalog/tracks/${d.track.id}`}><Icon name="album" />Catalogue</Link>
            {canManage && st?.status === 'tracking' && <ActionButton endpoint="/streams/poll" body={{ trackId: d.track.id }} label="Refresh now" icon="refresh" success="Polling queued" />}
            {canManage && st && <ActionButton endpoint={`/streams/registry/${d.track.id}`} method="PATCH" body={{ status: st.status === 'paused' ? 'tracking' : 'paused' }} label={st.status === 'paused' ? 'Resume tracking' : 'Pause tracking'} icon={st.status === 'paused' ? 'play_arrow' : 'pause'} variant="ghost" />}
            {canManage && !st && <ActionButton endpoint={`/streams/registry/${d.track.id}`} label="Start tracking" icon="add" variant="primary" />}
          </>
        }
      />
      {st?.lastError && <InlineNote icon="error">{st.lastError}</InlineNote>}
      <div className="lc-grid-stats">
        <StatCard label="STATUS" icon="radar" value={st ? (STATUS_CHIP[st.status]?.label ?? st.status) : 'Not tracked'} note={st?.status === 'tracking' ? `${st.tier === 'active' ? 'every 6 h' : 'daily'} · last ${st.lastPolledAt ? fmt.relative(st.lastPolledAt) : 'pending'}` : st?.status === 'pending_match' ? 'waiting for a Spotify or YouTube match' : '—'} />
        {showSpotify && <StatCard label="SPOTIFY PLAYS" icon="graphic_eq" value={sp?.points.length ? fmt.compact(sp.points.at(-1)!.total) : '—'} note={spPrimary ? 'all-time, from SpotScraper' : d.spotScraper ? 'no Spotify ID yet' : 'needs a SpotScraper key'} />}
        {showYouTube && <StatCard label="YOUTUBE VIEWS" icon="smart_display" value={yt?.points.length ? fmt.compact(yt.points.at(-1)!.total) : '—'} note="total across matched videos" />}
        <StatCard label="PLAYS · 7D" icon="trending_up" value={polled.length ? fmt.compact(sum(7)) : '—'} note={`${fmt.compact(sum(28))} over 28 days`} />
        <StatCard label="LAST STATEMENT" icon="receipt_long" value={lastPeriod ? fmt.compact(latestStmt.filter((p) => p.day === lastPeriod).reduce((a, p) => a + p.total, 0)) : '—'} note={lastPeriod ? `units in ${new Date(`${lastPeriod}T00:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })}` : 'no statement lines matched'} />
      </div>

      <Card
        title="Plays"
        sub="Plays are the change in each source's running total; each platform and source is its own line. Hover or tap the chart to read a date."
        actions={
          <span className="lc-row" style={{ gap: 12, flexWrap: 'wrap' }}>
            <SubTabs items={[{ label: '28 d', href: q({ range: '28' }), active: range === 28 }, { label: '90 d', href: q({ range: '90' }), active: range === 90 }, { label: '1 y', href: q({ range: '365' }), active: range === 365 }]} />
            <SubTabs items={[{ label: 'Daily', href: q({ g: 'day' }), active: granularity === 'day' }, { label: 'Weekly', href: q({ g: 'week' }), active: granularity === 'week' }, { label: 'Monthly', href: q({ g: 'month' }), active: granularity === 'month' }]} />
          </span>
        }
      >
        {polled.length ? (
          <TimeSeriesChart title="Plays" series={historyLines(polled, granularity)} unit={granularity} rangeLabel={range === 365 ? '1 y' : `${range} d`} height={260} />
        ) : (
          <EmptyState icon="monitoring" title="No readings yet">{st?.status === 'tracking' ? 'The first poll records the running total; plays per day start from the second reading.' : 'Readings start once the track has a Spotify ID (found by ISRC with a SpotScraper key) or a confirmed YouTube video.'}</EmptyState>
        )}
      </Card>

      {stmt.length > 0 && (
        <Card title="Units per statement month" sub="Exact counts from distributor statements, reported months in arrears. All platforms combined; the latest month is split below.">
          <BarChart data={months.map((m) => ({ label: fmt.monthLabel(m), value: stmt.reduce((a, s) => a + (s.points.find((p) => p.day === m)?.total ?? 0), 0) }))} height={170} />
          <div className="lc-stack" style={{ gap: 10, marginTop: 18 }}>
            <span className="lc-field-label">{lastPeriod ? new Date(`${lastPeriod}T00:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }) : ''} by platform</span>
            <ShareBars rows={latestSplit.map((r) => ({ name: platformLabel(r.platform), value: fmt.compact(r.units), pct: latestTotal ? (r.units / latestTotal) * 100 : 0 }))} />
          </div>
        </Card>
      )}

      <div className="lc-grid-2">
        <Card
          title="Spotify"
          sub="Play counts are read from one Spotify ID per track, found by ISRC. Re-releases share the count, so they are never added together."
          actions={
            canManage && (
              <FormModal
                title="Set the Spotify track"
                description="Paste this track's Spotify link. Play counts are read from it from now on; the series continues without a jump."
                trigger={{ label: spPrimary ? 'Change' : 'Set link', icon: spPrimary ? 'edit' : 'add', size: 'sm' }}
                endpoint={`/streams/registry/${d.track.id}/spotify`}
                fields={[{ name: 'spotify', label: 'Spotify link', required: true, full: true, placeholder: 'https://open.spotify.com/track/…' }]}
                columns={1}
                success="Spotify track set"
              />
            )
          }
        >
          {!d.spotScraper && <span className="lc-muted" style={{ fontSize: 13 }}>Spotify play counts need a SpotScraper key under Settings → Integrations.</span>}
          {d.spotScraper && d.spotify.length === 0 && <span className="lc-muted" style={{ fontSize: 13 }}>{d.track.isrc ? 'Not matched yet: the next poll searches Spotify by ISRC.' : 'No ISRC on this track: add one in the catalogue, or paste the Spotify link.'}</span>}
          {d.spotify.map((i) => (
            <KV
              key={i.id}
              k={
                <span className="lc-cell-stack">
                  <a href={i.url ?? `https://open.spotify.com/track/${i.externalId}`} target="_blank" rel="noreferrer" className="lc-mono" style={{ fontSize: 13 }}>{i.externalId}</a>
                  <span className="lc-cell-sub">{i.source === 'spotscraper' ? 'matched by ISRC' : i.source === 'manual' ? 'set by staff' : `from ${i.source}`}</span>
                </span>
              }
              v={<span className={i.variant === 'primary' && i.status === 'confirmed' ? 'lc-chip lc-chip--blue' : 'lc-chip lc-chip--muted'}>{i.status !== 'confirmed' ? fmt.titleCase(i.status.replace('_', ' ')) : i.variant === 'primary' ? 'Polled' : 'Other release'}</span>}
            />
          ))}
        </Card>
        <Card
          title="YouTube videos"
          sub="Views are summed across confirmed videos: the Topic art track (YouTube Music) and the official video."
          actions={
            canManage && (
              <span className="lc-row" style={{ gap: 6 }}>
                <ActionButton endpoint={`/streams/registry/${d.track.id}/resolve`} label="Search again" icon="travel_explore" size="sm" success="Search queued" />
                <FormModal title="Add a YouTube video" description="Paste the link of this track's Topic upload or official video. It is confirmed straight away." trigger={{ label: 'Add video', icon: 'add', size: 'sm' }} endpoint={`/streams/registry/${d.track.id}/youtube`} fields={[{ name: 'video', label: 'YouTube link', required: true, full: true, placeholder: 'https://music.youtube.com/watch?v=…' }]} columns={1} success="Video added" />
              </span>
            )
          }
        >
          {d.youtube.length === 0 && <span className="lc-muted" style={{ fontSize: 13 }}>No videos matched yet.</span>}
          {d.youtube.map((v) => (
            <KV
              key={v.id}
              k={
                <span className="lc-cell-stack">
                  <a href={v.url ?? `https://www.youtube.com/watch?v=${v.externalId}`} target="_blank" rel="noreferrer" className="lc-mono" style={{ fontSize: 13 }}>{v.externalId}</a>
                  <span className="lc-cell-sub">{v.variant === 'topic' ? 'Topic art track' : 'Official video'} · {v.source === 'youtube-search' ? `matched ${Math.round(Number(v.confidence) * 100)}%` : v.source}</span>
                </span>
              }
              v={<span className={v.status === 'confirmed' ? 'lc-chip lc-chip--blue' : v.status === 'rejected' ? 'lc-chip lc-chip--muted' : 'lc-chip lc-chip--ink'}>{v.status === 'pending_review' ? 'To review' : fmt.titleCase(v.status)}</span>}
            />
          ))}
        </Card>
        <Card title="Alerts">
          {d.alerts.length === 0 && <span className="lc-muted" style={{ fontSize: 13 }}>No alerts for this track.</span>}
          {d.alerts.map((a) => <KV key={a.id} k={<span className="lc-cell-stack"><span>{a.message}</span><span className="lc-cell-sub">{fmt.date(a.day)}{a.acknowledgedAt ? ' · seen' : ''}</span></span>} v={<span className={a.kind === 'drop' ? 'lc-chip lc-chip--red' : a.kind === 'spike' ? 'lc-chip lc-chip--blue' : 'lc-chip'}>{fmt.titleCase(a.kind)}</span>} />)}
        </Card>
      </div>
      {polled.length > 0 && (
        <DataTable
          title="Latest readings"
          rows={polled.flatMap((s) => s.points.map((p) => ({ ...p, platform: s.platform, source: s.source, first: isFirst(s, p.day) }))).sort((a, b) => b.day.localeCompare(a.day)).slice(0, 14)}
          rowKey={(r) => `${r.platform}-${r.source}-${r.day}`}
          minWidth={620}
          columns={[
            { key: 'd', header: granularity === 'day' ? 'Day' : granularity === 'week' ? 'Week of' : 'Month', width: '140px', render: (r) => <span className="lc-mono" style={{ fontSize: 12 }}>{fmt.date(r.day)}</span> },
            { key: 's', header: 'Series', width: 'minmax(180px,1fr)', render: (r) => seriesName(r.platform, r.source) },
            { key: 'p', header: 'Plays', width: '110px', align: 'right', render: (r) =>
                r.first ? (
                  <span className="lc-cell-sub" title="Tracking started: plays count from the next reading">first reading</span>
                ) : r.pending ? (
                  <span className="lc-cell-sub" title="The count hasn't refreshed since the last reading. The plays are added when it does.">not refreshed yet</span>
                ) : r.estimated ? (
                  <span className="lc-cell-num" title="Spread over days the count didn't refresh; the total over those days is exact">≈ {fmt.int(r.delta)}</span>
                ) : (
                  <span className="lc-cell-num">{fmt.int(r.delta)}</span>
                ),
            },
            { key: 't', header: 'Running total', width: '140px', align: 'right', render: (r) => <span className="lc-cell-num lc-muted">{fmt.int(r.total)}</span> },
          ]}
        />
      )}
      <Link href="/streams/tracks" className="lc-btn lc-btn--link"><Icon name="arrow_back" />All tracked tracks</Link>
    </Page>
  );
}
