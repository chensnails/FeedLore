-- 移除去重功能（Phase 2 · T-B 整体下线）
--
-- 去重带来的问题大于收益：跨源转载折叠会让条目从频道里消失，判据再收紧也只能做到
-- 「同名同链接/同名同摘要」，而库里有大量同名不同篇。产品决定整体移除。
--
-- 幂等：IF EXISTS 兜底，重复执行无副作用。

DROP INDEX IF EXISTS "entries_duplicate_of_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "entries_dedup_key_idx";
--> statement-breakpoint
ALTER TABLE "entries" DROP COLUMN IF EXISTS "duplicate_of";
--> statement-breakpoint
ALTER TABLE "entries" DROP COLUMN IF EXISTS "dedup_key";
