-- 性能索引：镜像 legacy 高频查询路径（卡片墙/未读徽标/收藏/关注屏蔽/模糊搜索）
-- 注：drizzle-orm 0.44.7 的 index().on(列) 有回归（列对象缺失 defaultConfig 字段），
-- 且 drizzle-kit 无法为 DESC NULLS LAST / GIN+gin_trgm_ops 这类表达式索引生成 SQL，
-- 故统一在此用原始 SQL 创建（与迁移 0000 的 breakpoints 格式保持一致）。

-- 模糊搜索所需的 trigram 扩展（已存在则跳过）
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint

-- 多用户列订阅源（卡片页/未读计数/列表）
CREATE INDEX IF NOT EXISTS "feeds_owner_idx" ON "feeds" USING btree ("owner_id","sort_order","id");--> statement-breakpoint

-- 卡片墙默认排序（发布时间倒序，NULL 排最后）
CREATE INDEX IF NOT EXISTS "entries_pub_idx" ON "entries" USING btree ("published_at" DESC NULLS LAST,"id" DESC);--> statement-breakpoint

-- 单频道内倒序
CREATE INDEX IF NOT EXISTS "entries_feed_pub_idx" ON "entries" USING btree ("feed_id","published_at" DESC NULLS LAST,"id" DESC);--> statement-breakpoint

-- 标签 GIN（筛选）
CREATE INDEX IF NOT EXISTS "entries_tags_idx" ON "entries" USING gin ("tags");--> statement-breakpoint

-- 未读部分索引（侧栏徽标/未读列表高频）
CREATE INDEX IF NOT EXISTS "entries_unread_idx" ON "entries" USING btree ("feed_id") WHERE "is_read" = false;--> statement-breakpoint

-- 关注/屏蔽部分索引
CREATE INDEX IF NOT EXISTS "entries_watch_idx" ON "entries" USING btree ("watch_state","published_at" DESC NULLS LAST,"id" DESC) WHERE "watch_state" IS NOT NULL;--> statement-breakpoint

-- 收藏部分索引
CREATE INDEX IF NOT EXISTS "entries_fav_idx" ON "entries" USING btree ("favorited_at" DESC NULLS LAST,"id" DESC) WHERE "is_favorite" = true;--> statement-breakpoint

-- 图片缓存 LRU/TTL
CREATE INDEX IF NOT EXISTS "image_cache_created_idx" ON "image_cache" USING btree ("created_at");--> statement-breakpoint

-- 标题模糊搜索（GIN + trigram）
CREATE INDEX IF NOT EXISTS "entries_title_trgm" ON "entries" USING gin ("title" gin_trgm_ops);
