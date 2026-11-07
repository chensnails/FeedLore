/**
 * MCP 工具注册表（P1：全部只读）。
 *
 * 原则：
 * - 入参 schema 在这里用 zod 现写（面向 AI 的形态：布尔代替 '1'、limit 上限 50），
 *   但**查询语义**全部复用 `lib/entriesQuery.ts` 与 `@feedlore/ai` 的既有实现，
 *   不另写一份筛选逻辑 —— 否则 MCP 与 HTTP 接口会悄悄漂移。
 * - 返回 text JSON（`enableJsonResponse` 的无状态服务 + AI 客户端消费的最稳形态）；
 *   structuredContent 留给需要 UI 呈现的 P2。
 * - 每个工具都带 `readOnlyHint`；写工具（flags / read-all）是 P2，且要求 token
 *   scope=write（届时在 handler 里查 `user.scope`）。
 */

import { McpServer } from '@modelcontextprotocol/server';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { entries as entriesTable, feeds, type Db } from '@feedlore/db';
import { shanghaiDate, listDigestDates, readDigest } from '@feedlore/ai';
import { APP_VERSION } from '../env';
import { toCard } from '../lib/dto';
import { CARD_COLUMNS, entryConditions, parseFeedIds } from '../lib/entriesQuery';
import type { McpUser } from '../middleware/mcpAuth';

/** 单篇正文给 AI 的上限：超出截断并标注，模型需要更多时可以分段检索关键词。 */
export const MCP_CONTENT_MAX_CHARS = 24_000;

/** 日报原文的上限（generatedAt 等元数据之外的实际内容部分）。 */
const DIGEST_MAX_CHARS = 40_000;

