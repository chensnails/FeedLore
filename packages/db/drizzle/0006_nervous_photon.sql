ALTER TABLE "entries" ADD COLUMN "watch_tagged_at" timestamp;--> statement-breakpoint
-- 已有标记从升级时刻起算保留期，避免升级后被立即清掉
UPDATE "entries" SET "watch_tagged_at" = now() WHERE "watch_state" IS NOT NULL;
