CREATE TABLE "discord_benchmarks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text DEFAULT nullif(current_setting('app.actor', true), ''),
	"requested_by" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"sample" integer NOT NULL,
	"include_billed" boolean DEFAULT false NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"results" jsonb,
	"error" text,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "discord_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"ref" text NOT NULL,
	"field" text NOT NULL,
	"source" text NOT NULL,
	"value" text NOT NULL,
	"source_url" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "discord_lookups" ADD COLUMN "sources" jsonb;--> statement-breakpoint
ALTER TABLE "discord_state" ADD COLUMN "daily_readings" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "discord_benchmarks_org_idx" ON "discord_benchmarks" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "discord_evidence_claim_idx" ON "discord_evidence" USING btree ("org_id","ref","field","source","value");--> statement-breakpoint
CREATE INDEX "discord_evidence_seen_idx" ON "discord_evidence" USING btree ("org_id","last_seen_at");