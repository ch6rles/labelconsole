import { fmt } from '@labelconsole/ui';

/** What Streams adds to a track in catalogue lists (see the streams module's enrich hook). */
export type PlaysExtra = { spotifyPlays?: number | null; spotifyPlays7d?: number | null };

/** All-time Spotify plays, with the last 7 days' gain under it. */
export function SpotifyPlays({ e }: { e?: PlaysExtra }) {
  if (e?.spotifyPlays == null) return <span className="lc-cell-num lc-muted">—</span>;
  return (
    <span className="lc-cell-stack" style={{ alignItems: 'flex-end' }}>
      <span className="lc-cell-num">{fmt.compact(e.spotifyPlays)}</span>
      {e.spotifyPlays7d != null && <span className="lc-cell-sub">{fmt.compact(e.spotifyPlays7d, { signed: true })} in 7d</span>}
    </span>
  );
}
