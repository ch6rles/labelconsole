-- YouTube Music as its own platform: readings of a track's confirmed Topic art
-- track (what YouTube Music plays) move from "youtube" to "youtube_music", and
-- the daily figures of the tracks affected are rebuilt from their readings for
-- both platforms, the same way the tracker rolls up a day (a view count's
-- growth per video, summed). Idempotent: once moved, nothing is left to move.
DO $$
BEGIN
  IF to_regclass('public.stream_snapshots') IS NULL OR to_regclass('public.stream_daily') IS NULL OR to_regclass('public.platform_identities') IS NULL THEN
    RETURN;
  END IF;

  CREATE TEMP TABLE yt_music_split (org_id uuid, track_id uuid) ON COMMIT DROP;

  WITH moved AS (
    UPDATE stream_snapshots s SET platform = 'youtube_music'
    FROM platform_identities i
    WHERE s.platform = 'youtube' AND s.source IN ('youtube-data-api', 'youtube-scraper')
      AND i.org_id = s.org_id AND i.entity_type = 'track' AND i.entity_id = s.track_id
      AND i.platform = 'youtube' AND i.variant = 'topic' AND i.status = 'confirmed'
      AND i.external_id = s.external_id
    RETURNING s.org_id, s.track_id
  )
  INSERT INTO yt_music_split SELECT DISTINCT org_id, track_id FROM moved;

  IF NOT EXISTS (SELECT 1 FROM yt_music_split) THEN
    RETURN;
  END IF;

  DELETE FROM stream_daily d USING yt_music_split t
  WHERE d.org_id = t.org_id AND d.track_id = t.track_id
    AND d.platform IN ('youtube', 'youtube_music') AND d.source IN ('youtube-data-api', 'youtube-scraper');

  INSERT INTO stream_daily (org_id, track_id, platform, source, day, total, delta, raw_delta)
  SELECT d.org_id, d.track_id, d.platform, d.source, d.day, r.total, r.delta, r.delta
  FROM (
    SELECT DISTINCT s.org_id, s.track_id, s.platform, s.source, (s.captured_at AT TIME ZONE 'UTC')::date AS day
    FROM stream_snapshots s JOIN yt_music_split t ON t.org_id = s.org_id AND t.track_id = s.track_id
    WHERE s.platform IN ('youtube', 'youtube_music') AND s.source IN ('youtube-data-api', 'youtube-scraper')
  ) d
  CROSS JOIN LATERAL (
    WITH cur AS (
      SELECT DISTINCT ON (coalesce(external_id, '')) coalesce(external_id, '') AS ext, count
      FROM stream_snapshots
      WHERE org_id = d.org_id AND track_id = d.track_id AND platform = d.platform AND source = d.source
        AND captured_at >= (d.day::timestamp AT TIME ZONE 'UTC') - interval '30 days'
        AND captured_at < (d.day::timestamp AT TIME ZONE 'UTC') + interval '1 day'
      ORDER BY coalesce(external_id, ''), captured_at DESC
    ), prev AS (
      SELECT DISTINCT ON (coalesce(external_id, '')) coalesce(external_id, '') AS ext, count
      FROM stream_snapshots
      WHERE org_id = d.org_id AND track_id = d.track_id AND platform = d.platform AND source = d.source
        AND captured_at >= (d.day::timestamp AT TIME ZONE 'UTC') - interval '30 days'
        AND captured_at < (d.day::timestamp AT TIME ZONE 'UTC')
      ORDER BY coalesce(external_id, ''), captured_at DESC
    )
    SELECT coalesce(sum(cur.count), 0)::bigint AS total,
           coalesce(sum(CASE WHEN prev.count IS NULL THEN 0 ELSE greatest(cur.count - prev.count, 0) END), 0)::bigint AS delta
    FROM cur LEFT JOIN prev USING (ext)
  ) r
  ON CONFLICT (org_id, track_id, platform, source, day) DO UPDATE SET total = excluded.total, delta = excluded.delta, raw_delta = excluded.raw_delta, estimated = false, pending = false;
END $$;
