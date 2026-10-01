-- Append-only stream snapshots, partitioned by month on captured_at.
-- Idempotent: runs after every migration.
CREATE TABLE IF NOT EXISTS stream_snapshots (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT nullif(current_setting('app.org_id', true), '')::uuid,
  track_id uuid NOT NULL,
  platform text NOT NULL,
  source text NOT NULL,
  external_id text,
  captured_at timestamptz NOT NULL,
  count bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, captured_at)
) PARTITION BY RANGE (captured_at);

CREATE INDEX IF NOT EXISTS stream_snapshots_track_idx ON stream_snapshots (org_id, track_id, platform, source, captured_at);

CREATE TABLE IF NOT EXISTS stream_snapshots_default PARTITION OF stream_snapshots DEFAULT;

CREATE OR REPLACE FUNCTION ensure_stream_snapshot_partitions(months_ahead int DEFAULT 3) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  first_month date := date_trunc('month', now())::date;
  m date;
  part text;
BEGIN
  FOR i IN 0..months_ahead LOOP
    m := (first_month + make_interval(months => i))::date;
    part := 'stream_snapshots_' || to_char(m, 'YYYY_MM');
    IF to_regclass(part) IS NULL THEN
      EXECUTE format('CREATE TABLE %I PARTITION OF stream_snapshots FOR VALUES FROM (%L) TO (%L)', part, m, (m + interval '1 month')::date);
    END IF;
  END LOOP;
END $$;

SELECT ensure_stream_snapshot_partitions(3);