function textResult(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

/** 正文超长截断：返回截断后的文本与标记，调用方直接塞进响应。 */
export function truncateContent(
  content: string,
  max: number = MCP_CONTENT_MAX_CHARS,
): { content: string; truncated: boolean; totalChars: number } {
  if (content.length <= max) return { content, truncated: false, totalChars: content.length };
  return { content: content.slice(0, max), truncated: true, totalChars: content.length };
}

export function buildMcpServer(db: Db, user: McpUser): McpServer {
  const server = new McpServer({ name: 'feedlore', version: APP_VERSION });
  const uid = user.id;

  /* ---------------- feedlore_list_feeds ---------------- */
  server.registerTool(
    'feedlore_list_feeds',
    {
      title: '订阅频道列表',
      description:
        '列出当前账号的全部 RSS 订阅频道：分组、未读数、总条数。' +
        '想按频道查文章时，先调它拿到 feedId，再传给 feedlore_list_entries。',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const rows = await db
        .select({
          id: feeds.id,
          url: feeds.url,
          siteUrl: feeds.siteUrl,
          title: feeds.title,
          customTitle: feeds.customTitle,
          groupName: feeds.groupName,
          enabled: feeds.enabled,
          cardEnabled: feeds.cardEnabled,
        })
        .from(feeds)
        .where(eq(feeds.ownerId, uid))
        .orderBy(feeds.sortOrder, feeds.id);

      const perRes = await db.execute(sql`
        select e.feed_id,
               count(*)::int as total,
               count(*) filter (where e.is_read = false)::int as unread
        from entries e join feeds f on f.id = e.feed_id
        where f.owner_id = ${uid}
        group by e.feed_id
      `);
      const per = new Map(
        (perRes.rows as unknown as { feed_id: number; total: number; unread: number }[]).map(
          (r) => [r.feed_id, r],
        ),
      );
      const groups = [...new Set(rows.map((r) => r.groupName).filter((g): g is string => !!g))];

      const payload = {
        feeds: rows.map((r) => {
          const p = per.get(r.id);
          return {
            id: r.id,
            title: r.customTitle || r.title || r.url,
            url: r.url,
            siteUrl: r.siteUrl ?? null,
            group: r.groupName ?? null,
            enabled: r.enabled,
            cardEnabled: r.cardEnabled,
            total: p?.total ?? 0,
            unread: p?.unread ?? 0,
          };
        }),
        groups,
      };
      return textResult(payload);
    },
  );

  /* ---------------- feedlore_list_entries ---------------- */
  const listInput = z.object({
    feeds: z.string().optional()
      .describe('频道 id 列表，逗号分隔（如 "3,17"）；来自 feedlore_list_feeds。不传 = 按scope决定'),
    q: z.string().max(100).optional().describe('关键词：匹配标题、摘要、正文与标签'),
    tag: z.string().max(60).optional().describe('按标签精确过滤'),
    unread: z.boolean().optional().describe('true = 只看未读'),
    fav: z.boolean().optional().describe('true = 只看收藏（按收藏时间倒序）'),
    watch: z.enum(['watch', 'block']).optional(),
    scope: z.enum(['all', 'cards']).optional()
      .describe('all = 全部频道（默认）；cards = 仅开启卡片页的频道'),
    sort: z.enum(['new', 'old', 'name']).optional().describe('默认 new（发布时间倒序）'),
    offset: z.number().int().min(0).max(100_000).optional(),
    limit: z.number().int().min(1).max(50).optional()
      .describe('每页条数，默认 20，硬上限 50（控制上下文体积）'),
  });
  server.registerTool(
    'feedlore_list_entries',
    {
      title: '文章列表',
      description:
        '按频道 / 关键词 / 未读 / 收藏等条件查询文章列表（不含正文，只含标题与摘要）。' +
        '拿到条目 id 后用 feedlore_get_entry 读全文。',
      inputSchema: listInput,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const limit = args.limit ?? 20;
      const offset = args.offset ?? 0;
      // MCP 默认 all：AI 的诉求是「读全部订阅」，cards 口径（只看卡片页开关）反而会静默漏频道
      const scope = args.scope ?? 'all';

      let feedIds = args.feeds !== undefined ? parseFeedIds(args.feeds) : null;
      if (feedIds === null && scope === 'cards') {
        const rows = await db
          .select({ id: feeds.id })
          .from(feeds)
          .where(and(eq(feeds.ownerId, uid), eq(feeds.cardEnabled, true)));
        feedIds = rows.map((r) => r.id);
      }
      if (feedIds !== null && feedIds.length === 0) {
        return textResult({ entries: [], hasMore: false, total: 0, offset, limit });
      }

      const where = and(
        ...entryConditions(db, uid, {
          feedIds,
          q: args.q,
          tag: args.tag,
          watch: args.watch,
          unread: args.unread === true,
          fav: args.fav === true,
        }),
      );

      const order =
        args.fav === true
          ? [sql`${entriesTable.favoritedAt} desc nulls last`, desc(entriesTable.id)]
          : args.sort === 'old'
            ? [sql`${entriesTable.publishedAt} asc nulls last`, sql`${entriesTable.id} asc`]
            : args.sort === 'name'
              ? [sql`lower(${entriesTable.title}) asc`, sql`${entriesTable.id} asc`]
              : [sql`${entriesTable.publishedAt} desc nulls last`, desc(entriesTable.id)];

      const [rows, countRows] = await Promise.all([
        db
          .select(CARD_COLUMNS)
          .from(entriesTable)
          .innerJoin(feeds, eq(feeds.id, entriesTable.feedId))
          .where(where)
          .orderBy(...order)
          .limit(limit + 1)
          .offset(offset),
        db
          .select({ n: sql<number>`count(*)::int` })
          .from(entriesTable)
          .innerJoin(feeds, eq(feeds.id, entriesTable.feedId))
          .where(where),
      ]);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      return textResult({
        entries: page.map(toCard),
        hasMore,
        total: countRows[0]?.n ?? 0,
        offset,
        limit,
      });
    },
  );

  /* ---------------- feedlore_get_entry ---------------- */
  server.registerTool(
    'feedlore_get_entry',
    {
      title: '文章全文',
      description:
        '按 id 读取单篇文章的全文（超过 24000 字符会截断并标注 truncated）。' +
        'id 来自 feedlore_list_entries。',
      inputSchema: z.object({ id: z.number().int().positive() }),
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const rows = await db
        .select({ ...CARD_COLUMNS, content: entriesTable.content })
        .from(entriesTable)
        .innerJoin(feeds, eq(feeds.id, entriesTable.feedId))
        // owner 与 id 同进 WHERE：id 猜对了也读不到别人的条目
        .where(and(eq(entriesTable.id, id), eq(feeds.ownerId, uid)))
        .limit(1);
      const row = rows[0];
      if (!row) return textResult({ error: 'E_ENTRY_NOT_FOUND' });

      const card = toCard(row);
      const cut = truncateContent(row.content ?? '');
      return textResult({
        id: card.id,
        title: card.name,
        feedName: card.feedName,
        date: card.date,
        link: card.link,
        sourceUrl: card.sourceUrl,
        tags: card.tags,
        isRead: card.isRead,
        isFavorite: card.isFavorite,
        description: card.desc,
        content: cut.content,
        truncated: cut.truncated,
        totalChars: cut.totalChars,
      });
    },
  );

  /* ---------------- feedlore_list_digests ---------------- */
  server.registerTool(
    'feedlore_list_digests',
    {
      title: '日报日期列表',
      description: '列出已有 AI 日报的日期（新→旧，最多 120 天）。日期传给 feedlore_get_digest。',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const dates = await listDigestDates(db, uid);
      return textResult({ dates });
    },
  );

  /* ---------------- feedlore_get_digest ---------------- */
  server.registerTool(
    'feedlore_get_digest',
    {
      title: '日报内容',
      description:
        '读取某一天的 AI 日报（总览 + 精选 + 分组摘要）。不传 date 默认今天（上海时区）；' +
        '可用 feedlore_list_digests 查有哪些天。',
      inputSchema: z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ date }) => {
      const d = date ?? shanghaiDate();
      const digest = await readDigest(db, uid, d);
      if (!digest) return textResult({ date: d, digest: null });
      const raw = JSON.stringify(digest);
      if (raw.length <= DIGEST_MAX_CHARS) return textResult({ date: d, digest });

      // 兜底截断：日报本身受生成参数约束，正常远小于此；真超了就把 sections 砍尾
      const trimmed = { ...digest, sections: digest.sections.slice(0, Math.max(1, Math.floor(digest.sections.length / 2))) };
      return textResult({ date: d, digest: trimmed, truncated: true });
    },
  );

  return server;
}
