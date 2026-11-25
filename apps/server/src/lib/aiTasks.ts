/**
 * AI 业务执行体（单篇 AI / AI 标签 / 日报）。
 *
 * 为什么单独一层：同一件事现在有两个入口 ——
 * 1) 同步接口（`POST /api/entry/:id/ai` 等，CLI / 脚本 / 旧客户端还在用）；
 * 2) 异步任务（`POST /api/ai/jobs` → 进程内执行，网页走这条）。
 * 两套入口各写一份提示词与截断逻辑必然漂移，所以执行体只此一份，
 * 路由与任务执行器都调它。
 *
 * 约定：**业务失败=抛错**（带 `E_AI_*` 稳定码），由调用方决定怎么呈现 ——
 * 同步路由收敛成 `{ok:false,result}`（降级可读），任务执行器记成 `failed` 状态。
 */

import {
  AI_TAG_PROMPT_VERSION,
  type ChatMessage,
  chat,
  extractJson,
  generateDigest,
  type ResolvedLlm,
  shanghaiDate,
  suggestEntryTags,
} from '@feedlore/ai';
import type { EntryAiBody, ExploreHistory, ExploreResult } from '@feedlore/contract';
import { type Db, entries as entriesTable, entryAiTags, feeds, users } from '@feedlore/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import { recordAiUsage } from './aiUsage';
import { ApiException } from './apiError';
import { resolveDigestScope } from './digest';
import { toCard } from './dto';
import { CARD_COLUMNS, entryConditions } from './entriesQuery';
import { resolveLlmForTask } from './llm';
import { assertPublicHost, safeFetch } from './net';
import { userDigest, userLayout } from './prefs';

/** 真实日期判定：格式对不代表日期存在（`2026-02-30` 也是「格式合法」）。 */
export function isRealDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** 单条目 AI 喂给模型的正文上限：与 MCP 工具保持一致（24000 字符）。 */
const ENTRY_AI_MAX_CHARS = 24_000;
/**
 * 翻译的正文预算。
 *
 * 翻译要逐句对应，正文给不全等于没法用；但 90 秒内模型大约只能产出 2000~3000 token，
 * 硬塞 24000 字只会得到一个「翻了一半」的结果。所以按「能翻完」来定预算，
 * 超出部分在结果里明确说明截断，而不是让用户对着半截译文猜。
 */
const ENTRY_AI_TRANSLATE_MAX_CHARS = 4_000;

/**
 * 单篇 AI 的服务端上限。
 *
 * 必须**小于 Cloudflare 的 100 秒代理读超时**：否则请求先被 CF 换成 524（非 JSON），
 * 用户看到的是 `HTTP 524`，而服务端其实还在跑、还会记账 —— 一个假失败。
 * 实测单篇平均 71 秒、最长 159 秒，所以这个上限是链路上限倒推出来的。
 */
export const ENTRY_AI_TIMEOUT_MS = 90_000;

/**
 * 送模型前先做一次保守压缩。
 *
 * 抓来的正文常带大量空行、行尾空白、以及整段重复的导航/版权块 —— 实测能占 15%~25%。
 * 它们对摘要和翻译毫无价值，只是把首 token 往后推。只做三件无损的事：
 * 折叠连续空行、去行尾空白、丢弃**够长的完全重复行**（短行可能是「- 是」这种有效列表项）。
 */
export function compactForAi(text: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  let blank = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/[ \t\u3000]+$/g, '');
    if (!line.trim()) {
      if (!blank && out.length) out.push('');
      blank = true;
      continue;
    }
    blank = false;
    if (line.length >= 24) {
      if (seen.has(line)) continue;
      seen.add(line);
    }
    out.push(line);
  }
  return out.join('\n').trim();
}

export function truncateForAi(
  text: string,
  action: EntryAiBody['action'],
): { content: string; truncated: boolean } {
  const compact = compactForAi(text);
  const limit = action === 'translate' ? ENTRY_AI_TRANSLATE_MAX_CHARS : ENTRY_AI_MAX_CHARS;
  if (compact.length <= limit) return { content: compact, truncated: false };
  return { content: compact.slice(0, limit), truncated: true };
}

/**
 * 思考指令：与日报同一套（`/no_think` 关掉混合思考模型的思考链）。
 * 真正的开关是请求体里的顶层 `enable_thinking`（见 packages/ai/src/llm.ts），
 * 这段文本只是给认 `/no_think` 的模板留一条兜底路径。
 *
 * 单篇动作（摘要 / 要点 / 翻译 / 解释）都不需要深度推理，所以默认关；
 * 账号在设置里显式开了「模型思考」才跟随 —— 那个开关是账号级全局配置。
 */
