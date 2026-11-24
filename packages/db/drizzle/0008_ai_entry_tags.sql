CREATE TABLE "entry_ai_tags" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"entry_id" bigint NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"model" text,
	"prompt_version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'done' NOT NULL,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "entry_ai_tags_user_entry_key" UNIQUE("user_id","entry_id")
);
--> statement-breakpoint
ALTER TABLE "entry_ai_tags" ADD CONSTRAINT "entry_ai_tags_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "entry_ai_tags" ADD CONSTRAINT "entry_ai_tags_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "entries"("id") ON DELETE cascade ON UPDATE no action;
