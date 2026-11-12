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
import { zValidator } from '@hono/zod-validator';
import { and, asc, desc, eq, gt, inArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { feeds, entries as entriesTable, users, type Db } from '@feedlore/db';
import type { AuthInstance } from '@feedlore/auth';
import {
  entries as entriesSpec,
  entriesQuery,
  entriesListResponse,
  entryFlagPatchBody,
  readAllBody,
  readAllUndoBody,
  EntryDetailSchema,
  EntryFlagsSchema,
} from '@feedlore/contract';
import { apiError, ApiException } from '../lib/apiError';
import { assertResponse, BadRequest } from '../lib/validate';
import { toCard, toEntryDetail } from '../lib/dto';
import { classify } from '../lib/watch';
import { scopeAllows } from '../lib/scope';
import { userWatchRules, type PrefsBag } from '../lib/prefs';
import { requireAuth, type AppEnv } from '../middleware/auth';
import { CARD_COLUMNS, entryConditions, parseFeedIds } from '../lib/entriesQuery';

type Query = z.infer<typeof entriesQuery>;
type FlagPatch = z.infer<typeof entryFlagPatchBody>;
type ReadAll = z.infer<typeof readAllBody>;
type ReadAllUndo = z.infer<typeof readAllUndoBody>;

const idParam = z.object({ id: z.coerce.number().int().positive() });

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
        if (!db) return apiError(c, 'E_DB_NOT_READY');

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

        /* 收藏视图按「收藏时刻」倒序；其余按发布时间。
         *
         * `sort=name` 按标题升序。⚠️ 与 legacy 的 `localeCompare(a,b,'zh')` **不完全等价**：
         * 那边是浏览器里的拼音序，这里只能拿到数据库的码点序（PG 容器默认 collation 不带
         * zh-ICU）。为什么不在前端排：列表是**服务端分页**的，前端只能排当前这一页 ——
         * 「第一页内部有序、翻页后整体乱序」比码点序难看得多。 */
        const order =
          q.fav === '1'
            ? [sql`${entriesTable.favoritedAt} desc nulls last`, desc(entriesTable.id)]
            : q.sort === 'old'
              ? [sql`${entriesTable.publishedAt} asc nulls last`, asc(entriesTable.id)]
              : q.sort === 'name'
                ? [sql`lower(${entriesTable.title}) asc`, asc(entriesTable.id)]
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
      if (!db) return apiError(c, 'E_DB_NOT_READY');

      const uid = c.get('user').id;
      const rows = await db
        .select({
          total: sql<number>`count(*)::int`,
          unread: sql<number>`count(*) filter (where ${entriesTable.isRead} = false)::int`,
          favorite: sql<number>`count(*) filter (where ${entriesTable.isFavorite} = true)::int`,
          watching: sql<number>`count(*) filter (where ${entriesTable.watchState} = 'watch')::int`,
          blocked: sql<number>`count(*) filter (where ${entriesTable.watchState} = 'block')::int`,
        })
        .from(entriesTable)
        .innerJoin(feeds, eq(feeds.id, entriesTable.feedId))
        .where(eq(feeds.ownerId, uid));

      const row = rows[0] ?? { total: 0, unread: 0, favorite: 0, watching: 0, blocked: 0 };
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
        if (!db) return apiError(c, 'E_DB_NOT_READY');

        const uid = c.get('user').id;
        const body: ReadAll = c.req.valid('json');
        const feedIds = body.feeds ?? null;
        /* 批次时间戳：所有行写同一个值，撤销据此精确命中这一批（不用把几万个
         * id 拉回内存，也不依赖「几秒内没人再读」这种概率假设）。 */
        const at = new Date();

        if (feedIds !== null && feedIds.length === 0) {
          return c.json({ ok: true, updated: 0, undo: { at: at.toISOString() } });
        }

        const conds = [
          ...entryConditions(db, uid, {
            feedIds,
            q: body.q,
            tag: body.tag,
            watch: body.watch,
            fav: body.fav === '1',
            unread: true, // 只标未读的：已是已读的不该刷新 read_at
          }),
        ];

        // 用原始 SQL 拿 rowCount：drizzle 的 .returning() 会把几万个 id 全部拉回内存，
        // 而「标了多少条」只需要一个数字。
        /* ⚠️ UPDATE 这里**不能给表起别名**：entryConditions 生成的列引用是
         * `"entries"."feed_id"`（drizzle 按表名限定），一旦写成 `update entries e`
         * 就变成「引用不存在的 FROM 项」，整个语句 500。 */
        const res = await db.execute(sql`
          update entries set is_read = true, read_at = ${at}
           where ${sql.join(conds, sql` and `)} and entries.is_read = false
        `);
        const updated = Number((res as unknown as { rowCount?: number | null }).rowCount ?? 0);
        return c.json({ ok: true, updated, undo: { at: at.toISOString() } });
      },
    )

    /* ---------------- POST /api/entries/read-all/undo ----------------
     * 撤销一次批量已读：条件与那次 read-all 完全一致，外加
     * 「read_at 恰好等于该批次时间戳」。之后单独标为已读的条目不会被误伤。 */
    .post(
      entriesSpec.readAllUndo.path,
      requireAuth(auth, 'user'),
      zValidator('json', readAllUndoBody, (result) => {
        if (!result.success) throw new BadRequest('POST /api/entries/read-all/undo', result.error.issues);
      }),
      async (c) => {
        if (!db) return apiError(c, 'E_DB_NOT_READY');

        const uid = c.get('user').id;
        const body: ReadAllUndo = c.req.valid('json');
        const at = new Date(body.at);
        if (Number.isNaN(at.getTime())) {
          throw new BadRequest('POST /api/entries/read-all/undo', [{ path: 'at', message: 'Invalid batch timestamp' }]);
        }

        const feedIds = body.feeds ?? null;
        if (feedIds !== null && feedIds.length === 0) {
          return c.json({ ok: true, reverted: 0 });
        }

        const conds = entryConditions(db, uid, {
          feedIds,
          q: body.q,
          tag: body.tag,
          watch: body.watch,
          fav: body.fav === '1',
        });
        const res = await db.execute(sql`
          update entries set is_read = false, read_at = null
           where ${sql.join(conds, sql` and `)}
             and entries.is_read = true
             and entries.read_at = ${at}
        `);
        const reverted = Number((res as unknown as { rowCount?: number | null }).rowCount ?? 0);
        return c.json({ ok: true, reverted });
      },
    )

    /* ---------------- POST /api/watch/apply ----------------
     * 改完关注/屏蔽规则后回溯已有条目。
     *
     * 为什么必须有这个端点：抓取器只对**新入库**的条目打标（老条目上一轮判过了）。
     * 于是「我明明加了屏蔽，旧条目还在墙上」是必然的，用户唯一的自救是删库重抓 ——
     * legacy 为此专门做了这一步，v2 不能省。
     *
     * 三步照搬 legacy 语义（顺序不能换）：
     * 1. **先清空**该用户全部标记。规则可能被删掉/改名，不清就会留下「指向已不存在规则」的
     *    标记；清空后下面的遍历范围天然是「全部条目」。
     * 2. 规则非空时按键集分页（`id > afterId`，不用 OFFSET）遍历并 classify。
     *    用 OFFSET 在几万条上越翻越慢，且期间若有新条目插入会漏判/重判。
     * 3. 按 (state, rule) 归组更新，一组一条 UPDATE。
     *
     * 复用 `classify()` 而不是另写一份 SQL 匹配：匹配规则一旦有两份实现，
     * 「新条目」和「重算」迟早判得不一样，而这种不一致极难被发现。
     */
    .post(entriesSpec.watchApply.path, requireAuth(auth, 'write'), async (c) => {
      if (!db) return apiError(c, 'E_DB_NOT_READY');

      const uid = c.get('user').id;

      const [userRow] = await db.select({ prefs: users.prefs }).from(users).where(eq(users.id, uid)).limit(1);
      const rules = userWatchRules((userRow?.prefs ?? {}) as PrefsBag);

      /* UPDATE 里不能给表起别名（见 read-all 的注释）；子查询做 owner 隔离，
       * 因为 entries 表本身没有 owner 列 —— 条件里必须落到 feeds.owner_id。 */
      const clearedRes = await db.execute(sql`
        update entries set watch_state = null, watch_rule = null, watch_tagged_at = null
         where (watch_state is not null or watch_rule is not null)
           and feed_id in (select id from feeds where owner_id = ${uid})
      `);
      const cleared = Number((clearedRes as unknown as { rowCount?: number | null }).rowCount ?? 0);

      if (!rules.length) {
        // 规则全删了：清空本身就是结果，不需要再遍历
        return c.json({ ok: true, cleared, tagged: 0, watching: 0, blocked: 0 });
      }

      const PAGE = 500;
      /** 防御性上限：20 万条 = 400 页，够用且不会让请求无限跑 */
      const MAX_PAGES = 400;
      let afterId = 0;
      let tagged = 0;
      let watching = 0;
      let blocked = 0;

      for (let page = 0; page < MAX_PAGES; page += 1) {
        const rows = await db
          .select({
            id: entriesTable.id,
            feedId: entriesTable.feedId,
            groupName: feeds.groupName,
            title: entriesTable.title,
            description: entriesTable.description,
            content: entriesTable.content,
          })
          .from(entriesTable)
          .innerJoin(feeds, eq(feeds.id, entriesTable.feedId))
          .where(and(eq(feeds.ownerId, uid), gt(entriesTable.id, afterId)))
          .orderBy(asc(entriesTable.id))
          .limit(PAGE);

        if (!rows.length) break;
        const last = rows[rows.length - 1];
        if (!last) break;
        afterId = last.id;

        /* 规则范围按 feed 收窄后再判定：同一页里不同频道可能适用不同规则。
         * 空选（all=false 且两个列表都空）的规则不覆盖任何频道，自然也不会打标。 */
        const byFeed = new Map<number, typeof rows>();
        for (const row of rows) {
          const list = byFeed.get(row.feedId);
          if (list) list.push(row);
          else byFeed.set(row.feedId, [row]);
        }

        const verdicts: ReturnType<typeof classify> = [];
        for (const [feedId, group] of byFeed) {
          const first = group[0]!;
          const scoped = rules.filter((r) => scopeAllows(r.scope, { id: feedId, groupName: first.groupName }));
          if (!scoped.length) continue;
          // guid 只是 classify 的身份载体：这里用 id 的字符串形式，回写时再映射回真 id。
          verdicts.push(...classify(
            scoped,
            group.map((r) => ({ guid: String(r.id), title: r.title, description: r.description, content: r.content })),
          ));
        }
        if (!verdicts.length) continue;

        const groups = new Map<string, { state: string; rule: string; ids: number[] }>();
        for (const v of verdicts) {
          const key = `${v.state}\u0000${v.rule}`;
          const g = groups.get(key) ?? { state: v.state, rule: v.rule, ids: [] };
          g.ids.push(Number(v.guid));
          groups.set(key, g);
        }

        for (const g of groups.values()) {
          await db
            .update(entriesTable)
            .set({ watchState: g.state, watchRule: g.rule, watchTaggedAt: new Date() })
            .where(
              and(
                inArray(entriesTable.id, g.ids),
                sql`${entriesTable.feedId} in (select id from feeds where owner_id = ${uid})`,
              ),
            );
          tagged += g.ids.length;
          if (g.state === 'watch') watching += g.ids.length;
          else blocked += g.ids.length;
        }
      }

      return c.json(assertResponse(
        entriesSpec.watchApply.response,
        { ok: true, cleared, tagged, watching, blocked },
        'POST /api/watch/apply',
      ));
    })

    /* ---------------- GET /api/entries/:id ---------------- */
    .get(
      entriesSpec.detail.path,
      requireAuth(auth, 'user'),
      zValidator('param', idParam, (result) => {
        if (!result.success) throw new BadRequest('GET /api/entries/:id', result.error.issues);
      }),
      async (c) => {
        if (!db) return apiError(c, 'E_DB_NOT_READY');

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
        if (!row) return apiError(c, 'E_ENTRY_NOT_FOUND');

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
        if (!db) return apiError(c, 'E_DB_NOT_READY');

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
          throw new ApiException('E_NO_FLAGS_TO_UPDATE');
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
        if (!row) return apiError(c, 'E_ENTRY_NOT_FOUND');

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
