-- 修复 trigram 索引未命中：查询条件统一写作 coalesce(col,'') ilike，
-- 而 0001/0020 建的是普通列索引 (title/description)，表达式与列不匹配 →  planner 走 Seq Scan。
-- 这里补「同表达式」的 GIN 索引，让标题/摘要/正文的全文 ilike 都能走 Bitmap Index Scan。
-- 真库实测：27 万行 content 表达式索引构建耗时较长（分钟级），期间 health 可能 starting，属预期。
-- 沿用 IF NOT EXISTS，旧库重复执行安全；不删旧索引（其它直接列匹配路径仍可能用到）。

CREATE INDEX IF NOT EXISTS "entries_desc_trgm_expr"
  ON "entries" USING gin (coalesce("description", '') gin_trgm_ops);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "entries_content_trgm_expr"
  ON "entries" USING gin (coalesce("content", '') gin_trgm_ops);--> statement-breakpoint

-- title 的查询在 entryConditions 里是裸列 ilike（无 coalesce），0001 的普通列索引已匹配，
-- 无需重复建；这里只补 description / content 两处 coalesce 表达式。