export const thinkingDirective = (llm: ResolvedLlm): string =>
  llm.thinking ? ' /think' : ' /no_think';

/**
 * 按动作构造系统提示词。用户自定义只在此范围内生效（不接收外部 prompt 注入），
 * 保证输出是「对本人订阅内容的安全摘要」，不会把任意指令透传给模型。
 */
export function entryAiSystemPrompt(action: EntryAiBody['action'], targetLang: string): string {
  const lang = targetLang || '简体中文';
  switch (action) {
    case 'summary':
      return '你是一个严谨的中文编辑。请为下面的文章生成一段摘要，3-5 句，抓住核心事实与结论。只输出摘要本身，不要加「摘要：」等前缀。';
    case 'keypoints':
      return '你是一个严谨的中文编辑。请提炼下面文章的关键要点，用 3-6 条无序列表（每条一行，以「- 」开头）呈现，每条一句话。只输出列表。';
    case 'translate':
      return `你是一个专业译者。请将下面文章全文翻译成${lang}，保留原有段落结构；正文里的专有名词可保留原文并在括号里给译文。只输出译文，不要加「译文：」等前缀。`;
    case 'explain':
      return `你是一个善于科普的讲解者。请用通俗易懂的语言向非专业读者解释下面这篇文章在讲什么、为什么重要，使用${lang}，3-5 句。只输出解释本身。`;
  }
}

/**
 * 兼容旧签名：按单篇 AI 能力解析模型。
 * 新代码一律用 `resolveLlmForTask(db, uid, task, action)` —— 它会按能力开关
 * 判断、按路由选提供商，并回落默认槽。保留本函数只为 CLI / 老脚本不破。
 */
export async function resolveLlmForUser(db: Db, uid: string): Promise<ResolvedLlm> {
  return resolveLlmForTask(db, uid, 'entry_ai');
}

/**
 * 出网闸门：模型地址是用户可控目标，填成本站内部接口就会变成 SSRF。
 * 地址不可用就别往下跑 —— 等 90 秒超时再报错，体验比直接说清楚差得多。
 */
export async function assertLlmHost(llm: ResolvedLlm): Promise<void> {
  if (!llm.baseUrl) return;
  try {
    await assertPublicHost(llm.baseUrl);
  } catch (e) {
    throw new ApiException('E_MODEL_URL_UNREACHABLE', {
      detail: (e as Error)?.message ?? String(e),
    });
  }
}

/** owner 隔离地读一条条目：id 猜对了也读不到别人的正文。 */
export async function loadOwnedEntry(
  db: Db,
  uid: string,
  entryId: number,
): Promise<{ id: number; title: string | null; content: string | null }> {
  const [entry] = await db
    .select({ id: entriesTable.id, content: entriesTable.content, title: entriesTable.title })
    .from(entriesTable)
    .innerJoin(feeds, eq(feeds.id, entriesTable.feedId))
    .where(and(eq(entriesTable.id, entryId), eq(feeds.ownerId, uid)))
    .limit(1);
  if (!entry) throw new ApiException('E_ENTRY_NOT_FOUND');
  return entry;
}

/* ---------------- 单篇 AI ---------------- */

/**
 * 跑一个单篇 AI 动作，返回生成的文本。
 * 模型失败抛错（带稳定码），用量照记 —— 失败也要在明细里留痕。
 */
