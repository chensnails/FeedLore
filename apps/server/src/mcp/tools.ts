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
 *
 * ⚠️ 两条「稳定性铁律」（2026-11-08 实测踩过的坑，别改回去）：
 * 1. **入参必须宽容**：LLM / Shell 拼出来的参数常把数字、布尔写成字符串，而
 *    `toCard` 输出的 id 本来就是字符串。严格 zod 会在 SDK 内部抛
 *    `Input validation error: ...` —— 那是 **HTTP 200 + isError:true + 英文纯文本**，
 *    不是 JSON。客户端 `JSON.parse` 失败后很容易当成「查到 0 条」，看起来
 *    就像「list 接口时好时坏」。这里统一做安全归一化 + `.catch()` 兜底，
 *    保证请求一定进入 handler，由 handler 返回结构化结果。
 * 2. **失败必须结构化**：DB 异常 / 参数不合法一律返回 JSON 文本 + isError，
 *    绝不把异常抛给 SDK 变成纯文本。这样「真的 0 条」和「调用失败」永远可区分。
 */

import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
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

function textResult(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

/** 失败也是 JSON：客户端解析不会炸，也不会把错误误读成空数据。 */
export function errorResult(error: string, message: string, extra: Record<string, unknown> = {}): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error, message, ...extra }) }],
  };
}

/** 所有 handler 的统一外壳：DB / 协议层异常一律转成结构化错误。 */
async function guard(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult('E_MCP_TOOL_FAILED', message);
  }
}

/* ---------------- 宽容入参 ----------------
 * z.coerce.number() 对数字字符串是安全的；**布尔绝不能**用 z.coerce.boolean()，
 * 因为 Boolean("false") === true —— 那会把「只看未读」变成「不过滤」。
 * `.catch()` 让畸形值落到默认值，校验层不再有机会抛纯文本错误。
 */
const TRUE_WORDS = new Set(['true', '1', 'yes', 'y', 'on']);
const FALSE_WORDS = new Set(['false', '0', 'no', 'n', 'off', '']);

export function looseNumber(v: unknown): unknown {
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : v;
  }
  return v;
}

export function looseBoolean(v: unknown): unknown {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (TRUE_WORDS.has(s)) return true;
    if (FALSE_WORDS.has(s)) return false;
  }
  return v;
}

export const looseInt = (min: number, max: number, fallback: number) =>
  z.preprocess(looseNumber, z.number().int().min(min).max(max)).catch(fallback);
