import { type Db, entries, feeds } from '@feedlore/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DEFAULT_KEEP_DAYS, KEEP_PER_FEED } from '../env';
import type { NormalizedItem } from './rss';
import type { SourceConfig } from './settings';
import { invalidateTagCounts } from './tagCountsCache';
import type { WatchVerdict } from './watch';

export async function saveFeedMeta(
  db: Db,
  feedId: number,
  meta: {
    title?: string | null;
    siteUrl?: string | null;
    description?: string | null;
    iconUrl?: string | null;
    etag?: string | null;
    lastModified?: string | null;
    status: string;
    error?: string | null;
    failStreak?: number;
  },
): Promise<void> {
  const set: Partial<typeof feeds.$inferInsert> = {
    lastStatus: meta.status,
    lastError: meta.error ?? null,
    lastFetchedAt: new Date(),
    updatedAt: new Date(),
  };
  if (meta.title) set.title = meta.title;
  if (meta.siteUrl) set.siteUrl = meta.siteUrl;
  if (meta.description) set.description = meta.description;
  if (meta.iconUrl) set.iconUrl = meta.iconUrl;
  if (meta.etag !== undefined) set.etag = meta.etag;
  if (meta.lastModified !== undefined) set.lastModified = meta.lastModified;
  if (Number.isFinite(meta.failStreak)) set.failStreak = Math.max(0, Number(meta.failStreak));

  await db.update(feeds).set(set).where(eq(feeds.id, feedId));
}

export async function bumpFailStreak(db: Db, feedId: number): Promise<number> {
  const res = await db.execute(sql`
    update feeds set fail_streak = fail_streak + 1, updated_at = now()
     where id = ${feedId}
    returning fail_streak
  `);
  const row = (res.rows as unknown as Array<{ fail_streak: number }>)[0];
  return row ? Number(row.fail_streak) : 0;
}

export interface UpsertResult {
  inserted: number;
  fresh: NormalizedItem[];
}

export function dedupeByGuid(items: NormalizedItem[]): NormalizedItem[] {
  if (items.length < 2) return items;
  const byGuid = new Map<string, NormalizedItem>();
  for (const it of items) byGuid.set(it.guid, it);
  return byGuid.size === items.length ? items : [...byGuid.values()];
}

export async function upsertEntries(
  db: Db,
  feedId: number,
  items: NormalizedItem[],
): Promise<UpsertResult> {
  const list = dedupeByGuid(items);
  if (!list.length) return { inserted: 0, fresh: [] };

  const guids = [...new Set(list.map((it) => it.guid))];
  const existing = await db
    .select({ guid: entries.guid })
    .from(entries)
    .where(and(eq(entries.feedId, feedId), inArray(entries.guid, guids)));
  const seen = new Set(existing.map((r) => r.guid));
  const fresh = list.filter((it) => !seen.has(it.guid));

  await db
    .insert(entries)
    .values(
      list.map((it) => ({
        feedId,
        guid: it.guid,
        title: it.title,
        link: it.link,
        pwd: it.pwd,
        description: it.description,
        content: it.content,
        size: it.size,
        tags: it.tags,
        image: it.image,
        images: it.images,
        links: it.links,
        sourceUrl: it.sourceUrl,
        bodyJson: it.bodyJson,
        bodyVersion: it.bodyVersion,
        publishedAt: it.publishedAt,
      })),
    )
    .onConflictDoUpdate({
      target: [entries.feedId, entries.guid],
      set: {
        title: sql`excluded.title`,
        link: sql`excluded.link`,
        pwd: sql`excluded.pwd`,
        description: sql`excluded.description`,
        content: sql`coalesce(excluded.content, ${entries.content})`,
        size: sql`excluded.size`,
        tags: sql`excluded.tags`,
        image: sql`excluded.image`,
        images: sql`excluded.images`,
        bodyJson: sql`coalesce(excluded.body_json, ${entries.bodyJson})`,
        bodyVersion: sql`case when excluded.body_json is not null then excluded.body_version else ${entries.bodyVersion} end`,
        links: sql`excluded.links`,
        sourceUrl: sql`excluded.source_url`,
        publishedAt: sql`excluded.published_at`,
      },
    });

  if (fresh.length) invalidateTagCounts();
  return { inserted: fresh.length, fresh };
}

export async function markWatch(db: Db, feedId: number, verdicts: WatchVerdict[]): Promise<void> {
  if (!verdicts.length) return;

  const groups = new Map<string, { state: string; rule: string; guids: string[] }>();
  for (const v of verdicts) {
    const key = `${v.state}\u0000${v.rule}`;
    const g = groups.get(key) ?? { state: v.state, rule: v.rule, guids: [] };
    g.guids.push(v.guid);
    groups.set(key, g);
  }

  for (const g of groups.values()) {
    await db
      .update(entries)
      .set({ watchState: g.state, watchRule: g.rule, watchTaggedAt: new Date() })
      .where(and(eq(entries.feedId, feedId), inArray(entries.guid, g.guids)));
  }
}

export async function pruneEntries(db: Db, cfg?: SourceConfig): Promise<number> {
  const keepPerFeed = cfg?.keepPerFeed ?? KEEP_PER_FEED;
  const keepDays = cfg?.keepDays ?? DEFAULT_KEEP_DAYS;
  let pruned = 0;

  if (keepPerFeed > 0) {
    const res = await db.execute(sql`
      delete from entries where id in (
        select id from (
          select id, row_number() over (
            partition by feed_id order by published_at desc nulls last, id desc
          ) as rn
          from entries where is_favorite = false
        ) x where x.rn > ${keepPerFeed}
      )
    `);
    pruned += res.rowCount ?? 0;
  }

  if (keepDays > 0) {
    const res = await db.execute(sql`
      delete from entries
       where is_favorite = false
         and published_at is not null
         and published_at < now() - make_interval(days => ${Math.floor(keepDays)})
    `);
    pruned += res.rowCount ?? 0;
  }

  return pruned;
}
