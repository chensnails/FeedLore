/**
 * 条目读接口（契约：contract.entries.list / detail / flags）
 *
 * 三条硬约束写在这里，改动时别绕开：
 * 1. **用户隔离靠 feeds.owner_id**：entries 表本身没有 owner 列，必须 join feeds
 *    并在 WHERE 里带 owner（legacy 用子查询达到同样效果）。漏了就是越权读别人订阅。
 * 2. 列表**不返回 content**：50 条 × 几千字会把响应撑到几百 KB；正文只在详情接口给。
 * 3. `hasMore` 用「多取一条」判断，不用 count 差——count 只用于展示总数。
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { feeds, entries as entriesTable, type Db } from '@feedlore/db';
import type { AuthInstance } from '@feedlore/auth';
import {
  entries as entriesSpec,
  entriesQuery,
  entriesListResponse,
  EntryDetailSchema,
  EntryFlagsSchema,
} from '@feedlore/contract';
import { assertResponse, BadRequest } from '../lib/validate';
import { toCard, toEntryDetail } from '../lib/dto';
import { requireAuth, type AppEnv } from '../middleware/auth';

/** 条目查询公共列（详情另加 content）。字段名与 CardRow 一一对应。 */
const CARD_COLUMNS = {
  id: entriesTable.id,
  feedId: entriesTable.feedId,
  title: entriesTable.title,
  link: entriesTable.link,
  pwd: entriesTable.pwd,
  description: entriesTable.description,
  size: entriesTable.size,
  tags: entriesTable.tags,
  image: entriesTable.image,
  images: entriesTable.images,
  links: entriesTable.links,
  sourceUrl: entriesTable.sourceUrl,
  publishedAt: entriesTable.publishedAt,
  isRead: entriesTable.isRead,
  isFavorite: entriesTable.isFavorite,
  favoritedAt: entriesTable.favoritedAt,
  bodyJson: entriesTable.bodyJson,
  feedName: feeds.title,
};

type Query = z.infer<typeof entriesQuery>;

const idParam = z.object({ id: z.coerce.number().int().positive() });

/** 解析 `feeds=1,2,3`；返回 null 表示「没传这个参数」。 */
function parseFeedIds(raw: string | undefined): number[] | null {
  if (raw === undefined) return null;
  return raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
    .map((n) => Math.trunc(n));
}

