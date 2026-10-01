CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"actor_label" text,
	"action" text NOT NULL,
	"module" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"target_label" text,
	"before" jsonb,
	"after" jsonb,
	"agent_run_id" uuid,
	"agent_step_id" uuid,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text DEFAULT nullif(current_setting('app.actor', true), ''),
	"provider" text NOT NULL,
	"label" text NOT NULL,
	"scope" text[] DEFAULT '{}'::text[] NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"auth_tag" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "custom_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text DEFAULT nullif(current_setting('app.actor', true), ''),
	"name" text NOT NULL,
	"description" text,
	"permissions" text[] DEFAULT '{}'::text[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domain_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"actor" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"key" text NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "idempotency_keys_org_id_key_pk" PRIMARY KEY("org_id","key")
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text DEFAULT nullif(current_setting('app.actor', true), ''),
	"email" text NOT NULL,
	"role" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "invitations_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text DEFAULT nullif(current_setting('app.actor', true), ''),
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'viewer' NOT NULL,
	"custom_role_id" uuid,
	"extra_permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	"artist_scope" uuid[],
	"status" text DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_keys" (
	"org_id" uuid PRIMARY KEY DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"wrapped_key" text NOT NULL,
	"master_key_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_modules" (
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"module" text NOT NULL,
	"enabled" boolean NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_modules_org_id_module_pk" PRIMARY KEY("org_id","module")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"plan" text DEFAULT 'growth' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"agents_paused" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"active_org_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_counters" (
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"month" text NOT NULL,
	"metric" text NOT NULL,
	"value" numeric(18, 6) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_counters_org_id_month_metric_pk" PRIMARY KEY("org_id","month","metric")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"email_verified_at" timestamp with time zone,
	"last_active_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text DEFAULT nullif(current_setting('app.actor', true), ''),
	"type" text NOT NULL,
	"name" text NOT NULL,
	"goal" text NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"model" text NOT NULL,
	"effort" text DEFAULT 'high' NOT NULL,
	"tool_allowlist" text[] DEFAULT '{}'::text[] NOT NULL,
	"role" text DEFAULT 'viewer' NOT NULL,
	"approval_policy" jsonb NOT NULL,
	"budget" jsonb NOT NULL,
	"max_steps" integer DEFAULT 25 NOT NULL,
	"max_runtime_sec" integer DEFAULT 1800 NOT NULL,
	"web_research" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"owner_user_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text DEFAULT nullif(current_setting('app.actor', true), ''),
	"run_id" uuid NOT NULL,
	"step_id" uuid,
	"agent_id" uuid NOT NULL,
	"tool_name" text NOT NULL,
	"tool_use_id" text NOT NULL,
	"risk" text NOT NULL,
	"preview" text NOT NULL,
	"payload" jsonb NOT NULL,
	"edited_payload" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"reason" text,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text DEFAULT nullif(current_setting('app.actor', true), ''),
	"agent_id" uuid,
	"scope" text DEFAULT 'agent' NOT NULL,
	"kind" text DEFAULT 'fact' NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(1024),
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', "agent_memories"."content")) STORED,
	"importance" real DEFAULT 0.5 NOT NULL,
	"source_run_id" uuid,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text DEFAULT nullif(current_setting('app.actor', true), ''),
	"agent_id" uuid NOT NULL,
	"trigger_id" uuid,
	"trigger_kind" text NOT NULL,
	"parent_run_id" uuid,
	"task" text,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"desired_state" text DEFAULT 'run' NOT NULL,
	"current_task" text,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"step_count" integer DEFAULT 0 NOT NULL,
	"result" text,
	"error" text,
	"end_reason" text,
	"checkpoint" jsonb,
	"permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text DEFAULT nullif(current_setting('app.actor', true), ''),
	"run_id" uuid NOT NULL,
	"index" integer NOT NULL,
	"kind" text NOT NULL,
	"tool_name" text,
	"tool_use_id" text,
	"summary" text,
	"input" jsonb,
	"output" jsonb,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text,
	"is_error" boolean DEFAULT false NOT NULL,
	"model" text
);
--> statement-breakpoint
CREATE TABLE "agent_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text DEFAULT nullif(current_setting('app.actor', true), ''),
	"agent_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"config" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_fired_at" timestamp with time zone,
	"token_hash" text
);
--> statement-breakpoint
CREATE TABLE "catalogue_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text DEFAULT nullif(current_setting('app.actor', true), ''),
	"owner_type" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"file_id" uuid NOT NULL,
	"name" text NOT NULL,
	"version" text
);
--> statement-breakpoint
CREATE TABLE "credits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text DEFAULT nullif(current_setting('app.actor', true), ''),
	"track_id" uuid NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"artist_id" uuid
);
--> statement-breakpoint
CREATE TABLE "demos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text DEFAULT nullif(current_setting('app.actor', true), ''),
	"title" text NOT NULL,
	"artist_name" text NOT NULL,
	"submitter_name" text,
	"submitter_email" text,
	"audio_file_id" uuid,
	"links" text[] DEFAULT '{}'::text[] NOT NULL,
	"genre" text,
	"notes" text,
	"score" numeric(4, 1),
	"score_detail" jsonb,
	"stage" text DEFAULT 'new' NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"source" text DEFAULT 'manual' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "distributor_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"distributor" text NOT NULL,
	"pattern" text NOT NULL,
	"weight" numeric(4, 3) DEFAULT '0.6' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "distributor_hints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text DEFAULT nullif(current_setting('app.actor', true), ''),
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"distributor" text NOT NULL,
	"confirmations" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalogue_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text DEFAULT nullif(current_setting('app.actor', true), ''),
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"processed" integer DEFAULT 0 NOT NULL,
	"succeeded" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"auto_confirm" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metadata_lookups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text DEFAULT nullif(current_setting('app.actor', true), ''),
	"input" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"result" jsonb,
	"error" text,
	"release_id" uuid,
	"import_id" uuid
);
--> statement-breakpoint
CREATE TABLE "platform_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text DEFAULT nullif(current_setting('app.actor', true), ''),
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"external_id" text NOT NULL,
	"url" text,
	"confidence" numeric(4, 3) DEFAULT '1' NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'confirmed' NOT NULL,
	"variant" text,
	"reviewed_by" text
);
--> statement-breakpoint
CREATE TABLE "release_artists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"release_id" uuid NOT NULL,
	"artist_id" uuid NOT NULL,
	"role" text DEFAULT 'primary' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "release_tracks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"release_id" uuid NOT NULL,
	"track_id" uuid NOT NULL,
	"disc" integer DEFAULT 1 NOT NULL,
	"position" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text DEFAULT nullif(current_setting('app.actor', true), ''),
	"title" text NOT NULL,
	"type" text DEFAULT 'single' NOT NULL,
	"upc" text,
	"catalog_number" text,
	"release_date" date,
	"label_name" text,
	"distributor" text,
	"distributor_confidence" numeric(4, 3),
	"distributor_evidence" jsonb,
	"status" text DEFAULT 'collecting' NOT NULL,
	"artwork_file_id" uuid,
	"p_line" text,
	"c_line" text,
	"genre" text,
	"notes" text,
	"intake" boolean DEFAULT false NOT NULL,
	"checklist" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "split_parties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text DEFAULT nullif(current_setting('app.actor', true), ''),
	"sheet_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"artist_id" uuid,
	"share_pct" numeric(6, 3) NOT NULL,
	"signed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "split_sheets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text DEFAULT nullif(current_setting('app.actor', true), ''),
	"track_id" uuid NOT NULL,
	"kind" text DEFAULT 'master' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "track_artists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"track_id" uuid NOT NULL,
	"artist_id" uuid NOT NULL,
	"role" text DEFAULT 'primary' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tracks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text DEFAULT nullif(current_setting('app.actor', true), ''),
	"title" text NOT NULL,
	"isrc" text,
	"duration_ms" integer,
	"version" text,
	"explicit" boolean DEFAULT false NOT NULL,
	"genre" text,
	"bpm" integer,
	"musical_key" text,
	"language" text,
	"audio_file_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"blockers" text[] DEFAULT '{}'::text[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_access_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text DEFAULT nullif(current_setting('app.actor', true), ''),
	"type" text DEFAULT 'other' NOT NULL,
	"title" text NOT NULL,
	"file_id" uuid,
	"mime" text,
	"size" bigint,
	"version" integer DEFAULT 1 NOT NULL,
	"previous_id" uuid,
	"is_latest" boolean DEFAULT true NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"confidential" boolean DEFAULT false NOT NULL,
	"contract_status" text,
	"parties" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"extraction_status" text DEFAULT 'none' NOT NULL,
	"extraction_error" text,
	"extracted_terms" jsonb,
	"terms_confirmed_at" timestamp with time zone,
	"terms_confirmed_by" text,
	"terms" jsonb,
	"text_content" text,
	"signed_at" date,
	"effective_date" date,
	"expiry_date" date
);
--> statement-breakpoint
CREATE TABLE "document_key_dates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text DEFAULT nullif(current_setting('app.actor', true), ''),
	"document_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"date" date NOT NULL,
	"description" text NOT NULL,
	"remind_days" integer[] DEFAULT '{90,30,7}'::int[] NOT NULL,
	"last_reminded_for" integer,
	"dismissed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "statement_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"period_start" date,
	"period_end" date,
	"source" text NOT NULL,
	"territory" text,
	"isrc" text,
	"upc" text,
	"track_title" text,
	"track_id" uuid,
	"release_id" uuid,
	"units" bigint DEFAULT 0 NOT NULL,
	"gross_cents" bigint DEFAULT 0 NOT NULL,
	"net_cents" bigint DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drive_file_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drive_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text DEFAULT nullif(current_setting('app.actor', true), ''),
	"folder_id" uuid,
	"name" text NOT NULL,
	"storage_key" text NOT NULL,
	"size" bigint DEFAULT 0 NOT NULL,
	"mime" text DEFAULT 'application/octet-stream' NOT NULL,
	"checksum" text,
	"status" text DEFAULT 'ready' NOT NULL,
	"scan_status" text DEFAULT 'pending' NOT NULL,
	"external_provider" text,
	"external_id" text,
	"confidential" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "drive_folder_permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text DEFAULT nullif(current_setting('app.actor', true), ''),
	"folder_id" uuid NOT NULL,
	"principal_type" text NOT NULL,
	"principal" text NOT NULL,
	"access" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drive_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text DEFAULT nullif(current_setting('app.actor', true), ''),
	"parent_id" uuid,
	"name" text NOT NULL,
	"path" text DEFAULT '/' NOT NULL,
	"external_provider" text,
	"external_id" text,
	"sync_mode" text DEFAULT 'none' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"sync_error" text
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text DEFAULT nullif(current_setting('app.actor', true), ''),
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"href" text,
	"entity_type" text,
	"entity_id" text,
	"actor" text,
	"actor_label" text,
	"read_at" timestamp with time zone,
	"dedupe_key" text
);
--> statement-breakpoint
CREATE TABLE "pipeline_boards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text DEFAULT nullif(current_setting('app.actor', true), ''),
	"name" text NOT NULL,
	"kind" text DEFAULT 'creator' NOT NULL,
	"campaign_id" uuid,
	"stages" jsonb DEFAULT '[{"id":"prospect","name":"Prospect"},{"id":"offered","name":"Offered"},{"id":"booked","name":"Booked"},{"id":"posted","name":"Posted"},{"id":"paid","name":"Paid"}]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text DEFAULT nullif(current_setting('app.actor', true), ''),
	"name" text NOT NULL,
	"release_id" uuid,
	"goals" text,
	"budget_cents" bigint DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"kpis" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"start_date" date,
	"end_date" date,
	"status" text DEFAULT 'planning' NOT NULL,
	"owner_id" uuid
);
--> statement-breakpoint
CREATE TABLE "pipeline_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text DEFAULT nullif(current_setting('app.actor', true), ''),
	"board_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"title" text NOT NULL,
	"contact_id" uuid,
	"campaign_id" uuid,
	"due_date" date,
	"owner_id" uuid,
	"offer_cents" bigint,
	"paid_cents" bigint,
	"paid_at" timestamp with time zone,
	"deliverables_ordered" integer DEFAULT 0 NOT NULL,
	"deliverables_delivered" integer DEFAULT 0 NOT NULL,
	"proof_urls" text[] DEFAULT '{}'::text[] NOT NULL,
	"measured_views" bigint,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "outreach_pitches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text DEFAULT nullif(current_setting('app.actor', true), ''),
	"campaign_id" uuid,
	"contact_id" uuid NOT NULL,
	"playlist_id" uuid,
	"track_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"subject" text,
	"body" text,
	"sent_at" timestamp with time zone,
	"replied_at" timestamp with time zone,
	"outcome" text,
	"agent_run_id" uuid
);
--> statement-breakpoint
CREATE TABLE "sketchboards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text DEFAULT nullif(current_setting('app.actor', true), ''),
	"name" text NOT NULL,
	"campaign_id" uuid,
	"canvas" jsonb DEFAULT '{"items":[]}'::jsonb NOT NULL,
	"collaborators" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text DEFAULT nullif(current_setting('app.actor', true), ''),
	"type" text DEFAULT 'creator' NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"organization" text,
	"handles" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"audience_size" bigint,
	"genres" text[] DEFAULT '{}'::text[] NOT NULL,
	"rate_cents" integer,
	"currency" text DEFAULT 'USD' NOT NULL,
	"stage" text DEFAULT 'lead' NOT NULL,
	"country" text,
	"payout_email" text,
	"verified_at" timestamp with time zone,
	"gone_at" timestamp with time zone,
	"notes" text,
	"last_contacted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "interactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text DEFAULT nullif(current_setting('app.actor', true), ''),
	"contact_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"direction" text DEFAULT 'outbound' NOT NULL,
	"summary" text NOT NULL,
	"campaign_id" uuid,
	"agent_run_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "playlists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text DEFAULT nullif(current_setting('app.actor', true), ''),
	"contact_id" uuid,
	"platform" text NOT NULL,
	"name" text NOT NULL,
	"url" text,
	"external_id" text,
	"followers" bigint,
	"genres" text[] DEFAULT '{}'::text[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text DEFAULT nullif(current_setting('app.actor', true), ''),
	"name" text NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"legal_name" text,
	"status" text DEFAULT 'prospect' NOT NULL,
	"country" text,
	"email" text,
	"manager" text,
	"bio" text,
	"socials" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"spotify_artist_id" text,
	"youtube_channel_id" text,
	"payout_method" text DEFAULT 'none' NOT NULL,
	"onboarding" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"onboarding_owner_id" uuid,
	"onboarding_started_at" timestamp with time zone,
	"roster_since" date,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "staff_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text DEFAULT nullif(current_setting('app.actor', true), ''),
	"user_id" uuid NOT NULL,
	"title" text,
	"department" text,
	"phone" text,
	"bio" text
);
--> statement-breakpoint
CREATE TABLE "data_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text DEFAULT nullif(current_setting('app.actor', true), ''),
	"status" text DEFAULT 'queued' NOT NULL,
	"storage_key" text,
	"size" bigint,
	"tables" text[],
	"error" text,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "stream_alert_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text DEFAULT nullif(current_setting('app.actor', true), ''),
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"threshold" numeric(14, 2) NOT NULL,
	"window_days" integer DEFAULT 7 NOT NULL,
	"platform" text,
	"min_daily" integer DEFAULT 100 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stream_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text DEFAULT nullif(current_setting('app.actor', true), ''),
	"rule_id" uuid,
	"track_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"platform" text NOT NULL,
	"day" date NOT NULL,
	"value" bigint NOT NULL,
	"baseline" bigint,
	"message" text NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" text
);
--> statement-breakpoint
CREATE TABLE "stream_daily" (
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"track_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"source" text NOT NULL,
	"day" date NOT NULL,
	"total" bigint NOT NULL,
	"delta" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "stream_daily_org_id_track_id_platform_source_day_pk" PRIMARY KEY("org_id","track_id","platform","source","day")
);
--> statement-breakpoint
CREATE TABLE "stream_tracks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT nullif(current_setting('app.org_id', true), '')::uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text DEFAULT nullif(current_setting('app.actor', true), ''),
	"track_id" uuid NOT NULL,
	"isrc" text,
	"tier" text DEFAULT 'catalogue' NOT NULL,
	"status" text DEFAULT 'pending_match' NOT NULL,
	"next_poll_at" timestamp with time zone,
	"last_polled_at" timestamp with time zone,
	"last_resolved_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_parent_run_id_agent_runs_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_steps" ADD CONSTRAINT "agent_steps_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_triggers" ADD CONSTRAINT "agent_triggers_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credits" ADD CONSTRAINT "credits_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_artists" ADD CONSTRAINT "release_artists_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_artists" ADD CONSTRAINT "release_artists_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_tracks" ADD CONSTRAINT "release_tracks_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_tracks" ADD CONSTRAINT "release_tracks_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "split_parties" ADD CONSTRAINT "split_parties_sheet_id_split_sheets_id_fk" FOREIGN KEY ("sheet_id") REFERENCES "public"."split_sheets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "split_sheets" ADD CONSTRAINT "split_sheets_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "track_artists" ADD CONSTRAINT "track_artists_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "track_artists" ADD CONSTRAINT "track_artists_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_access_log" ADD CONSTRAINT "document_access_log_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_links" ADD CONSTRAINT "document_links_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_file_id_drive_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."drive_files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_previous_id_documents_id_fk" FOREIGN KEY ("previous_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_key_dates" ADD CONSTRAINT "document_key_dates_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_lines" ADD CONSTRAINT "statement_lines_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_lines" ADD CONSTRAINT "statement_lines_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_lines" ADD CONSTRAINT "statement_lines_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_file_links" ADD CONSTRAINT "drive_file_links_file_id_drive_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."drive_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_files" ADD CONSTRAINT "drive_files_folder_id_drive_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."drive_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_folder_permissions" ADD CONSTRAINT "drive_folder_permissions_folder_id_drive_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."drive_folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_folders" ADD CONSTRAINT "drive_folders_parent_id_drive_folders_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."drive_folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_boards" ADD CONSTRAINT "pipeline_boards_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_cards" ADD CONSTRAINT "pipeline_cards_board_id_pipeline_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."pipeline_boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_cards" ADD CONSTRAINT "pipeline_cards_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_cards" ADD CONSTRAINT "pipeline_cards_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_pitches" ADD CONSTRAINT "outreach_pitches_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_pitches" ADD CONSTRAINT "outreach_pitches_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_pitches" ADD CONSTRAINT "outreach_pitches_playlist_id_playlists_id_fk" FOREIGN KEY ("playlist_id") REFERENCES "public"."playlists"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_pitches" ADD CONSTRAINT "outreach_pitches_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sketchboards" ADD CONSTRAINT "sketchboards_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlists" ADD CONSTRAINT "playlists_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stream_alerts" ADD CONSTRAINT "stream_alerts_rule_id_stream_alert_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."stream_alert_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stream_alerts" ADD CONSTRAINT "stream_alerts_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stream_daily" ADD CONSTRAINT "stream_daily_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stream_tracks" ADD CONSTRAINT "stream_tracks_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_org_created_idx" ON "audit_log" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_target_idx" ON "audit_log" USING btree ("org_id","target_type","target_id");--> statement-breakpoint
