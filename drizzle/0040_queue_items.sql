CREATE TABLE "queue_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"body" text NOT NULL,
	"by_factory" boolean NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "queue_images" (
	"id" text PRIMARY KEY NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "queue_items" (
	"id" text PRIMARY KEY NOT NULL,
	"n" integer NOT NULL,
	"key" text NOT NULL,
	"request_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"state" text NOT NULL,
	"labels" jsonb NOT NULL,
	"url" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "queue_items_state_check" CHECK ("queue_items"."state" in ('Todo', 'In Progress', 'In Review', 'Done', 'Canceled'))
);
--> statement-breakpoint
ALTER TABLE "queue_comments" ADD CONSTRAINT "queue_comments_item_id_queue_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."queue_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "queue_comments_item_idx" ON "queue_comments" USING btree ("item_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "queue_items_n_idx" ON "queue_items" USING btree ("n");--> statement-breakpoint
CREATE UNIQUE INDEX "queue_items_key_idx" ON "queue_items" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "queue_items_request_idx" ON "queue_items" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "queue_items_state_idx" ON "queue_items" USING btree ("state");