export function entriesRoutes(db: Db | null, auth: AuthInstance | null) {
  return new Hono<AppEnv>()
    /* ---------------- GET /api/entries ---------------- */
    .get(
      entriesSpec.list.path,
      requireAuth(auth, 'user'),
      zValidator('query', entriesQuery, (result) => {
        if (!result.success) throw new BadRequest('GET /api/entries', result.error.issues);
      }),
      async (c) => {
        if (!db) return c.json({ error: '数据库未就绪' }, 503);

        const uid = c.get('user').id;
        const q: Query = c.req.valid('query');

        // 频道范围：显式 feeds 优先；否则按 scope（默认 cards = 只取卡片开关打开的频道）
        let feedIds = parseFeedIds(q.feeds);
        if (feedIds === null && (q.scope ?? 'cards') === 'cards') {
          const rows = await db
            .select({ id: feeds.id })
            .from(feeds)
            .where(and(eq(feeds.ownerId, uid), eq(feeds.cardEnabled, true)));
          feedIds = rows.map((r) => r.id);
        }

        const empty = {
          entries: [],
          hasMore: false,
          total: 0,
          offset: q.offset,
          limit: q.limit,
          tags: [],
        };
        if (feedIds !== null && feedIds.length === 0) {
          // 没有可用频道：直接空页，不用白跑两条聚合
          return c.json(assertResponse(entriesListResponse, empty, 'GET /api/entries'));
        }

        const conds: SQL[] = [eq(feeds.ownerId, uid)];
        if (feedIds !== null) conds.push(inArray(entriesTable.feedId, feedIds));
        if (q.tag) conds.push(sql`${q.tag} = any(${entriesTable.tags})`);
        if (q.q) {
          const kw = q.q.trim();
          if (kw) {
            const pat = `%${kw}%`;
            // 覆盖正文与标签：只搜标题/描述时，正文里的关键词搜不到（legacy v2.6.0 的同款修正）
            conds.push(
              sql`(${entriesTable.title} ilike ${pat}
                or coalesce(${entriesTable.description}, '') ilike ${pat}
                or coalesce(${entriesTable.content}, '') ilike ${pat}
                or exists (select 1 from unnest(${entriesTable.tags}) t where t ilike ${pat}))`,
            );
          }
        }
        if (q.unread === '1') conds.push(eq(entriesTable.isRead, false));
        if (q.fav === '1') conds.push(eq(entriesTable.isFavorite, true));
        if (q.watch) conds.push(eq(entriesTable.watchState, q.watch));

        // 收藏视图按「收藏时刻」倒序；其余按发布时间
        const order =
          q.fav === '1'
            ? [sql`${entriesTable.favoritedAt} desc nulls last`, desc(entriesTable.id)]
            : q.sort === 'old'
              ? [sql`${entriesTable.publishedAt} asc nulls last`, asc(entriesTable.id)]
              : [sql`${entriesTable.publishedAt} desc nulls last`, desc(entriesTable.id)];

        const where = and(...conds);

        const [rows, countRows] = await Promise.all([
          db
            .select(CARD_COLUMNS)
            .from(entriesTable)
            .innerJoin(feeds, eq(feeds.id, entriesTable.feedId))
            .where(where)
            .orderBy(...order)
            .limit(q.limit + 1)
            .offset(q.offset),
          db
            .select({ n: sql<number>`count(*)::int` })
            .from(entriesTable)
            .innerJoin(feeds, eq(feeds.id, entriesTable.feedId))
            .where(where),
        ]);

        const hasMore = rows.length > q.limit;
        const page = hasMore ? rows.slice(0, q.limit) : rows;

        const tagRows = await tagCounts(db, uid, feedIds);

        const payload = assertResponse(
          entriesListResponse,
          {
            entries: page.map(toCard),
            hasMore,
            total: countRows[0]?.n ?? 0,
            offset: q.offset,
            limit: q.limit,
            tags: tagRows,
          },
          'GET /api/entries',
        );
        return c.json(payload);
      },
    )

    /* ---------------- GET /api/entries/flags ---------------- */
    .get(entriesSpec.flags.path, requireAuth(auth, 'user'), async (c) => {
      if (!db) return c.json({ error: '数据库未就绪' }, 503);

      const uid = c.get('user').id;
      const rows = await db
        .select({
          total: sql<number>`count(*)::int`,
          unread: sql<number>`count(*) filter (where ${entriesTable.isRead} = false)::int`,
          favorite: sql<number>`count(*) filter (where ${entriesTable.isFavorite} = true)::int`,
        })
        .from(entriesTable)
        .innerJoin(feeds, eq(feeds.id, entriesTable.feedId))
        .where(eq(feeds.ownerId, uid));

      const row = rows[0] ?? { total: 0, unread: 0, favorite: 0 };
      return c.json(assertResponse(EntryFlagsSchema, row, 'GET /api/entries/flags'));
    })

    /* ---------------- GET /api/entries/:id ---------------- */
    .get(
      entriesSpec.detail.path,
      requireAuth(auth, 'user'),
      zValidator('param', idParam, (result) => {
        if (!result.success) throw new BadRequest('GET /api/entries/:id', result.error.issues);
      }),
      async (c) => {
        if (!db) return c.json({ error: '数据库未就绪' }, 503);

        const uid = c.get('user').id;
        const { id } = c.req.valid('param');

        const rows = await db
          .select({ ...CARD_COLUMNS, content: entriesTable.content })
          .from(entriesTable)
          .innerJoin(feeds, eq(feeds.id, entriesTable.feedId))
          // owner 必须与 id 同时进 WHERE：否则 id 猜对了就能读别人订阅的正文
          .where(and(eq(entriesTable.id, id), eq(feeds.ownerId, uid)))
          .limit(1);

        const row = rows[0];
        if (!row) return c.json({ error: '条目不存在' }, 404);

        return c.json(assertResponse(EntryDetailSchema, toEntryDetail(row), 'GET /api/entries/:id'));
      },
    );
}

/**
 * 标签计数（侧栏标签云）。用原始 SQL：`unnest(tags)` 这类展开在查询构造器里
 * 要写成 cross join lateral，可读性反而更差。
 * feedIds 是我们自己 Number() 过的正整数，直接拼进 SQL 不存在注入面。
 */
async function tagCounts(db: Db, uid: string, feedIds: number[] | null) {
  const feedCond = feedIds === null ? sql`` : sql` and f.id in (${sql.raw(feedIds.join(','))})`;
  const res = await db.execute(sql`
    select t as tag, count(*)::int as n
    from entries e
    join feeds f on f.id = e.feed_id
    cross join lateral unnest(e.tags) as t
    where f.owner_id = ${uid}${feedCond}
    group by t
    order by n desc, t
    limit 80
  `);
  return (res.rows as unknown as Array<{ tag: string; n: number }>).map((r) => ({
    tag: r.tag,
    n: Number(r.n),
  }));
}