CREATE INDEX "credentials_org_provider_idx" ON "credentials" USING btree ("org_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_roles_org_name_idx" ON "custom_roles" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "domain_events_pending_idx" ON "domain_events" USING btree ("id") WHERE "domain_events"."dispatched_at" is null;--> statement-breakpoint
CREATE INDEX "domain_events_org_type_idx" ON "domain_events" USING btree ("org_id","type");--> statement-breakpoint
CREATE INDEX "invitations_org_idx" ON "invitations" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_org_user_idx" ON "memberships" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_idx" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "agents_org_status_idx" ON "agents" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "approvals_org_status_idx" ON "approvals" USING btree ("org_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_run_tool_use_idx" ON "approvals" USING btree ("run_id","tool_use_id");--> statement-breakpoint
CREATE INDEX "agent_memories_agent_idx" ON "agent_memories" USING btree ("org_id","agent_id");--> statement-breakpoint
CREATE INDEX "agent_memories_tsv_idx" ON "agent_memories" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "agent_runs_agent_idx" ON "agent_runs" USING btree ("org_id","agent_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_runs_status_idx" ON "agent_runs" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "agent_runs_parent_idx" ON "agent_runs" USING btree ("parent_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_steps_run_index_idx" ON "agent_steps" USING btree ("run_id","index");--> statement-breakpoint
CREATE INDEX "agent_steps_org_idx" ON "agent_steps" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_triggers_due_idx" ON "agent_triggers" USING btree ("next_run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_triggers_token_idx" ON "agent_triggers" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "agent_triggers_event_idx" ON "agent_triggers" USING btree ("org_id","kind");--> statement-breakpoint
CREATE INDEX "catalogue_assets_owner_idx" ON "catalogue_assets" USING btree ("org_id","owner_type","owner_id");--> statement-breakpoint
CREATE INDEX "credits_track_idx" ON "credits" USING btree ("org_id","track_id");--> statement-breakpoint
CREATE INDEX "demos_org_stage_idx" ON "demos" USING btree ("org_id","stage","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "distributor_aliases_uniq" ON "distributor_aliases" USING btree ("distributor","pattern");--> statement-breakpoint
CREATE UNIQUE INDEX "distributor_hints_uniq" ON "distributor_hints" USING btree ("org_id","kind","value","distributor");--> statement-breakpoint
CREATE INDEX "catalogue_imports_org_idx" ON "catalogue_imports" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "metadata_lookups_org_idx" ON "metadata_lookups" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_identities_uniq" ON "platform_identities" USING btree ("org_id","entity_type","entity_id","platform","external_id");--> statement-breakpoint
CREATE INDEX "platform_identities_entity_idx" ON "platform_identities" USING btree ("org_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "platform_identities_status_idx" ON "platform_identities" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "release_artists_uniq" ON "release_artists" USING btree ("release_id","artist_id");--> statement-breakpoint
CREATE INDEX "release_artists_artist_idx" ON "release_artists" USING btree ("org_id","artist_id");--> statement-breakpoint
CREATE UNIQUE INDEX "release_tracks_uniq" ON "release_tracks" USING btree ("release_id","track_id");--> statement-breakpoint
CREATE INDEX "release_tracks_track_idx" ON "release_tracks" USING btree ("org_id","track_id");--> statement-breakpoint
CREATE INDEX "releases_org_date_idx" ON "releases" USING btree ("org_id","release_date");--> statement-breakpoint
CREATE UNIQUE INDEX "releases_org_upc_idx" ON "releases" USING btree ("org_id","upc");--> statement-breakpoint
CREATE INDEX "split_parties_sheet_idx" ON "split_parties" USING btree ("sheet_id");--> statement-breakpoint
CREATE UNIQUE INDEX "split_sheets_track_kind_idx" ON "split_sheets" USING btree ("track_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "track_artists_uniq" ON "track_artists" USING btree ("track_id","artist_id");--> statement-breakpoint
CREATE INDEX "track_artists_artist_idx" ON "track_artists" USING btree ("org_id","artist_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tracks_org_isrc_idx" ON "tracks" USING btree ("org_id","isrc");--> statement-breakpoint
CREATE INDEX "tracks_org_title_idx" ON "tracks" USING btree ("org_id","title");--> statement-breakpoint
CREATE INDEX "document_access_log_doc_idx" ON "document_access_log" USING btree ("org_id","document_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "document_links_uniq" ON "document_links" USING btree ("document_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "document_links_entity_idx" ON "document_links" USING btree ("org_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "documents_org_type_idx" ON "documents" USING btree ("org_id","type","is_latest");--> statement-breakpoint
CREATE INDEX "documents_org_expiry_idx" ON "documents" USING btree ("org_id","expiry_date");--> statement-breakpoint
CREATE INDEX "document_key_dates_org_date_idx" ON "document_key_dates" USING btree ("org_id","date");--> statement-breakpoint
CREATE INDEX "statement_lines_doc_idx" ON "statement_lines" USING btree ("org_id","document_id");--> statement-breakpoint
CREATE INDEX "statement_lines_track_idx" ON "statement_lines" USING btree ("org_id","track_id","period_end");--> statement-breakpoint
CREATE UNIQUE INDEX "drive_file_links_uniq" ON "drive_file_links" USING btree ("file_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "drive_file_links_entity_idx" ON "drive_file_links" USING btree ("org_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "drive_files_folder_idx" ON "drive_files" USING btree ("org_id","folder_id");--> statement-breakpoint
CREATE UNIQUE INDEX "drive_files_external_idx" ON "drive_files" USING btree ("org_id","external_provider","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "drive_folder_perm_idx" ON "drive_folder_permissions" USING btree ("folder_id","principal_type","principal");--> statement-breakpoint
CREATE INDEX "drive_folders_parent_idx" ON "drive_folders" USING btree ("org_id","parent_id");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("org_id","user_id","read_at","created_at");--> statement-breakpoint
CREATE INDEX "notifications_dedupe_idx" ON "notifications" USING btree ("org_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "pipeline_boards_org_idx" ON "pipeline_boards" USING btree ("org_id","campaign_id");--> statement-breakpoint
CREATE INDEX "campaigns_org_status_idx" ON "campaigns" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "pipeline_cards_board_idx" ON "pipeline_cards" USING btree ("org_id","board_id","stage","position");--> statement-breakpoint
CREATE INDEX "pipeline_cards_campaign_idx" ON "pipeline_cards" USING btree ("org_id","campaign_id");--> statement-breakpoint
CREATE INDEX "outreach_pitches_org_idx" ON "outreach_pitches" USING btree ("org_id","campaign_id","status");--> statement-breakpoint
CREATE INDEX "sketchboards_org_idx" ON "sketchboards" USING btree ("org_id","campaign_id");--> statement-breakpoint
CREATE INDEX "contacts_org_type_idx" ON "contacts" USING btree ("org_id","type");--> statement-breakpoint
CREATE INDEX "contacts_org_name_idx" ON "contacts" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "interactions_contact_idx" ON "interactions" USING btree ("org_id","contact_id","occurred_at");--> statement-breakpoint
CREATE INDEX "playlists_org_idx" ON "playlists" USING btree ("org_id","platform");--> statement-breakpoint
CREATE INDEX "artists_org_name_idx" ON "artists" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "artists_org_status_idx" ON "artists" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "staff_org_user_idx" ON "staff_members" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "data_exports_org_idx" ON "data_exports" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "stream_alert_rules_org_idx" ON "stream_alert_rules" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stream_alerts_dedupe_idx" ON "stream_alerts" USING btree ("org_id","track_id","kind","platform","day");--> statement-breakpoint
CREATE INDEX "stream_alerts_org_idx" ON "stream_alerts" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "stream_daily_day_idx" ON "stream_daily" USING btree ("org_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX "stream_tracks_track_idx" ON "stream_tracks" USING btree ("org_id","track_id");--> statement-breakpoint
CREATE INDEX "stream_tracks_due_idx" ON "stream_tracks" USING btree ("next_poll_at");