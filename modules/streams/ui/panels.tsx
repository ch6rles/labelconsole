import Link from 'next/link';
import type { PanelProps } from '@labelconsole/core/web';
import { DataTable, EmptyState, KV, LineChart, fmt } from '@labelconsole/ui';
import * as svc from '../service';
import { platformColor, seriesName } from './shared';

const from90 = () => new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10);

/** On a catalogue track page: 90 days of plays and where the numbers come from. */
export async function trackStreamsPanel({ entityId, run }: PanelProps) {
  const [h, d] = await run((ctx) => Promise.all([svc.trackHistory(ctx, entityId, { from: from90() }), svc.getTracked(ctx, entityId)]));
  const polled = h.series.filter((s) => svc.POLLED_SOURCES.includes(s.source as never));
  if (polled.length === 0)
    return (
      <EmptyState icon="monitoring" title={d.tracked?.status === 'tracking' ? 'Waiting for readings' : 'No stream data yet'} action={<Link className="lc-btn lc-btn--sm" href={`/streams/tracks/${entityId}`}>Open in Streams</Link>}>
        {d.tracked?.lastError ?? (d.tracked?.status === 'pending_match' ? 'The track needs a confirmed YouTube video.' : 'Readings arrive with the next scheduled poll.')}
      </EmptyState>
    );
  return (
    <div className="lc-card">
      <div className="lc-card-body lc-stack">
        <LineChart series={polled.map((s, i) => ({ name: seriesName(s.platform, s.source), color: platformColor(s.platform, i), points: s.points.map((p) => ({ x: p.day, y: p.delta })) }))} height={170} />
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
  if (polled.length === 0 && h.topTracks.length === 0) return <EmptyState icon="monitoring" title="No stream data yet">Plays appear once the artist&apos;s tracks have YouTube matches and the first two readings are in.</EmptyState>;
  return (
    <div className="lc-stack">
      <div className="lc-card">
        <div className="lc-card-body">
          <LineChart series={polled.map((s, i) => ({ name: seriesName(s.platform, s.source), color: platformColor(s.platform, i), points: s.points.map((p) => ({ x: p.day, y: p.delta })) }))} height={170} />
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
