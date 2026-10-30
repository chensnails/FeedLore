/**
 * 频道接口（契约：contract.feeds.*）
 *
 * 已实现：list / create / patchOne / deleteOne / reorder。
 * **未实现**（等 P5 抓取器）：refresh / refreshOne / import —— 三者都以「真正出网抓一次」为核心，
 * 没有抓取器时只能造假成功。宁可让 hc 的类型里没有这几个方法，也不返回 ok:true 骗前端。
 *
 * 三条硬约束：
 * 1. 一切「让服务器去访问用户给的地址」的入口都要过 `lib/net`：create 的 url、
 *    patch 的 url。少了就是 SSRF。
 * 2. 所有写操作 WHERE 里同时带 id 与 owner_id，没命中一律 404（不先查后写）。
 * 3. 换地址必须清掉条件请求游标（etag / last_modified / last_status / fail_streak），
 *    否则新地址命中旧 ETag 会被判成「无更新」，用户看到的是一个永远空白的频道。
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { zValidator } from '@hono/zod-validator';
import { and, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { feeds, entries as entriesTable, type Db } from '@feedlore/db';
import type { AuthInstance } from '@feedlore/auth';
import {
  feeds as feedsSpec,
  feedsListResponse,
  feedCreateBody,
  feedPatchBody,
  feedReorderBody,
} from '@feedlore/contract';
import { assertResponse, BadRequest } from '../lib/validate';
import { toFeed, type FeedCounts, type FeedRow } from '../lib/dto';
import { assertFeedUrl, assertPublicHost } from '../lib/net';
import { requireAuth, type AppEnv } from '../middleware/auth';
import { DEFAULT_KEEP_DAYS, DEFAULT_REFRESH_MINUTES } from '../env';

interface AggRow {
  total: number;
  unread: number;
  favorite: number;
}
interface PerFeedRow {
  feed_id: number;
  total: number;
  unread: number;
}

const idParam = z.object({ id: z.coerce.number().int().positive() });

type FeedPatch = z.infer<typeof feedPatchBody>;
type FeedCreate = z.infer<typeof feedCreateBody>;
type FeedReorder = z.infer<typeof feedReorderBody>;

/** 抓取频率：空 / 0 / 'global' 都表示「跟随全局」→ NULL；正数夹到 5~1440 分钟。 */
function normalizeRefreshMinutes(raw: FeedPatch['refreshMinutes']): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'string') return null; // 'global'
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(1440, Math.max(5, Math.trunc(n)));
}

/** 单频道及其计数（create / patch 的响应都要回完整 Feed）。 */
async function readFeed(
  db: Db,
  uid: string,
  id: number,
  globalRefreshMinutes: number,
): Promise<{ row: FeedRow; counts: FeedCounts } | null> {
  const [row] = await db
    .select()
    .from(feeds)
    .where(and(eq(feeds.id, id), eq(feeds.ownerId, uid)))
    .limit(1);
  if (!row) return null;

  const [agg] = await db
    .select({
      total: sql<number>`count(*)::int`,
      unread: sql<number>`count(*) filter (where ${entriesTable.isRead} = false)::int`,
    })
    .from(entriesTable)
    .where(eq(entriesTable.feedId, id));

  return {
    row,
    counts: { entryCount: agg?.total ?? 0, unreadCount: agg?.unread ?? 0 },
  };
}

