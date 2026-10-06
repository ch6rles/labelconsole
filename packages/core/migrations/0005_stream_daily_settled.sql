ALTER TABLE "stream_daily" ADD COLUMN "raw_delta" bigint;--> statement-breakpoint
ALTER TABLE "stream_daily" ADD COLUMN "estimated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "stream_daily" ADD COLUMN "pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Rows recorded before settling keep their plays as read.
UPDATE "stream_daily" SET "raw_delta" = "delta" WHERE "raw_delta" IS NULL;