export async function execEntryAi(
  db: Db,
  uid: string,
  input: { entryId: number; action: EntryAiBody['action']; targetLang?: string },
): Promise<{ result: string }> {
  const entry = await loadOwnedEntry(db, uid, input.entryId);
  const llm = await resolveLlmForTask(db, uid, 'entry_ai', input.action);
  await assertLlmHost(llm);

  const cut = truncateForAi(entry.content ?? '', input.action);
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        entryAiSystemPrompt(input.action, input.targetLang ?? '简体中文') + thinkingDirective(llm),
    },
    {
      role: 'user',
      content:
        `文章标题：${entry.title ?? '(无标题)'}\n\n正文：\n${cut.content}` +
        (cut.truncated ? '\n\n（正文过长已截断，请基于以上内容作答，不要臆测后续内容）' : ''),
    },
  ];

  const entryLabel = (entry.title ?? '').trim() || '单篇 AI';
  const started = Date.now();
  try {
    const { content: result, usage } = await chat(messages, llm, {
      fetchImpl: safeFetch,
      timeoutMs: ENTRY_AI_TIMEOUT_MS,
      /* 总预算固定 90 秒：重试也要落在里面，不能变成 2×90。
       * 空内容重试是实测必需——混合思考模型没收到 /no_think 时会把答案写进
       * reasoning_content，content 是空串，直接重试一次多半就能拿到正常输出。 */
      budgetMs: ENTRY_AI_TIMEOUT_MS,
      retryOnEmpty: true,
    });
    await recordAiUsage(db, uid, 'entry_ai', usage, true, 1, {
      model: llm.model,
      label: entryLabel,
      durationMs: Date.now() - started,
    });
    return { result };
  } catch (e) {
    await recordAiUsage(db, uid, 'entry_ai', null, false, 1, {
      model: llm.model,
      label: entryLabel,
      durationMs: Date.now() - started,
      error: (e as Error)?.message ?? String(e),
    });
    throw e;
  }
}

/* ---------------- 单篇 AI 标签 ---------------- */

/**
 * 重算一条的 AI 标签并落库。
 * 失败时先写 `failed` 行（便于前端「重试」），再把错误抛给调用方。
 */
export async function execEntryTags(
  db: Db,
  uid: string,
  entryId: number,
): Promise<{ tags: string[]; model: string }> {
  const entry = await loadOwnedEntry(db, uid, entryId);
  const llm = await resolveLlmForTask(db, uid, 'ai_tags');
  await assertLlmHost(llm);

  const id = crypto.randomUUID();
  try {
    const { tags } = await suggestEntryTags(entry.title ?? '', entry.content ?? '', llm, safeFetch);
    await db
      .insert(entryAiTags)
      .values({
        id,
        userId: uid,
        entryId,
        tags,
        model: llm.model,
        promptVersion: AI_TAG_PROMPT_VERSION,
        status: 'done',
      })
      .onConflictDoUpdate({
        target: [entryAiTags.userId, entryAiTags.entryId],
        set: {
          tags,
          model: llm.model,
          promptVersion: AI_TAG_PROMPT_VERSION,
          status: 'done',
          error: null,
          updatedAt: sql`now()`,
        },
      });
    return { tags, model: llm.model };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db
      .insert(entryAiTags)
      .values({
        id,
        userId: uid,
        entryId,
        tags: [],
        model: llm.model,
        promptVersion: AI_TAG_PROMPT_VERSION,
        status: 'failed',
        error: message.slice(0, 500),
      })
      .onConflictDoUpdate({
        target: [entryAiTags.userId, entryAiTags.entryId],
        set: { status: 'failed', error: message.slice(0, 500), updatedAt: sql`now()` },
      });
    throw e;
  }
}

/* ---------------- 日报 ---------------- */

export type DigestRunResult = {
  cached: boolean;
  digest: Awaited<ReturnType<typeof generateDigest>>['digest'];
};

/**
 * 生成一份日报。三道前置检查缺一不可，否则就是「绕过开关烧额度」：
 * ① 账号自己关了日报入口 → E_DIGEST_DISABLED；
 * ② 日期必须是真实日期；
 * ③ 模型地址必须能出网（SSRF）。
 */
export async function execDigest(
  db: Db,
  uid: string,
  input: { date?: string; force?: boolean; feeds?: number[] | null },
): Promise<DigestRunResult> {
  const [userRow] = await db
    .select({ prefs: users.prefs })
    .from(users)
    .where(eq(users.id, uid))
    .limit(1);
  if (!userRow) throw new ApiException('E_USER_NOT_FOUND', { status: 401 });

  if (userLayout(userRow.prefs).digestEnabled === false)
    throw new ApiException('E_DIGEST_DISABLED');

  const date = (input.date ?? '').trim() || shanghaiDate();
  if (!isRealDate(date)) throw new ApiException('E_DATE_INVALID');

  const cfg = userDigest(userRow.prefs);
  const llm = await resolveLlmForTask(db, uid, 'digest');
  await assertLlmHost(llm);

  const scope = await resolveDigestScope(db, uid, input.feeds ?? null, cfg);
  const started = Date.now();
  try {
    const result = await generateDigest({
      db,
      ownerId: uid,
      feedIds: scope,
      date,
      force: input.force === true,
      llm,
      style: cfg.style,
      limits: { maxPerFeed: cfg.maxPerFeed, maxTotal: cfg.maxTotal, keepDays: cfg.keepDays },
      fetchImpl: safeFetch,
    });
    // 日报一轮可能调多次（map-reduce 分批），按实际次数记账；cached 不动用量
    if (!result.cached && result.usage.calls > 0) {
      await recordAiUsage(db, uid, 'digest', result.usage, true, result.usage.calls, {
        model: llm.model,
        label: `日报 ${date}`,
        durationMs: Date.now() - started,
      });
    }
    return { cached: result.cached, digest: result.digest };
  } catch (e) {
    // 手动生成失败也要留痕：模型状态里最需要看到的就是「昨天点了生成，为什么没出来」
    await recordAiUsage(db, uid, 'digest', null, false, 1, {
      model: llm.model,
      label: `日报 ${date}`,
      durationMs: Date.now() - started,
      error: (e as Error)?.message ?? String(e),
    });
    throw e;
  }
}

