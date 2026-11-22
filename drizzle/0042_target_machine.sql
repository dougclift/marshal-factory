ALTER TABLE "incoming_jobs" ADD COLUMN "target_machine" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "target_machine" text;--> statement-breakpoint
ALTER TABLE "queue_items" ADD COLUMN "target_machine" text;