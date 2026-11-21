CREATE TABLE "incoming_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"provider" text,
	"execution" text,
	"repo" text,
	"source" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "incoming_jobs_created_idx" ON "incoming_jobs" USING btree ("created_at");