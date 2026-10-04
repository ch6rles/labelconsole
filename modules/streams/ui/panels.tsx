import Link from 'next/link';
import type { PanelProps } from '@labelconsole/core/web';
import { Card, DataTable, EmptyState, KV, ShareBars, StatCard, fmt } from '@labelconsole/ui';
import { ActionButton, FormModal } from '@labelconsole/ui/client';
import { TimeSeriesChart } from '@labelconsole/ui/timeseries';
import * as svc from '../service';
import { historyLines, PLAY_RANGES, platformColor } from './shared';

const from90 = () => new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10);

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
        <TimeSeriesChart title="Plays" series={historyLines(polled)} ranges={PLAY_RANGES} defaultRange={90} height={220} />
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
          <TimeSeriesChart title="Plays across the artist's tracks" series={historyLines(polled)} ranges={PLAY_RANGES} defaultRange={90} height={220} />
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
export async function artistAudiencePanel({ entityId, run, session }: PanelProps) {
  const [a, link] = await run((ctx) => Promise.all([svc.artistAudience(ctx, entityId), svc.spotifyLinkState(ctx, entityId)]));
  if (!a) {
    const canWrite = session.permissions.has('people:write');
    return (
      <EmptyState
        icon="graphic_eq"
        title={link.linked ? 'Reading their Spotify audience' : 'Not linked to Spotify yet'}
        action={
          !link.linked && canWrite && link.spotScraper ? (
            <span className="lc-row" style={{ gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
              {link.spotifyTracks > 0 && <ActionButton endpoint="/streams/link-artists" body={{ artistIds: [entityId] }} label="Find on Spotify" icon="travel_explore" variant="primary" success="Looking for their Spotify profile" />}
              <FormModal
                title="Link to Spotify"
                description="Paste the link to their Spotify artist page. Monthly listeners are read straight away, then daily."
                trigger={{ label: 'Paste profile link', icon: 'link' }}
                endpoint={`/people/artists/${entityId}`}
                method="PATCH"
                fields={[{ name: 'spotifyArtistId', label: 'Spotify profile link', required: true, full: true, placeholder: 'https://open.spotify.com/artist/…' }]}
                columns={1}
                success="Spotify profile linked"
              />
            </span>
          ) : undefined
        }
      >
        {!link.spotScraper
          ? 'Monthly listeners need a SpotScraper key under Settings → Integrations.'
          : link.linked
            ? 'Monthly listeners, followers and top cities arrive within a few minutes, then refresh daily.'
            : link.spotifyTracks > 0
              ? 'Find on Spotify reads one of their Spotify tracks and links the profile whose name matches. Profiles are also linked automatically as their tracks are polled.'
              : 'None of their tracks is matched on Spotify yet, so paste the link to their Spotify artist page.'}
      </EmptyState>
    );
  }
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
            <TimeSeriesChart
              title="Monthly listeners"
              series={[{ id: 'listeners', name: 'Monthly listeners', color: platformColor('spotify'), points: a.series.map((p) => ({ day: p.day, total: p.monthlyListeners, delta: null })) }]}
              metrics={['total']}
              totalLabel="Monthly listeners"
              summary={false}
              height={200}
            />
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
