-- AI 异步任务：提交即返回 jobId，前端按间隔轮询状态
--
-- 为什么需要这张表：单篇生成实测 4~160 秒、日报可达数分钟，都长于 Cloudflare 的
-- 100 秒代理读超时。改成「提交 → 轮询」后不再有长连接，网关超时失效；
-- 任务落库才能让前端、设置页、排障脚本看到同一个状态。
--
-- status：queued → running → succeeded / failed（单向）。
-- 进程重启时残留的 queued/running 由启动清扫标成 failed。

CREATE TABLE IF NOT EXISTS "ai_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"error" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"finished_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_jobs_user_time_idx" ON "ai_jobs" ("user_id","created_at" DESC NULLS LAST,"id" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_jobs_status_idx" ON "ai_jobs" ("status","created_at");