export function feedsRoutes(db: Db | null, auth: AuthInstance | null) {
  // ⚠️ 链式返回，见 health.ts 注释：非链式会让 hc<AppType> 看不到本路由。
  return (
    new Hono<AppEnv>()
      /* ---------------- GET /api/feeds ---------------- */
      .get(feedsSpec.list.path, requireAuth(auth, 'user'), async (c) => {
        if (!db) return c.json({ error: '数据库未就绪' }, 503);

        // ⚠️ 必须按 owner 过滤：feeds 是多用户表，漏了 owner 就是把所有人的订阅一起返回
        const uid = c.get('user').id;

        const rows = await db
          .select()
          .from(feeds)
          .where(eq(feeds.ownerId, uid))
          .orderBy(feeds.sortOrder, feeds.id);

        const aggRes = await db.execute(sql`
          select count(*)::int as total,
                 count(*) filter (where e.is_read = false)::int as unread,
                 count(*) filter (where e.is_favorite = true)::int as favorite
          from entries e join feeds f on f.id = e.feed_id
          where f.owner_id = ${uid}
        `);
        const agg = (aggRes.rows as unknown as AggRow[])[0] ?? { total: 0, unread: 0, favorite: 0 };

        const perRes = await db.execute(sql`
          select e.feed_id,
                 count(*)::int as total,
                 count(*) filter (where e.is_read = false)::int as unread
          from entries e join feeds f on f.id = e.feed_id
          where f.owner_id = ${uid}
          group by e.feed_id
        `);
        const per = new Map((perRes.rows as unknown as PerFeedRow[]).map((r) => [r.feed_id, r]));

        const gRes = await db.execute(sql`
          select distinct group_name from feeds
          where owner_id = ${uid} and group_name is not null and group_name <> ''
          order by group_name
        `);
        const groups = (gRes.rows as unknown as { group_name: string }[]).map((r) => r.group_name);

        const feedsMapped = rows.map((r) => {
          const p = per.get(r.id);
          return toFeed(r, { entryCount: p?.total, unreadCount: p?.unread }, DEFAULT_REFRESH_MINUTES);
        });

        const payload = assertResponse(
          feedsListResponse,
          {
            feeds: feedsMapped,
            total: rows.length,
            enabled: rows.filter((r) => r.enabled).length,
            cardEnabled: rows.filter((r) => r.cardEnabled).length,
            groups,
            groupOrder: groups,
            flags: { total: agg.total, unread: agg.unread, favorite: agg.favorite },
            lastRefreshAt: null, // TODO(P5)：接调度器后由 refresh 快照提供
            nextRefreshAt: null,
            refreshMinutes: DEFAULT_REFRESH_MINUTES,
            keepDays: DEFAULT_KEEP_DAYS,
            autoRefreshMinutes: DEFAULT_REFRESH_MINUTES,
          },
          'GET /api/feeds',
        );

        return c.json(payload);
      })

      /* ---------------- POST /api/feeds ---------------- */
      .post(
        feedsSpec.create.path,
        requireAuth(auth, 'user'),
        zValidator('json', feedCreateBody, (result) => {
          if (!result.success) throw new BadRequest('POST /api/feeds', result.error.issues);
        }),
        async (c) => {
          if (!db) return c.json({ error: '数据库未就绪' }, 503);

          const uid = c.get('user').id;
          const body: FeedCreate = c.req.valid('json');

          // ① 形状校验（协议 / 主机名）② 出网校验（内网 / 回环 / 解析结果）
          const url = assertFeedUrl(body.url);
          await assertPublicHost(url);

          const [dup] = await db
            .select({ id: feeds.id })
            .from(feeds)
            .where(and(eq(feeds.ownerId, uid), eq(feeds.url, url)))
            .limit(1);

          const groupName = body.groupName?.trim().slice(0, 40) || null;

          /* sort_order 用子查询取「本用户最大值 +1」，单语句原子完成；
           * 并发插入撞 (owner_id, url) 唯一索引时走 DO UPDATE，把 existed 语义交给上面的查重。 */
          const [inserted] = await db
            .insert(feeds)
            .values({
              ownerId: uid,
              url,
              enabled: body.enabled !== false,
              cardEnabled: body.cardEnabled !== false,
              groupName,
              sortOrder: sql`coalesce((select max(${feeds.sortOrder}) + 1 from feeds where owner_id = ${uid}), 0)`,
            })
            .onConflictDoUpdate({
              target: [feeds.ownerId, feeds.url],
              set: { updatedAt: sql`now()` },
            })
            .returning({ id: feeds.id });

          if (!inserted) return c.json({ error: '频道创建失败' }, 500);

          const got = await readFeed(db, uid, inserted.id, DEFAULT_REFRESH_MINUTES);
          if (!got) return c.json({ error: '频道创建失败' }, 500);

          /* added 恒为 0：抓取器未接入（P5）。这里**不**假装抓过，
           * 前端据 `status === null && entryCount === 0` 显示「等待首次抓取」。 */
          return c.json(
            assertResponse(
              feedsSpec.create.response,
              {
                ok: true,
                existed: Boolean(dup),
                feed: toFeed(got.row, got.counts, DEFAULT_REFRESH_MINUTES),
                added: 0,
              },
              'POST /api/feeds',
            ),
          );
        },
      )

      /* ---------------- POST /api/feeds/reorder ----------------
       * 批量重排 + 跨组移动：sort_order 是「本用户内」的排序轴。 */
      .post(
        feedsSpec.reorder.path,
        requireAuth(auth, 'user'),
        zValidator('json', feedReorderBody, (result) => {
          if (!result.success) throw new BadRequest('POST /api/feeds/reorder', result.error.issues);
        }),
        async (c) => {
          if (!db) return c.json({ error: '数据库未就绪' }, 503);

          const uid = c.get('user').id;
          const body: FeedReorder = c.req.valid('json');
          const items = body.feeds.slice(0, 2000);
          if (!items.length) return c.json({ ok: true, updated: 0 });

          const rowsSql = sql.join(
            items.map((it) => {
              const id = Number(it.id);
              const so = Number.isFinite(Number(it.sortOrder)) ? Math.trunc(Number(it.sortOrder)) : 0;
              const rawGroup = it.groupName ?? it.group_name;
              const gn = String(rawGroup ?? '').trim().slice(0, 40) || null;
              return sql`(${id}::bigint, ${so}::int, ${gn}::text)`;
            }),
            sql`, `,
          );

          /* 单语句 UPDATE...FROM VALUES：2000 条也只往返一次。
           * owner 条件在 WHERE 里 —— 拿别人的 feed id 来排序会一行都改不到。 */
          await db.execute(sql`
            update feeds as f
               set sort_order = v.so, group_name = v.gn, updated_at = now()
              from (values ${rowsSql}) as v(id, so, gn)
             where f.id = v.id and f.owner_id = ${uid}
          `);

          return c.json({ ok: true, updated: items.length });
        },
      )

      /* ---------------- PATCH /api/feeds/:id ---------------- */
      .patch(
        feedsSpec.patchOne.path,
        requireAuth(auth, 'user'),
        zValidator('param', idParam, (result) => {
          if (!result.success) throw new BadRequest('PATCH /api/feeds/:id', result.error.issues);
        }),
        zValidator('json', feedPatchBody, (result) => {
          if (!result.success) throw new BadRequest('PATCH /api/feeds/:id', result.error.issues);
        }),
        async (c) => {
          if (!db) return c.json({ error: '数据库未就绪' }, 503);

          const uid = c.get('user').id;
          const { id } = c.req.valid('param');
          const body: FeedPatch = c.req.valid('json');

          const [current] = await db
            .select()
            .from(feeds)
            .where(and(eq(feeds.id, id), eq(feeds.ownerId, uid)))
            .limit(1);
          if (!current) return c.json({ error: '频道不存在' }, 404);

          /* 用 Partial<typeof feeds.$inferInsert> 而不是 Record<string, unknown>：
           * 后者能编过任何列名，`groupName` 手滑写成 `groupname` 会在运行期静默不生效。 */
          const set: Partial<typeof feeds.$inferInsert> = {};
          if (body.enabled !== undefined) set.enabled = body.enabled;
          if (body.cardEnabled !== undefined) set.cardEnabled = body.cardEnabled;
          if (body.groupName !== undefined) set.groupName = body.groupName.trim().slice(0, 40) || null;
          // 自定义频道名写 custom_title：抓取刷新只更新 title 字段，不会覆盖用户起的名字
          if (body.title !== undefined) set.customTitle = body.title.trim().slice(0, 200) || null;
          if (body.sortOrder !== undefined) set.sortOrder = Math.trunc(body.sortOrder);
          if (body.refreshMinutes !== undefined) {
            set.refreshMinutes = normalizeRefreshMinutes(body.refreshMinutes);
          }

          let urlChanged = false;
          if (body.url !== undefined) {
            const nextUrl = assertFeedUrl(body.url);
            if (nextUrl !== current.url) {
              await assertPublicHost(nextUrl);
              const [dup] = await db
                .select({ id: feeds.id, customTitle: feeds.customTitle, title: feeds.title })
                .from(feeds)
                .where(and(eq(feeds.ownerId, uid), eq(feeds.url, nextUrl), ne(feeds.id, id)))
                .limit(1);
              if (dup) {
                const name = dup.customTitle || dup.title || nextUrl;
                throw new HTTPException(409, { message: `这个地址已经是你的另一个频道：${name}` });
              }
              set.url = nextUrl;
              urlChanged = true;
              // 换地址 = 新源：旧 ETag / Last-Modified / 失败计数对新地址毫无意义
              set.etag = null;
              set.lastModified = null;
              set.lastStatus = null;
              set.lastError = null;
              set.lastFetchedAt = null;
              set.failStreak = 0;
            }
          }

          // 手动重新打开采集 = 「这个源我想再试一次」，失败计数清零，给足一整轮观察期
          if (set.enabled === true) set.failStreak = 0;

          if (!Object.keys(set).length) {
            const got = await readFeed(db, uid, id, DEFAULT_REFRESH_MINUTES);
            if (!got) return c.json({ error: '频道不存在' }, 404);
            return c.json(
              assertResponse(
                feedsSpec.patchOne.response,
                { ok: true, feed: toFeed(got.row, got.counts, DEFAULT_REFRESH_MINUTES) },
                'PATCH /api/feeds/:id',
              ),
            );
          }

          set.updatedAt = new Date();
          await db
            .update(feeds)
            .set(set)
            .where(and(eq(feeds.id, id), eq(feeds.ownerId, uid)));

          const got = await readFeed(db, uid, id, DEFAULT_REFRESH_MINUTES);
          if (!got) return c.json({ error: '频道不存在' }, 404);

          /* probe：legacy 在换地址后会立刻试抓一次并回报成败。抓取器未接入（P5）时
           * 不回该字段 —— 契约里它是 optional，前端据此显示「已保存，等待抓取」。 */
          return c.json(
            assertResponse(
              feedsSpec.patchOne.response,
              {
                ok: true,
                urlChanged: urlChanged || undefined,
                feed: toFeed(got.row, got.counts, DEFAULT_REFRESH_MINUTES),
              },
              'PATCH /api/feeds/:id',
            ),
          );
        },
      )

      /* ---------------- DELETE /api/feeds/:id ----------------
       * entries 有 onDelete: 'cascade' 外键，条目随频道一起删。 */
      .delete(
        feedsSpec.deleteOne.path,
        requireAuth(auth, 'user'),
        zValidator('param', idParam, (result) => {
          if (!result.success) throw new BadRequest('DELETE /api/feeds/:id', result.error.issues);
        }),
        async (c) => {
          if (!db) return c.json({ error: '数据库未就绪' }, 503);

          const uid = c.get('user').id;
          const { id } = c.req.valid('param');

          const rows = await db
            .delete(feeds)
            .where(and(eq(feeds.id, id), eq(feeds.ownerId, uid)))
            .returning({ id: feeds.id });

          // 删不到就是不存在（或不属于你）—— 统一 404，不泄露「存在但不是你的」
          if (!rows.length) return c.json({ error: '频道不存在' }, 404);
          return c.json({ ok: true });
        },
      )
  );
}