/* ---------------- 探索问答 ---------------- */

/**
 * 全库命中集的硬上限：先把命中全部取回（不按时间截断），再由应用层分时段取样，
 * 让老条目有机会进 top60。只按时间倒序取一段 = 又变回「最近 N 条」窗口，老条目被截。
 * ilike 全表扫 21 万条约 2~5 秒，取回几千行的事实传输不显著增加耗时；
 * 上限只是防极端泛词（如「AI」命中 3 万条）撑爆内存。
 */
const EXPLORE_POOL_CAP = 4000;
/**
 * 查询扩展的关键词上限。原问题抽出的 2-gram + 模型扩展词合并后取这么多个去 OR 检索。
 * 每个词各带 owner 隔离条件；词太多会拖慢全表扫描。
 */
const EXPLORE_QUERY_TERMS = 8;
/** 近期打底池：保证「最近有什么」这类问题即使关键词没命中也有新鲜候选。 */
const EXPLORE_RECENT_SEED = 40;
/** 最终喂给模型的候选数：相关度排序后取top。比旧的「最近120」更精，提示词也更小。 */
const EXPLORE_FEED_LIMIT = 60;
/** 查询扩展是一次轻量 chat（只吐 JSON 词表）：短预算，失败即降级，不拖主回答。 */
const EXPLORE_EXPAND_TIMEOUT_MS = 12_000;
/**
 * 进程内扩展词缓存上限：同一个问题反复问不必每次烧一次模型调用。
 * 只缓存成功结果，key 含模型名（换模型后扩词质量不同，不复用旧缓存）。
 */
const EXPLORE_EXPAND_CACHE_MAX = 200;
/** 探索单次调用预算：问答比日报短，60 秒足够；仍远低于 CF 的 100 秒。 */
export const EXPLORE_TIMEOUT_MS = 60_000;

/** 中文问答里的高频虚词：从关键词里剔掉，避免「的/什么/最近」把召回带偏。 */
const EXPLORE_STOPWORDS =
  /最近|近期|现在|目前|有什么|哪些|什么|怎么|如何|推荐|一下|帮我|请问|有没|有没有|这个|那个|我|的|了|吗|呢|啊|么|在|是|和|与|及|或|给|看|说|到|对|把|被|从|为|关于|文章|条目|内容/g;

/**
 * 从自然语言问题里抽出召回关键词。
 * 中文没有空格，所以除了整段清理后的串，再补 2-gram（「好剧」「羊毛」「服务器」）
 * 覆盖「最近有好剧」「服务器羊毛」这类口语——全串 ilike 命中率太低。
 * 结果去重、限长，交给 entryConditions 的 q（已转义 %_\，并覆盖正文/标签）。
 */
