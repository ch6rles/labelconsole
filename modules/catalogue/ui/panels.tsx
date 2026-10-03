import { spotifyIdFrom, spotScraperConfigured } from '@labelconsole/core/spotscraper';
import type { PanelProps } from '@labelconsole/core/web';
import { DataTable, DateTag, fmt } from '@labelconsole/ui';
import { FormModal, PollUntilDone } from '@labelconsole/ui/client';
import { getArtist } from '@labelconsole/people/service';
import * as svc from '../service';
import { STATUS_LABEL, TYPE_LABEL } from './fields';

export async function artistReleasesPanel({ entityId, run, session }: PanelProps) {
  const [rows, sync, artist, configured] = await run((ctx) => Promise.all([svc.listReleases(ctx, { artistId: entityId }), svc.latestSpotifySync(ctx, entityId), getArtist(ctx, entityId), spotScraperConfigured(ctx)]));
  const hasSpotify = Boolean(spotifyIdFrom(artist.spotifyArtistId, 'artist'));
  const running = sync && (sync.status === 'queued' || sync.status === 'running');
  const canSync = session.permissions.has('catalogue:write') && hasSpotify && configured && !running;
  const imported = sync?.items.filter((i) => i.status === 'imported').length ?? 0;
  const review = sync?.items.filter((i) => i.status === 'review').length ?? 0;
  const skipped = sync?.items.filter((i) => i.status === 'skipped').length ?? 0;
  return (
    <div className="lc-stack" style={{ gap: 12 }}>
      <div className="lc-row" style={{ justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <span className="lc-cell-sub" style={{ fontSize: 13 }}>
          {running
            ? `Syncing from Spotify: ${sync.processed} of ${sync.total || '…'} releases read`
            : sync?.status === 'failed'
              ? `The last Spotify sync failed: ${sync.meta.error ?? 'unknown error'}`
              : sync
                ? `Last synced from Spotify ${fmt.relative(sync.updatedAt)}: ${imported} imported${review ? `, ${review} waiting for review on the Import page` : ''}${skipped ? `, ${skipped} on other labels left out` : ''}${sync.meta.alreadyInCatalogue ? `, ${sync.meta.alreadyInCatalogue} already in the catalogue` : ''}.`
                : !hasSpotify
                  ? 'Add the artist\'s Spotify artist link to their profile to sync their releases from Spotify.'
                  : !configured
                    ? 'Syncing releases from Spotify needs a SpotScraper key (Settings → Integrations).'
                    : 'Bring this artist\'s releases on Spotify into the catalogue, with their tracks, codes and live play counts.'}
        </span>
        {canSync && (
          <FormModal
            title={`Sync ${artist.name} from Spotify`}
            description="Reads their albums, singles and EPs on Spotify and adds the ones not yet in the catalogue: release, tracks, UPC, ISRCs, label and release date. Play counts start updating in Streams once the tracks are in. Audio isn't downloaded from Spotify: upload each master on its track page."
            trigger={{ label: sync ? 'Sync again' : 'Sync from Spotify', icon: 'sync', size: 'sm' }}
            endpoint={`/catalogue/artists/${entityId}/spotify-sync`}
            fields={[{ name: 'onlyLabel', label: `Only releases on ${session.org.name} (matched on the label and ℗ line)`, type: 'checkbox', full: true }]}
            columns={1}
            submitLabel="Start sync"
            success="Sync started: releases appear here as they are imported"
          />
        )}
      </div>
      {running && <PollUntilDone endpoint={`/metadata/imports/${sync.id}`} done={['done', 'failed']} intervalMs={3000} />}
      <DataTable
      rows={rows}
      rowKey={(r) => r.id}
      rowHref={(r) => `/catalog/releases/${r.id}`}
      minWidth={720}
      empty="No releases linked to this artist yet."
      columns={[
        { key: 't', header: 'Release', width: 'minmax(200px,1fr)', render: (r) => <span className="lc-cell-stack"><span className="lc-cell-strong">{r.title}</span><span className="lc-cell-sub lc-mono">{TYPE_LABEL[r.type]} · {r.upc ? svc.displayUpc(r.upc) : 'No UPC'}</span></span> },
        { key: 's', header: 'Status', width: '120px', render: (r) => <span className="lc-chip">{STATUS_LABEL[r.status]}</span> },
        { key: 'd', header: 'Date', width: '170px', render: (r) => <span className="lc-row" style={{ gap: 8 }}><span className="lc-mono" style={{ fontSize: 12 }}>{r.releaseDate ? fmt.date(r.releaseDate) : '—'}</span><DateTag kind={!r.releaseDate ? 'tbd' : r.upcoming ? 'upcoming' : 'released'}>{!r.releaseDate ? 'TBD' : r.upcoming ? 'Upcoming' : 'Released'}</DateTag></span> },
        { key: 'r', header: 'Readiness', width: '160px', render: (r) => <span className={r.readiness.tone === 'blocked' ? 'lc-chip lc-chip--red' : r.readiness.tone === 'ready' ? 'lc-chip lc-chip--blue' : 'lc-chip'}>{r.readiness.label}</span> },
      ]}
      />
    </div>
  );
}
