-- 去重判定收紧（Phase 2 · T-B 修正）
--
-- 旧口径只比「归一化标题」，在 196k 条真实数据上标出 7 万条重复（36%），
-- 混进了大量「同名不同篇」：剧集第 1-5 集 / 第 1-9 集、2160p / 1080p、
-- 每周都发的「Epic 本周限免」、每次开机的「开机提醒」，以及「人找车」这类短标题。
--
-- 新口径（与 apps/server/src/lib/dedup.ts 逐字对应）：
--   归一化标题：regexp_replace(lower(title), '[^[:alnum:]]', '', 'g')  —— 白名单，只留字母数字与中文
--               归一化后为空才退回链接：'l:' || lower(btrim(link))    —— 链接原样，不动 query
--   判为重复：与组内首条（最小 id）相比，
--             · 链接完全相同（两侧都 >= 12 字符），或
--             · 摘要完全相同（两侧都 >= 40 字符）
--
-- 键格式随之加上 't:' / 'l:' 前缀，所以这里全量重算一次（幂等）。

UPDATE "entries" SET "dedup_key" = CASE
  WHEN regexp_replace(lower(coalesce("title", '')), '[^[:alnum:]]', '', 'g') <> ''
    THEN 't:' || regexp_replace(lower(coalesce("title", '')), '[^[:alnum:]]', '', 'g')
  WHEN length(btrim(coalesce("link", ''))) >= 12
    THEN 'l:' || lower(btrim("link"))
  ELSE ''
END;
--> statement-breakpoint
-- 旧标记全部作废，按新口径重算（含链式：先清零再单遍标记，避免指向中间节点）
UPDATE "entries" SET "duplicate_of" = NULL WHERE "duplicate_of" IS NOT NULL;
--> statement-breakpoint
WITH prim AS (
	SELECT e.id AS eid,
	       first_value(e.id) OVER (PARTITION BY f.owner_id, e.dedup_key ORDER BY e.id) AS pid
	FROM entries e
	JOIN feeds f ON f.id = e.feed_id
	WHERE e.dedup_key <> ''
)
UPDATE entries e SET duplicate_of = prim.pid
FROM prim
JOIN entries p ON p.id = prim.pid
WHERE e.id = prim.eid
  AND e.id > prim.pid
  AND (
    (length(btrim(coalesce(e.link, ''))) >= 12
      AND lower(btrim(e.link)) = lower(btrim(p.link)))
    OR (length(coalesce(e.description, '')) >= 40
      AND e.description = p.description)
  );
