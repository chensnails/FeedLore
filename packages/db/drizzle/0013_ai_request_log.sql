-- AI 请求明细：设置 → 模型 →「模型状态」的列表数据源
--
-- 与 ai_usage_daily 分工：那张表按天聚合，这张表逐次记录「在做什么 / 成没成 / 多慢」。
-- 每个账号只保留最近 200 条且不超过 30 天，由 apps/server/src/lib/aiUsage.ts 在写入后裁剪。

CREATE TABLE IF NOT EXISTS "ai_request_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"ok" boolean DEFAULT true NOT NULL,
	"calls" integer DEFAULT 1 NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"prompt_tokens" bigint DEFAULT 0 NOT NULL,
	"completion_tokens" bigint DEFAULT 0 NOT NULL,
	"error" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_request_log" ADD CONSTRAINT "ai_request_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_request_log_user_time_idx" ON "ai_request_log" ("user_id","created_at" DESC NULLS LAST,"id" DESC);
