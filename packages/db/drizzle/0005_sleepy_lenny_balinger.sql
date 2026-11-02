CREATE TABLE "article_cache" (
	"url" text PRIMARY KEY NOT NULL,
	"content" text,
	"body_json" text,
	"images" text[] DEFAULT '{}' NOT NULL,
	"fetched_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feeds" ADD COLUMN "full_text" boolean DEFAULT false NOT NULL;