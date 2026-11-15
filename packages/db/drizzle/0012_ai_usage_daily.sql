-- AI 用量统计：按「账号 × 日期 × 功能」聚合
--
-- 只存聚合值：统计要回答的是「谁、哪天、哪项功能、几次、多少 token」，
-- 行数 = 账号数 × 天数 × 5 类功能，可控且查询永远走主键。

CREATE TABLE IF NOT EXISTS "ai_usage_daily" (
	"user_id" text NOT NULL,
	"date" date NOT NULL,
	"kind" text NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"fails" integer DEFAULT 0 NOT NULL,
	"prompt_tokens" bigint DEFAULT 0 NOT NULL,
	"completion_tokens" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "ai_usage_daily_user_id_date_kind_pk" PRIMARY KEY("user_id","date","kind")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_usage_daily" ADD CONSTRAINT "ai_usage_daily_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
