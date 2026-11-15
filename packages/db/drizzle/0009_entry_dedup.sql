ALTER TABLE "entries" ADD COLUMN "duplicate_of" bigint;
--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "dedup_key" text;
--> statement-breakpoint
CREATE INDEX "entries_dedup_key_idx" ON "entries" ("dedup_key");
--> statement-breakpoint
CREATE INDEX "entries_duplicate_of_idx" ON "entries" ("duplicate_of") WHERE "duplicate_of" IS NOT NULL;
--> statement-breakpoint
UPDATE "entries" SET "dedup_key" = lower(regexp_replace(coalesce("title", ''), '[[:space:][:punct:]，。！？；：、“”‘’【】《》〈〉（）—…·]', '', 'g')) WHERE "dedup_key" IS NULL;
--> statement-breakpoint
WITH prim AS (
	SELECT e.id AS eid,
	       first_value(e.id) OVER (PARTITION BY f.owner_id, e.dedup_key ORDER BY e.id) AS pid,
	       row_number() OVER (PARTITION BY f.owner_id, e.dedup_key ORDER BY e.id) AS rn
	FROM entries e
	JOIN feeds f ON f.id = e.feed_id
	WHERE e.dedup_key IS NOT NULL AND e.dedup_key <> ''
)
UPDATE entries e SET duplicate_of = prim.pid
FROM prim
WHERE e.id = prim.eid AND prim.rn > 1;
