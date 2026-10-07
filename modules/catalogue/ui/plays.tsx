import { fmt } from '@labelconsole/ui';

/** What Streams adds to a track in catalogue lists (see the streams module's enrich hook). */
export type PlaysExtra = {
  spotifyPlays?: number | null;
  spotifyPlays7d?: number | null;
  /** Plays of the track's YouTube Music art track (its Topic upload). */
  youtubeMusicPlays?: number | null;
  youtubeMusicPlays7d?: number | null;
  /** Views of its other YouTube videos (the official video). */
  youtubePlays?: number | null;
  youtubePlays7d?: number | null;
};

/** An all-time count, with the last 7 days' gain under it. */
function PlaysCell({ total, week }: { total?: number | null; week?: number | null }) {
  if (total == null) return <span className="lc-cell-num lc-muted">—</span>;
  return (
    <span className="lc-cell-stack" style={{ alignItems: 'flex-end' }}>
      <span className="lc-cell-num">{fmt.compact(total)}</span>
      {week != null && <span className="lc-cell-sub">{fmt.compact(week, { signed: true })} in 7d</span>}
    </span>
  );
}

export const SpotifyPlays = ({ e }: { e?: PlaysExtra }) => <PlaysCell total={e?.spotifyPlays} week={e?.spotifyPlays7d} />;
export const YouTubeMusicPlays = ({ e }: { e?: PlaysExtra }) => <PlaysCell total={e?.youtubeMusicPlays} week={e?.youtubeMusicPlays7d} />;
