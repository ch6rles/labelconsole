CREATE TABLE "discord_link_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text DEFAULT nullif(current_setting('app.actor', true), ''),
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "discord_link_codes_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "discord_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text DEFAULT nullif(current_setting('app.actor', true), ''),
	"user_id" uuid NOT NULL,
	"discord_user_id" text NOT NULL,
	"discord_username" text NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "discord_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text DEFAULT nullif(current_setting('app.actor', true), ''),
	"application_id" text,
	"commands_registered_at" timestamp with time zone,
	"commands_error" text
);
--> statement-breakpoint
CREATE INDEX "discord_link_codes_user_idx" ON "discord_link_codes" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "discord_links_user_idx" ON "discord_links" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "discord_links_discord_idx" ON "discord_links" USING btree ("org_id","discord_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "discord_state_org_idx" ON "discord_state" USING btree ("org_id");