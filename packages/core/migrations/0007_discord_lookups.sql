CREATE TABLE "discord_corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text DEFAULT nullif(current_setting('app.actor', true), ''),
	"ref" text NOT NULL,
	"subject" text NOT NULL,
	"field" text NOT NULL,
	"current_value" text,
	"proposed_value" text NOT NULL,
	"note" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"submitted_by" uuid NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_note" text
);
--> statement-breakpoint
CREATE TABLE "discord_lookups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"user_id" uuid,
	"command" text NOT NULL,
	"input_kind" text NOT NULL,
	"outcome" text NOT NULL,
	"ref" text,
	"cached" boolean DEFAULT false NOT NULL,
	"duration_ms" integer NOT NULL,
	"coverage" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discord_play_readings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"isrc" text NOT NULL,
	"platform" text NOT NULL,
	"source" text NOT NULL,
	"count" bigint NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "discord_state" ADD COLUMN "allow_sharing" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "discord_state" ADD COLUMN "share_distributor" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "discord_state" ADD COLUMN "share_streams" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX "discord_corrections_ref_idx" ON "discord_corrections" USING btree ("org_id","ref","status");--> statement-breakpoint
CREATE INDEX "discord_corrections_status_idx" ON "discord_corrections" USING btree ("org_id","status","created_at");--> statement-breakpoint
CREATE INDEX "discord_lookups_org_time_idx" ON "discord_lookups" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "discord_play_readings_isrc_idx" ON "discord_play_readings" USING btree ("org_id","isrc","captured_at");