-- 多路 AI 提供商 + 任务级能力开关/路由
--
-- 为什么独立表：原来 user_llm 一个账号一行，所有 AI 任务共用一个模型。
-- 用户要「日报用强模型、标签用便宜模型」，就得有多套 baseUrl/key/model。
-- 每行独立加密，能单独删改某一路而不动其它路的 Key。
--
-- 向后兼容：user_llm 原有的三件套保留为「默认槽」，升级后所有未分配的任务
-- 自动回落到它，用户无需重填 Key。routes 为空对象 = 全部能力开启、全走默认槽。
--
-- routes 形态（jsonb，服务端解析时逐键容错）：
--   { "entry_ai": {"enabled":true,"providerId":"p1",
--                  "actions":{"summary":"p1","translate":"p2"}},
--     "ai_tags": {"enabled":true,"providerId":"p2"}, ... }
-- providerId 指向本表 id，或 "default" 表示回落 user_llm 默认槽。

CREATE TABLE IF NOT EXISTS "llm_providers" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"encrypted_key" text,
	"base_url" text,
	"model" text,
	"temperature" real,
	"thinking" boolean DEFAULT false NOT NULL,
	"thinking_depth" integer DEFAULT 0 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "llm_providers" ADD CONSTRAINT "llm_providers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_providers_user_idx" ON "llm_providers" ("user_id");
--> statement-breakpoint
ALTER TABLE "user_llm" ADD COLUMN IF NOT EXISTS "routes" jsonb DEFAULT '{}'::jsonb NOT NULL;
