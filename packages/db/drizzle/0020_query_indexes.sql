-- 列表/搜索高频路径补索引（纯加索引，不改任何响应结构与视觉）。
-- 延续 0001/0018 的约定：DESC NULLS LAST / 部分索引。
-- 全部 IF NOT EXISTS，旧库重复执行也安全；重型 trigram GIN 不在这里建。

-- 未读视图：owner 过滤后还要 is_read=false + 时间倒序；原来的
-- entries_unread_idx 只按 feed_id，entries_pub_idx 又不含未读条件。
CREATE INDEX IF NOT EXISTS "entries_unread_pub_idx"
  ON "entries" USING btree ("published_at" DESC NULLS LAST, "id" DESC)
  WHERE "is_read" = false;--> statement-breakpoint

-- 幂等导入/去重按 guid 单独点查（原只有 (feed_id, guid) 复合唯一，不能用 guid 前缀）。
CREATE INDEX IF NOT EXISTS "entries_guid_idx" ON "entries" USING btree ("guid");--> statement-breakpoint

-- 搜索用的 description trigram GIN 已移到监听后的后台任务
-- （apps/server/src/lib/perfIndexes.ts）；大表建 GIN 会扫全表数分钟，不能阻塞启动。

-- AI 任务并发上限查询：where user_id=? and status in ('queued','running')。
CREATE INDEX IF NOT EXISTS "ai_jobs_user_status_idx"
  ON "ai_jobs" USING btree ("user_id", "status");--> statement-breakpoint

-- 会话设备列表：where user_id=? and expires_at>now() order by updated_at desc。
CREATE INDEX IF NOT EXISTS "sessions_user_updated_idx"
  ON "sessions" USING btree ("user_id", "updated_at" DESC);
