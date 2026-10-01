import Link from 'next/link';
import type { PanelProps } from '@labelconsole/core/web';
import { Card, DataTable, EmptyState, KV, LineChart, ShareBars, StatCard, fmt } from '@labelconsole/ui';
import * as svc from '../service';
import { platformColor, seriesName } from './shared';

const from90 = () => new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10);
/** Chart points without the first reading of a series, which has a total but no plays figure yet. */
const plotted = (s: { since: string | null; points: Array<{ day: string; delta: number }> }) => s.points.filter((p) => p.day !== s.since).map((p) => ({ x: p.day, y: p.delta }));

/** On a catalogue track page: 90 days of plays and where the numbers come from. */
export async function trackStreamsPanel({ entityId, run }: PanelProps) {
  const [h, d] = await run((ctx) => Promise.all([svc.trackHistory(ctx, entityId, { from: from90() }), svc.getTracked(ctx, entityId)]));
  const polled = h.series.filter((s) => svc.POLLED_SOURCES.includes(s.source as never));
  if (polled.length === 0)
    return (
      <EmptyState icon="monitoring" title={d.tracked?.status === 'tracking' ? 'Waiting for readings' : 'No stream data yet'} action={<Link className="lc-btn lc-btn--sm" href={`/streams/tracks/${entityId}`}>Open in Streams</Link>}>
        {d.tracked?.lastError ?? (d.tracked?.status === 'pending_match' ? 'The track needs a Spotify ID or a confirmed YouTube video.' : 'Readings arrive with the next scheduled poll.')}
      </EmptyState>
    );
  return (
    <div className="lc-card">
      <div className="lc-card-body lc-stack">
        <LineChart series={polled.map((s, i) => ({ name: seriesName(s.platform, s.source), color: platformColor(s.platform, i), points: plotted(s) }))} height={170} />
        {polled.map((s) => (
          <KV key={`${s.platform}-${s.source}`} k={seriesName(s.platform, s.source)} v={<span className="lc-mono">{fmt.compact(s.points.at(-1)?.total ?? 0)} total · {fmt.compact(s.points.reduce((a, p) => a + p.delta, 0))} in 90 d</span>} />
        ))}
        <Link className="lc-btn lc-btn--link" href={`/streams/tracks/${entityId}`}>Open in Streams</Link>
      </div>
    </div>
  );
}

/** On an artist page: plays per day across their tracks, and the tracks doing the work. */
export async function artistStreamsPanel({ entityId, run }: PanelProps) {
  const h = await run((ctx) => svc.artistHistory(ctx, entityId, { from: from90() }));
  const polled = h.series.filter((s) => svc.POLLED_SOURCES.includes(s.source as never));
  if (polled.length === 0 && h.topTracks.length === 0) return <EmptyState icon="monitoring" title="No stream data yet">Plays appear once the artist&apos;s tracks are matched on Spotify or YouTube and the first two readings are in.</EmptyState>;
  return (
    <div className="lc-stack">
      <div className="lc-card">
        <div className="lc-card-body">
          <LineChart series={polled.map((s, i) => ({ name: seriesName(s.platform, s.source), color: platformColor(s.platform, i), points: plotted(s) }))} height={170} />
        </div>
      </div>
      <DataTable
        rows={h.topTracks}
        rowKey={(t) => t.trackId}
        rowHref={(t) => `/streams/tracks/${t.trackId}`}
        minWidth={480}
        columns={[
          { key: 't', header: 'Track', width: 'minmax(200px,1fr)', render: (t) => <span className="lc-cell-strong">{t.title}</span> },
          { key: 'p', header: 'Plays · 90 d', width: '130px', align: 'right', render: (t) => <span className="lc-cell-num">{fmt.compact(t.plays)}</span> },
        ]}
      />
    </div>
  );
}

/** On an artist page: their Spotify audience, read daily through SpotScraper. */
export async function artistAudiencePanel({ entityId, run }: PanelProps) {
  const a = await run((ctx) => svc.artistAudience(ctx, entityId));
  if (!a) return <EmptyState icon="graphic_eq" title="No Spotify audience data yet">Add the artist&apos;s Spotify artist ID (or profile link) to their profile. With a SpotScraper key, monthly listeners, followers and top cities are read once a day.</EmptyState>;
  const signed = (n: number | null) => (n == null ? undefined : `${fmt.compact(n, { signed: true })} in 28 d`);
  const maxCity = Math.max(1, ...a.topCities.map((c) => c.listeners));
  return (
    <div className="lc-stack">
      <div className="lc-grid-stats">
        <StatCard label="MONTHLY LISTENERS" icon="headphones" value={fmt.compact(a.monthlyListeners)} delta={signed(a.listenersChange28d)} deltaDown={(a.listenersChange28d ?? 0) < 0} note={`as of ${fmt.date(a.day)}`} />
        <StatCard label="FOLLOWERS" icon="person_add" value={fmt.compact(a.followers)} delta={signed(a.followersChange28d)} deltaDown={(a.followersChange28d ?? 0) < 0} note="on Spotify" />
        <StatCard label="WORLD RANK" icon="public" value={a.worldRank ? `#${fmt.int(a.worldRank)}` : '—'} note={a.worldRank ? 'by monthly listeners' : 'outside the ranked top'} />
      </div>
      {a.series.length > 1 && (
        <div className="lc-card">
          <div className="lc-card-body">
            <LineChart series={[{ name: 'Monthly listeners', color: platformColor('spotify'), points: a.series.map((p) => ({ x: p.day, y: p.monthlyListeners })) }]} height={160} />
          </div>
        </div>
      )}
      <div className="lc-grid-2">
        <Card title="Top cities" sub="Listeners in the last 28 days">
          {a.topCities.length ? (
            <ShareBars rows={a.topCities.map((c) => ({ name: `${c.city}${c.country ? `, ${c.country}` : ''}`, value: fmt.compact(c.listeners), pct: (c.listeners / maxCity) * 100 }))} />
          ) : (
            <span className="lc-muted" style={{ fontSize: 13 }}>Spotify shows no city breakdown for this artist.</span>
          )}
        </Card>
        <Card title="Discovered on" sub="Playlists where listeners found this artist">
          {a.discoveredOn.length === 0 && <span className="lc-muted" style={{ fontSize: 13 }}>No playlists listed yet.</span>}
          {a.discoveredOn.slice(0, 12).map((p) => (
            <KV key={p.id} k={<a href={`https://open.spotify.com/playlist/${p.id}`} target="_blank" rel="noreferrer">{p.name || p.id}</a>} v={<span className="lc-cell-sub">{p.owner && !/^[a-z0-9]{20,}$/.test(p.owner) ? p.owner : 'listener playlist'}</span>} />
          ))}
        </Card>
      </div>
    </div>
  );
}
