CREATE TABLE "artist_spotify_stats" (
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"artist_id" uuid NOT NULL,
	"day" date NOT NULL,
	"spotify_artist_id" text NOT NULL,
	"monthly_listeners" bigint,
	"followers" bigint,
	"world_rank" integer,
	"top_cities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"discovered_on" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artist_spotify_stats_org_id_artist_id_day_pk" PRIMARY KEY("org_id","artist_id","day")
);
--> statement-breakpoint
ALTER TABLE "stream_tracks" ADD COLUMN "spotify_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "artist_spotify_stats" ADD CONSTRAINT "artist_spotify_stats_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE cascade ON UPDATE no action;