export const looseBool = z.preprocess(looseBoolean, z.boolean()).catch(false);
/** id 非法时落到 0，handler 里给结构化 E_MCP_BAD_ARGUMENTS（而不是 SDK 的纯文本报错）。 */
export const looseId = z.preprocess(looseNumber, z.number().int().positive()).catch(0);

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
  /** 每次响应都带上账号：空结果时一眼分清「这个账号真没数据」还是「连错账号」。 */
  const who = { account: user.username, scope: user.scope };

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
    async () => guard(async () => {
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
        ...who,
        feedCount: rows.length,
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
    }),
  );

  /* ---------------- feedlore_list_entries ---------------- */
  const listInput = z.object({
    feeds: z.string().optional().catch(undefined)
      .describe('频道 id 列表，逗号分隔（如 "3,17"）；来自 feedlore_list_feeds。不传 = 按scope决定'),
    q: z.string().max(100).optional().catch(undefined).describe('关键词：匹配标题、摘要、正文与标签'),
    tag: z.string().max(60).optional().catch(undefined).describe('按标签精确过滤'),
    unread: looseBool.optional().describe('只看未读；接受 true/false 或 "true"/"false"/"1"/"0"'),
    fav: looseBool.optional().describe('只看收藏（按收藏时间倒序）'),
    watch: z.enum(['watch', 'block']).optional().catch(undefined),
    scope: z.enum(['all', 'cards']).optional().catch(undefined)
      .describe('all = 全部频道（默认）；cards = 仅开启卡片页的频道'),
    sort: z.enum(['new', 'old', 'name']).optional().catch(undefined).describe('默认 new（发布时间倒序）'),
    offset: looseInt(0, 100_000, 0).optional(),
    limit: looseInt(1, 50, 20).optional()
      .describe('每页条数，默认 20，硬上限 50（控制上下文体积）；接受数字字符串'),
  });
  server.registerTool(
    'feedlore_list_entries',
    {
      title: '文章列表',
      description:
        '按频道 / 关键词 / 未读 / 收藏等条件查询文章列表（不含正文，只含标题与摘要）。' +
        '拿到条目 id 后用 feedlore_get_entry 读全文（id 是字符串，直接传即可）。' +
        '响应带 diagnostics：account、returned、total、emptyReason，空结果可据此判断原因。',
      inputSchema: listInput,
      annotations: { readOnlyHint: true },
    },
    async (args) => guard(async () => {
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
        return textResult({
          ...who, entries: [], hasMore: false, total: 0, offset, limit,
          diagnostics: { returned: 0, emptyReason: 'feed_ids_empty', hint: 'feeds 参数没解析出有效 id' },
        });
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
      const total = countRows[0]?.n ?? 0;

      // 空结果时多查一次频道数，把「连错账号 / 条件没命中 / offset 越界」分开说清楚
      let emptyReason: string | null = null;
      if (page.length === 0) {
        const [f] = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(feeds)
          .where(eq(feeds.ownerId, uid));
        emptyReason = (f?.n ?? 0) === 0
          ? 'account_has_no_feeds'
          : total === 0 ? 'no_match' : 'offset_beyond_total';
      }

      return textResult({
        ...who,
        entries: page.map(toCard),
        hasMore,
        total,
        offset,
        limit,
        diagnostics: { returned: page.length, total, emptyReason, query: args.q ?? null, scope },
      });
    }),
  );

  /* ---------------- feedlore_get_entry ---------------- */
  server.registerTool(
    'feedlore_get_entry',
    {
      title: '文章全文',
      description:
        '按 id 读取单篇文章的全文（超过 24000 字符会截断并标注 truncated）。' +
        'id 来自 feedlore_list_entries，是字符串，数字或数字字符串都接受。',
      inputSchema: z.object({
        id: looseId.describe('条目 id（feedlore_list_entries 返回的字符串，也接受数字）'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => guard(async () => {
      if (!id) {
        return errorResult('E_MCP_BAD_ARGUMENTS', 'id 必须是正整数（可传数字字符串）');
      }
      const rows = await db
        .select({ ...CARD_COLUMNS, content: entriesTable.content })
        .from(entriesTable)
        .innerJoin(feeds, eq(feeds.id, entriesTable.feedId))
        // owner 与 id 同进 WHERE：id 猜对了也读不到别人的条目
        .where(and(eq(entriesTable.id, id), eq(feeds.ownerId, uid)))
        .limit(1);
      const row = rows[0];
      if (!row) return errorResult('E_ENTRY_NOT_FOUND', `条目 ${id} 不存在或不属于当前账号`, { ...who });

      const card = toCard(row);
      const cut = truncateContent(row.content ?? '');
      return textResult({
        ...who,
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
    }),
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
    async () => guard(async () => {
      const dates = await listDigestDates(db, uid);
      return textResult({ ...who, dates, count: dates.length });
    }),
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
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().catch(undefined).describe('YYYY-MM-DD'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ date }) => guard(async () => {
      const d = date ?? shanghaiDate();
      const digest = await readDigest(db, uid, d);
      if (!digest) return textResult({ ...who, date: d, digest: null });
      const raw = JSON.stringify(digest);
      if (raw.length <= DIGEST_MAX_CHARS) return textResult({ ...who, date: d, digest });

      // 兜底截断：日报本身受生成参数约束，正常远小于此；真超了就把 sections 砍尾
      const trimmed = { ...digest, sections: digest.sections.slice(0, Math.max(1, Math.floor(digest.sections.length / 2))) };
      return textResult({ ...who, date: d, digest: trimmed, truncated: true });
    }),
  );

  return server;
}
