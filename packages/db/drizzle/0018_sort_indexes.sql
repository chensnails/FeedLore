-- 列表其余两种排序的索引（0001 只覆盖了默认的「发布时间倒序」）。
-- entries.published_at 可空，而 NULLS LAST 的位置不能靠倒扫补齐：
-- (published_at DESC NULLS LAST) 反向扫出来是 ASC NULLS FIRST，不是 sort=old 要的顺序。

-- sort=old：最早发布在前（同时覆盖 AI 打标按时间正序取批）
CREATE INDEX IF NOT EXISTS "entries_pub_asc_idx" ON "entries" USING btree ("published_at" ASC NULLS LAST,"id" ASC);--> statement-breakpoint

-- sort=old 的单频道版本（与 entries_feed_pub_idx 对称）
CREATE INDEX IF NOT EXISTS "entries_feed_pub_asc_idx" ON "entries" USING btree ("feed_id","published_at" ASC NULLS LAST,"id" ASC);--> statement-breakpoint

-- sort=name：按标题（忽略大小写）升序
CREATE INDEX IF NOT EXISTS "entries_title_lower_idx" ON "entries" USING btree (lower("title") ASC,"id" ASC);