export function exploreKeywords(question: string): string[] {
  const cleaned = String(question || '')
    .toLowerCase()
    .replace(EXPLORE_STOPWORDS, ' ')
    .replace(/[\s，。！？、；：,.!?;:'"“”‘’()（）[\]【】<>《》/\\|~`@#$%^&*+=_-]+/g, ' ')
    .trim();
  if (!cleaned) return [];
  const out: string[] = [];
  const push = (s: string) => {
    const t = s.trim();
    if (t.length >= 2 && !out.includes(t) && out.length < 8) out.push(t);
  };
  push(cleaned);
  for (const run of cleaned.split(' ')) {
    if (/^[\u4e00-\u9fa5]{2,}$/.test(run)) {
      for (let i = 0; i + 2 <= run.length; i++) push(run.slice(i, i + 2));
    } else if (/^[a-z0-9]{2,}$/.test(run)) {
      push(run);
    }
  }
  return out;
}

/**
 * 进程内扩词缓存（FIFO，超限淘汰 oldest）。key 含模型名：换模型后扩词口径不同，不复用。
 * 只缓存成功且非空的扩展结果；失败/空结果不缓存，下次还有机会扩展成功。
 * 多用户共享一个 Map 没有隐私问题——扩词只依赖问题文本与模型，不含任何账号数据。
 */
const exploreExpandCache = new Map<string, string[]>();

/**
 * 查询扩展：把口语问题补成一组检索词，解决「好剧」命中不了正文里「电视剧/剧集」的语义鸿沟。
 *
 * 用**同一个 chat 模型**、一次轻量调用（短预算、JSON 词表），不新增任何配置。
 * 成功结果进进程内缓存，同一个问题反复问不再烧模型。
 * 任何失败（超时/格式/网络/字段降级都不成立）都吞掉返回空数组，由调用方降级到
 * exploreKeywords 的字面 2-gram —— 扩展是增益，不是依赖，挂了也要能全库检索。
 */
async function expandExploreKeywords(
  question: string,
  llm: ResolvedLlm,
  seed: string[],
): Promise<string[]> {
  const cacheKey = `${llm.model}\n${question}`;
  const cached = exploreExpandCache.get(cacheKey);
  if (cached) return cached;

  const system = [
    '你是搜索词扩展助手。用户会在自己的订阅文章库里检索，请把问题改写成一组便于全文检索的关键词。',
    '输出严格 JSON：{"terms":["词1","词2"]}。要求：',
    '- 给同义词、近义词、上位词和常见口语说法（如「好剧」→ 电视剧/剧集/追剧）。',
    '- 只给文章**标题里真正会出现的实词**（名词/专名），2~6 个字；不要句子、虚词、',
    '  主观形容（如「高分」「口碑」）或正文里才有的泛词——这些命中不了标题，扩展无效。',
    `- 最多 ${EXPLORE_QUERY_TERMS} 个，按相关度从高到低，不要重复。`,
    '只输出 JSON，不要解释。',
    thinkingDirective(llm),
  ].join('\n');
  try {
    const { content } = await chat(
      [
        { role: 'system', content: system },
        {
          role: 'user',
          content: `问题：${question}\n已有的字面关键词：${seed.join('、') || '无'}`,
        },
      ],
      { ...llm, thinking: false },
      {
        fetchImpl: safeFetch,
        timeoutMs: EXPLORE_EXPAND_TIMEOUT_MS,
        budgetMs: EXPLORE_EXPAND_TIMEOUT_MS,
        maxTokens: 200,
      },
    );
    const parsed = extractJson(content);
    const terms = Array.isArray(parsed.terms) ? parsed.terms : [];
    const out: string[] = [];
    for (const v of terms) {
      const t = String(v ?? '')
        .trim()
        .toLowerCase()
        .slice(0, 12);
      if (t.length >= 2 && !out.includes(t)) out.push(t);
      if (out.length >= EXPLORE_QUERY_TERMS) break;
    }
    if (out.length) {
      exploreExpandCache.set(cacheKey, out);
      // FIFO：超限淘汰最早插入的键（Map 迭代顺序即插入顺序）。
      while (exploreExpandCache.size > EXPLORE_EXPAND_CACHE_MAX) {
        const oldest = exploreExpandCache.keys().next().value;
        if (oldest === undefined) break;
        exploreExpandCache.delete(oldest);
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * 相关度打分：命中词数为主、字段与词源加权、时间为辅。
 *
 * - 字段权重：标题 3 / 描述 2 / 标签 1——标题命中「好剧」的文章，明显比标签里
 *   碰巧带「好剧」的文章更相关，不该同分。
 * - 词源权重：字面词 1、模型扩展词 0.6——「好剧」比扩出来的「推荐」有区分度，
 *   扩展词泛化命中不应盖过用户的原话。
 * - 每个词在每个字段最多算 1 次，避免长文重复刷分。
 * - CARD_COLUMNS 不含正文；正文命中由检索的 q 条件负责（决定进不进候选），
 *   排序只用可见字段。
 */
const RELEVANCE_FIELD_WEIGHT = { title: 3, description: 2, tag: 1 } as const;
const RELEVANCE_LITERAL_WEIGHT = 1;
const RELEVANCE_EXPANDED_WEIGHT = 0.6;

export function exploreRelevance(
  row: {
    title: string | null;
    description: string | null;
    tags: string[];
  },
  literal: string[],
  expanded: string[] = [],
): number {
  const title = String(row.title || '').toLowerCase();
  const desc = String(row.description || '').toLowerCase();
  const tags = row.tags.map((t) => String(t).toLowerCase());
  let score = 0;
  const add = (term: string, weight: number) => {
    if (!term) return;
    if (title.includes(term)) score += weight * RELEVANCE_FIELD_WEIGHT.title;
    if (desc.includes(term)) score += weight * RELEVANCE_FIELD_WEIGHT.description;
    if (tags.some((t) => t.includes(term))) score += weight * RELEVANCE_FIELD_WEIGHT.tag;
  };
  for (const t of literal) add(t, RELEVANCE_LITERAL_WEIGHT);
  for (const t of expanded) add(t, RELEVANCE_EXPANDED_WEIGHT);
  return score;
}

/**
 * 分时段取样：把已按相关度排序的命中集按发布时间分成三段，各取配额后合并，
 * 保证老条目不会被近期条目全挤掉——这正是旧「最近 N 条」窗口的痛点。
 *
 * 输入必须已按相关度降序（调用方保证）；每段内部保持该次序（取最相关的）。
 * 三段配额：近 50% / 中 30% / 老 20%，空段不占位、配额顺延给下一段，
 * 避免命中集中在某一段时浪费名额。返回的是为后续 top-N 准备的候选（仍会再全局排序）。
 */
const EXPLORE_ERA_QUOTA = [0.5, 0.3, 0.2] as const;

export function exploreSampleByEra<T extends { publishedAt: Date | null }>(
  ranked: T[],
  total: number,
  now = Date.now(),
): T[] {
  if (!ranked.length) return [];
  // 时间段边界：近 90 天 / 90~365 天 / 更早。按 now 算，测试可注入固定时间。
  const day = 86_400_000;
  const bounds = [now - 90 * day, now - 365 * day];
  const buckets: T[][] = [[], [], []];
  for (const r of ranked) {
    const t = r.publishedAt ? r.publishedAt.getTime() : now; // 无日期当最新处理
    const i = t >= bounds[0]! ? 0 : t >= bounds[1]! ? 1 : 2;
    buckets[i]!.push(r);
  }
  const out: T[] = [];
  let left = total;
  // 先按配额取；某段不够时把剩余名额留给后面的段。
  for (let i = 0; i < buckets.length && left > 0; i++) {
    const want =
      i === buckets.length - 1 ? left : Math.min(left, Math.ceil(total * EXPLORE_ERA_QUOTA[i]!));
    const take = buckets[i]!.slice(0, want);
    out.push(...take);
    left -= take.length;
  }
  // 仍有余量（前面的段有富余）就按相关度次序补齐。
  if (left > 0) {
    const picked = new Set(out);
    for (const r of ranked) {
      if (left <= 0) break;
      if (!picked.has(r)) {
        out.push(r);
        left--;
      }
    }
  }
  return out;
}

/**
 * 把历史轮次转成多轮消息。关键：历史答案里的 `[#n]` 是**那一轮**的候选编号，
 * 与本次的 #n 不是同一篇——直接喂原文会让「那第二部呢」指错条目。
 * 所以按该轮 refs 把 `[#n]` 替换成 `《条目名》`，模型才能正确理解指代。
 */
export function historyToMessages(history: ExploreHistory): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const turn of history) {
    if (!turn || !turn.question) continue;
    let answer = String(turn.answer || '').slice(0, 4000);
    const refs = Array.isArray(turn.refs) ? turn.refs : [];
    // 只替换 [#数字]，倒序处理避免 #1/#10 的前缀互相干扰（这里按匹配逐个替换无此问题，但保持稳妥）
    answer = answer.replace(/\[#(\d+)\]/g, (whole, d: string) => {
      const r = refs[Number(d) - 1];
      return r && r.name ? `《${r.name}》` : whole;
    });
    out.push({ role: 'user', content: String(turn.question).slice(0, 300) });
    if (answer) out.push({ role: 'assistant', content: answer });
  }
  return out;
}

/**
 * 探索问答：在本人订阅里检索候选条目 → 让模型从中挑出相关条目并作答 →
 * 把模型引用的 #编号解析成带真实 id 的条目卡（前端据此跳文章页）。
 *
 * 与日报同构（预检索 + 编号引用），但不落日报表、不依赖 digestEnabled —— 探索是常驻能力。
 * 担保：
 * - owner 隔离：召回走 entryConditions 的 owner 子查询，别的账号条目进不了候选；
 * - 不臆造引用：模型只能引用候选里的 #编号，越界编号直接丢弃；
 * - 统计照记：成功/失败都写 ai_usage_daily 与 ai_request_log。
 */
export async function execExplore(
  db: Db,
  uid: string,
  input: { question: string; history?: ExploreHistory },
): Promise<ExploreResult> {
  const question = String(input.question || '').trim();
  if (!question) throw new ApiException('E_EXPLORE_EMPTY_QUESTION');

  const llm = await resolveLlmForTask(db, uid, 'explore');
  await assertLlmHost(llm);

  const started = Date.now();
  const label = `探索：${question.slice(0, 40)}`;

  // ① 全库召回：字面 2-gram + 模型扩展词 → 全库 OR 检索 → 相关度排序取 top。
  //
  // 与旧实现的差别：不再用「最近 120 条」窗口截断（那让老条目永远搜不到），
  // 而是全库按关键词检索；只保留一小份近期条目打底，兜住「最近有什么」这类
  // 没有明确关键词的问题。两路都走 entryConditions，owner 隔离不因增删改而破。
  const literal = exploreKeywords(question);
  const expanded = await expandExploreKeywords(question, llm, literal);
  // 字面词优先、扩展词补充，合并去重限长（扩展是增益，字面命中率最高排前面）。
  // terms 供 SQL 检索用；打分时分两组传，让字面词的命中权重高于泛化扩展词。
  const terms: string[] = [];
  const literalSet = new Set(literal);
  for (const t of [...literal, ...expanded]) {
    if (t.length >= 2 && !terms.includes(t)) terms.push(t);
    if (terms.length >= EXPLORE_QUERY_TERMS) break;
  }
  const usedExpanded = terms.filter((t) => !literalSet.has(t));

  // entryConditions 的 q 只吃一个关键词；把每个词的完整条件（含 owner 子查询）
  // 用 OR 串起来，owner 隔离不会因 OR 失效——每个分支都限定本人频道。
  // 不按时间 limit 截断：命中集整批取回（上限防泛词撑爆），再分时段取样。
  const kwRows = terms.map((kw) => and(...entryConditions(uid, { feedIds: null, q: kw })));
  const keywordRows = kwRows.length
    ? await db
        .select(CARD_COLUMNS)
        .from(entriesTable)
        .innerJoin(feeds, eq(feeds.id, entriesTable.feedId))
        .where(sql`(${sql.join(kwRows, sql` or `)})`)
        .limit(EXPLORE_POOL_CAP)
    : [];

  // 近期打底：关键词没命中或问「最近」时仍有候选；命中集已够多时可省掉这次查询。
  const recent =
    keywordRows.length >= EXPLORE_FEED_LIMIT
      ? []
      : await db
          .select(CARD_COLUMNS)
          .from(entriesTable)
          .innerJoin(feeds, eq(feeds.id, entriesTable.feedId))
          .where(and(...entryConditions(uid, { feedIds: null })))
          .orderBy(desc(entriesTable.publishedAt), desc(entriesTable.id))
          .limit(EXPLORE_RECENT_SEED);

  const byId = new Map<number, (typeof recent)[number]>();
  for (const r of keywordRows) byId.set(r.id, r);
  for (const r of recent) if (!byId.has(r.id)) byId.set(r.id, r);
  // ① 相关度排序（字段加权 + 词源加权），同分按时间倒序（稳定排序保留 SQL 次序；命中集无 SQL 序时按 id 兜底）。
  const scored = [...byId.values()]
    .map((r) => ({
      r,
      score: exploreRelevance(
        r,
        terms.filter((t) => literalSet.has(t)),
        usedExpanded,
      ),
    }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        (b.r.publishedAt?.getTime() ?? 0) - (a.r.publishedAt?.getTime() ?? 0) ||
        b.r.id - a.r.id,
    );
  // ② 分时段取样：近/中/老各留配额，让老条目不被近期条目挤掉。取样结果已是 top-N
  //    条数，之后按分数重排只调整喂给模型的顺序、不减量（slice 仅作数量保险），
  //    所以老条目的配额名额不会被这步排序挤掉。
  const eraSampled = exploreSampleByEra(
    scored.map((x) => x.r),
    EXPLORE_FEED_LIMIT,
  );
  const scoreById = new Map(scored.map((x) => [x.r.id, x.score]));
  const pool = eraSampled
    .sort((a, b) => (scoreById.get(b.id) ?? 0) - (scoreById.get(a.id) ?? 0))
    .slice(0, EXPLORE_FEED_LIMIT);

  // 没有候选就不必烧模型：直接给一句人话，refs 为空。
  if (!pool.length) {
    await recordAiUsage(db, uid, 'explore', null, true, 0, {
      model: llm.model,
      label,
      durationMs: Date.now() - started,
    });
    return {
      answer: '你的订阅里暂时没有条目可供检索，先添加几个数据源或等抓取一批内容后再来问。',
      refs: [],
      model: llm.model,
      matched: 0,
    };
  }

  // ② 编号化候选：一条一行，带来源/日期/标签/摘要前 180 字；日期让「最近」类问题有依据。
  const cards = pool.map(toCard);
  const candidateText = cards
    .map((c, i) => {
      const tags = c.tags.length ? ` 标签:${c.tags.slice(0, 5).join('/')}` : '';
      const desc = (c.desc || '').replace(/\s+/g, ' ').slice(0, 180);
      return `#${i + 1} ${c.name}（来源:${c.feedName} · ${c.date || '日期未知'}${tags}）\n   ${desc}`;
    })
    .join('\n');

  const history = Array.isArray(input.history) ? input.history : [];
  const system = [
    '你是「探索」助手，帮用户从他自己的订阅条目里找答案。只根据下面给出的候选条目作答，不要臆测候选里没有的内容。',
    '候选条目每条以 #编号 开头，编号是引用凭证。回答用简体中文，简洁清楚（3~8 句）。',
    '在答案里提到某条时，紧跟 [#编号] 标注来源，例如「据 #2 …」。可引用多条，但只准用候选里出现过的编号。',
    '输出严格 JSON：{"answer":"答案正文（含 [#编号] 标注）","refs":[编号数组，按出现顺序]}。refs 只能来自候选编号；没有相关条目就给 refs:[] 并如实说明。',
    history.length
      ? '下面是你和用户之前的对话（历史里的《条目名》是当时引用过的条目）。用户可能在追问，请结合上下文理解「那个/第二部」等指代，但引用仍只能用本次候选的新编号。'
      : '',
    thinkingDirective(llm),
  ].join('\n');

  /* ④ 多轮：历史放在本次问题之前，让「那第二部呢」有指代对象。
   * 历史答案里的 [#n] 已在 historyToMessages 里换成《条目名》，避免跨轮编号错位。 */
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    ...historyToMessages(history),
    { role: 'user', content: `我的问题：${question}\n\n候选条目：\n${candidateText}` },
  ];

  try {
    const { content, usage } = await chat(messages, llm, {
      fetchImpl: safeFetch,
      timeoutMs: EXPLORE_TIMEOUT_MS,
      budgetMs: EXPLORE_TIMEOUT_MS,
      retryOnEmpty: true,
    });
    const parsed = extractJson(content);
    const answer = typeof parsed.answer === 'string' ? parsed.answer.trim() : '';
    if (!answer) throw new Error('explore: model returned an empty answer');

    // ③ 解析引用：越界/非法编号丢弃；按 #顺序 去重，映射回真实条目（带 id）。
    const rawRefs = Array.isArray(parsed.refs) ? parsed.refs : [];
    const seen = new Set<number>();
    const refs = [] as ExploreResult['refs'];
    for (const v of rawRefs) {
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isInteger(n) || n < 1 || n > cards.length || seen.has(n)) continue;
      seen.add(n);
      const c = cards[n - 1]!;
      refs.push({
        id: c.id,
        name: c.name,
        feedName: c.feedName,
        date: c.date || '',
        desc: c.desc,
        image: c.image || null,
      });
    }

    await recordAiUsage(db, uid, 'explore', usage, true, 1, {
      model: llm.model,
      label,
      durationMs: Date.now() - started,
    });
    return { answer, refs, model: llm.model, matched: pool.length };
  } catch (e) {
    await recordAiUsage(db, uid, 'explore', null, false, 1, {
      model: llm.model,
      label,
      durationMs: Date.now() - started,
      error: (e as Error)?.message ?? String(e),
    });
    throw e;
  }
}
