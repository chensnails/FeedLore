/**
 * 条目接口（契约：contract.entries.*）
 *
 * 五条硬约束写在这里，改动时别绕开：
 * 1. **用户隔离靠 feeds.owner_id**：entries 表本身没有 owner 列，条件里必须带
 *    `feed_id in (select id from feeds where owner_id = ?)`。漏了就是越权读/改别人订阅。
 * 2. 列表**不返回 content**：50 条 × 几千字会把响应撑到几百 KB；正文只在详情接口给。
 * 3. `hasMore` 用「多取一条」判断，不用 count 差——count 只用于展示总数。
 * 4. **列表条件和「全部标为已读」条件是同一个函数**（`entryConditions`）。分开写就会漂移，
 *    典型后果：用户在「屏蔽」视图里点一键已读，把全库都标掉了（legacy v21 专门修过）。
 * 5. 写操作一律「id + owner 同时进 WHERE」，没命中就 404，不先查后写（避免 TOCTOU）。
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { zValidator } from '@hono/zod-validator';
import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { feeds, entries as entriesTable, type Db } from '@feedlore/db';
import type { AuthInstance } from '@feedlore/auth';
import {
  entries as entriesSpec,
  entriesQuery,
  entriesListResponse,
  entryFlagPatchBody,
  readAllBody,
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
type FlagPatch = z.infer<typeof entryFlagPatchBody>;
type ReadAll = z.infer<typeof readAllBody>;

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

/** 筛选条件（列表与「全部已读」共用）。owner 走子查询，因此 UPDATE 也能直接用。 */
interface EntryFilter {
  feedIds: number[] | null;
  q?: string | undefined;
  tag?: string | undefined;
  watch?: 'watch' | 'block' | undefined;
  unread?: boolean;
  fav?: boolean;
}

function entryConditions(db: Db, uid: string, f: EntryFilter): SQL[] {
  const conds: SQL[] = [
    inArray(
      entriesTable.feedId,
      db.select({ id: feeds.id }).from(feeds).where(eq(feeds.ownerId, uid)),
    ),
  ];
  if (f.feedIds !== null) conds.push(inArray(entriesTable.feedId, f.feedIds));
  if (f.tag) conds.push(sql`${f.tag} = any(${entriesTable.tags})`);
  if (f.q) {
    const kw = f.q.trim();
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
  if (f.unread) conds.push(eq(entriesTable.isRead, false));
  if (f.fav) conds.push(eq(entriesTable.isFavorite, true));
  if (f.watch) conds.push(eq(entriesTable.watchState, f.watch));
  return conds;
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

        const where = and(
          ...entryConditions(db, uid, {
            feedIds,
            q: q.q,
            tag: q.tag,
            watch: q.watch,
            unread: q.unread === '1',
            fav: q.fav === '1',
          }),
        );

        // 收藏视图按「收藏时刻」倒序；其余按发布时间
        const order =
          q.fav === '1'
            ? [sql`${entriesTable.favoritedAt} desc nulls last`, desc(entriesTable.id)]
            : q.sort === 'old'
              ? [sql`${entriesTable.publishedAt} asc nulls last`, asc(entriesTable.id)]
              : [sql`${entriesTable.publishedAt} desc nulls last`, desc(entriesTable.id)];

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

    /* ---------------- POST /api/entries/read-all ----------------
     * 条件与列表完全一致，所以「屏幕上看到的」就是「被标掉的」。
     * feeds 不传 = 全部频道；传空数组 = 什么都不标（明确语义，避免误伤全库）。 */
    .post(
      entriesSpec.readAll.path,
      requireAuth(auth, 'user'),
      zValidator('json', readAllBody, (result) => {
        if (!result.success) throw new BadRequest('POST /api/entries/read-all', result.error.issues);
      }),
      async (c) => {
        if (!db) return c.json({ error: '数据库未就绪' }, 503);

        const uid = c.get('user').id;
        const body: ReadAll = c.req.valid('json');
        const feedIds = body.feeds ?? null;

        if (feedIds !== null && feedIds.length === 0) {
          return c.json({ ok: true, updated: 0 });
        }

        const conds = [
          ...entryConditions(db, uid, {
            feedIds,
            q: body.q,
            tag: body.tag,
            watch: body.watch,
            unread: true, // 只标未读的：已是已读的不该刷新 read_at
          }),
        ];

        // 用原始 SQL 拿 rowCount：drizzle 的 .returning() 会把几万个 id 全部拉回内存，
        // 而「标了多少条」只需要一个数字。
        /* ⚠️ UPDATE 这里**不能给表起别名**：entryConditions 生成的列引用是
         * `"entries"."feed_id"`（drizzle 按表名限定），一旦写成 `update entries e`
         * 就变成「引用不存在的 FROM 项」，整个语句 500。 */
        const res = await db.execute(sql`
          update entries set is_read = true, read_at = now()
           where ${sql.join(conds, sql` and `)} and entries.is_read = false
        `);
        const updated = Number((res as unknown as { rowCount?: number | null }).rowCount ?? 0);
        return c.json({ ok: true, updated });
      },
    )

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
    )

    /* ---------------- PATCH /api/entries/:id ----------------
     * 只改传进来的标记，没传的保持原样。时间戳跟着布尔一起写：
     * 标已读记 read_at，取消收藏把 favorited_at 清空（与 legacy setEntryFlags 一致）。 */
    .patch(
      entriesSpec.flagPatch.path,
      requireAuth(auth, 'user'),
      zValidator('param', idParam, (result) => {
        if (!result.success) throw new BadRequest('PATCH /api/entries/:id', result.error.issues);
      }),
      zValidator('json', entryFlagPatchBody, (result) => {
        if (!result.success) throw new BadRequest('PATCH /api/entries/:id', result.error.issues);
      }),
      async (c) => {
        if (!db) return c.json({ error: '数据库未就绪' }, 503);

        const uid = c.get('user').id;
        const { id } = c.req.valid('param');
        const body: FlagPatch = c.req.valid('json');

        const set: {
          isRead?: boolean;
          readAt?: SQL | null;
          isFavorite?: boolean;
          favoritedAt?: SQL | null;
        } = {};
        if (body.isRead !== undefined) {
          set.isRead = body.isRead;
          set.readAt = body.isRead ? sql`now()` : null;
        }
        if (body.isFavorite !== undefined) {
          set.isFavorite = body.isFavorite;
          set.favoritedAt = body.isFavorite ? sql`now()` : null;
        }
        if (!Object.keys(set).length) {
          throw new HTTPException(400, { message: '没有要修改的标记（isRead / isFavorite 至少给一个）' });
        }

        const rows = await db
          .update(entriesTable)
          .set(set)
          .where(
            and(
              eq(entriesTable.id, id),
              inArray(
                entriesTable.feedId,
                db.select({ id: feeds.id }).from(feeds).where(eq(feeds.ownerId, uid)),
              ),
            ),
          )
          .returning({
            id: entriesTable.id,
            isRead: entriesTable.isRead,
            isFavorite: entriesTable.isFavorite,
            favoritedAt: entriesTable.favoritedAt,
          });

        const row = rows[0];
        if (!row) return c.json({ error: '条目不存在' }, 404);

        return c.json(
          assertResponse(
            entriesSpec.flagPatch.response,
            {
              ok: true,
              id: String(row.id),
              isRead: row.isRead,
              isFavorite: row.isFavorite,
              favoritedAt: row.favoritedAt ? row.favoritedAt.toISOString() : null,
            },
            'PATCH /api/entries/:id',
          ),
        );
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
