/**
 * GET /api/feeds —— 契约：contract.feeds.list（auth: user）
 *
 * 数据来源全部走 packages/db（Drizzle），响应经 contract 的 feedsListResponse
 * 运行时校验后才下发：字段/类型写错会在服务端日志里显式报出，而不是悄悄漏给前端。
 */

import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { schema, type Db } from '@feedlore/db';
import { feeds as feedsSpec, feedsListResponse } from '@feedlore/contract';
import { assertResponse } from '../lib/validate';
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

export function feedsRoutes(db: Db | null): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get(feedsSpec.list.path, requireAuth('user'), async (c) => {
    if (!db) return c.json({ error: '数据库未就绪' }, 503);

    const rows = await db
      .select()
      .from(schema.feeds)
      .orderBy(schema.feeds.sortOrder, schema.feeds.id);

    const aggRes = await db.execute(sql`
      select count(*)::int as total,
             count(*) filter (where is_read = false)::int as unread,
             count(*) filter (where is_favorite = true)::int as favorite
      from entries
    `);
    const agg = (aggRes.rows as unknown as AggRow[])[0] ?? { total: 0, unread: 0, favorite: 0 };

    const perRes = await db.execute(sql`
      select feed_id,
             count(*)::int as total,
             count(*) filter (where is_read = false)::int as unread
      from entries group by feed_id
    `);
    const per = new Map((perRes.rows as unknown as PerFeedRow[]).map((r) => [r.feed_id, r]));

    const gRes = await db.execute(sql`
      select distinct group_name from feeds
      where group_name is not null and group_name <> ''
      order by group_name
    `);
    const groups = (gRes.rows as unknown as { group_name: string }[]).map((r) => r.group_name);

    const feedsMapped = rows.map((r) => {
      const p = per.get(r.id);
      return {
        id: String(r.id), // 契约：ID 以数字字符串下发
        url: r.url,
        title: r.title ?? r.url,
        customTitle: r.customTitle ?? null,
        siteUrl: r.siteUrl ?? null,
        description: r.description ?? '',
        icon: r.iconUrl ?? null, // 契约字段名 icon ← 列 icon_url
        enabled: r.enabled,
        cardEnabled: r.cardEnabled,
        groupName: r.groupName ?? '',
        sortOrder: r.sortOrder,
        entryCount: p?.total ?? 0,
        unreadCount: p?.unread ?? 0,
        refreshMinutes: r.refreshMinutes ?? null,
        effectiveRefreshMinutes: r.refreshMinutes ?? DEFAULT_REFRESH_MINUTES,
        nextRefreshAt: null, // TODO(P4)：接入调度器后按 last_fetched_at + 频率计算
        status: r.lastStatus ?? null,
        error: r.lastError ?? null,
        lastFetchedAt: r.lastFetchedAt ? r.lastFetchedAt.toISOString() : null,
        failStreak: r.failStreak,
      };
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
        lastRefreshAt: null, // TODO(P4)
        nextRefreshAt: null, // TODO(P4)
        refreshMinutes: DEFAULT_REFRESH_MINUTES,
        keepDays: DEFAULT_KEEP_DAYS,
        autoRefreshMinutes: DEFAULT_REFRESH_MINUTES,
      },
      'GET /api/feeds',
    );

    return c.json(payload);
  });

  return app;
}
