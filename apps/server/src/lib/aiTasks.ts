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

import { and, desc, eq, sql } from 'drizzle-orm';
import { entries as entriesTable, entryAiTags, feeds, users, type Db } from '@feedlore/db';
import type { EntryAiBody, ExploreResult } from '@feedlore/contract';
import {
  chat,
  type ChatMessage,
  getCryptoSecret,
  extractJson,
  generateDigest,
  resolveUserLlm,
  shanghaiDate,
  suggestEntryTags,
  AI_TAG_PROMPT_VERSION,
  type ResolvedLlm,
} from '@feedlore/ai';
import { loadLlmRow } from './llm';
import { assertPublicHost, safeFetch } from './net';
import { recordAiUsage } from './aiUsage';
import { ApiException } from './apiError';
import { resolveDigestScope } from './digest';
import { userDigest, userLayout } from './prefs';
import { CARD_COLUMNS, entryConditions } from './entriesQuery';
import { toCard } from './dto';

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
export const thinkingDirective = (llm: ResolvedLlm): string => (llm.thinking ? ' /think' : ' /no_think');

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

/** 取该账号的模型配置（解密后）。 */
export async function resolveLlmForUser(db: Db, uid: string): Promise<ResolvedLlm> {
  const secret = await getCryptoSecret(db);
  return resolveUserLlm(await loadLlmRow(db, uid), secret);
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
    throw new ApiException('E_MODEL_URL_UNREACHABLE', { detail: (e as Error)?.message ?? String(e) });
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
  const llm = await resolveLlmForUser(db, uid);
  await assertLlmHost(llm);

  const cut = truncateForAi(entry.content ?? '', input.action);
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: entryAiSystemPrompt(input.action, input.targetLang ?? '简体中文') + thinkingDirective(llm),
    },
    {
      role: 'user',
      content: `文章标题：${entry.title ?? '(无标题)'}\n\n正文：\n${cut.content}`
        + (cut.truncated ? '\n\n（正文过长已截断，请基于以上内容作答，不要臆测后续内容）' : ''),
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
  const llm = await resolveLlmForUser(db, uid);
  await assertLlmHost(llm);

  const id = crypto.randomUUID();
  try {
    const { tags } = await suggestEntryTags(entry.title ?? '', entry.content ?? '', llm, safeFetch);
    await db
      .insert(entryAiTags)
      .values({ id, userId: uid, entryId, tags, model: llm.model, promptVersion: AI_TAG_PROMPT_VERSION, status: 'done' })
      .onConflictDoUpdate({
        target: [entryAiTags.userId, entryAiTags.entryId],
        set: { tags, model: llm.model, promptVersion: AI_TAG_PROMPT_VERSION, status: 'done', error: null, updatedAt: sql`now()` },
      });
    return { tags, model: llm.model };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db
      .insert(entryAiTags)
      .values({ id, userId: uid, entryId, tags: [], model: llm.model, promptVersion: AI_TAG_PROMPT_VERSION, status: 'failed', error: message.slice(0, 500) })
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
  const [userRow] = await db.select({ prefs: users.prefs }).from(users).where(eq(users.id, uid)).limit(1);
  if (!userRow) throw new ApiException('E_USER_NOT_FOUND', { status: 401 });

  if (userLayout(userRow.prefs).digestEnabled === false) throw new ApiException('E_DIGEST_DISABLED');

  const date = (input.date ?? '').trim() || shanghaiDate();
  if (!isRealDate(date)) throw new ApiException('E_DATE_INVALID');

  const cfg = userDigest(userRow.prefs);
  const llm = await resolveLlmForUser(db, uid);
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

/** 探索召回的候选上限：太多会撑爆提示词、拖慢首 token；太少会漏掉相关条目。 */
const EXPLORE_CANDIDATE_LIMIT = 32;
/** 近期池大小：覆盖「最近有什么」这类问题；再按关键词补充更早的命中。 */
const EXPLORE_RECENT_POOL = 120;
/** 探索单次调用预算：问答比日报短，60 秒足够；仍远低于 CF 的 100 秒。 */
export const EXPLORE_TIMEOUT_MS = 60_000;

/** 中文问答里的高频虚词：从关键词里剔掉，避免「的/什么/最近」把召回带偏。 */
const EXPLORE_STOPWORDS = /最近|近期|现在|目前|有什么|哪些|什么|怎么|如何|推荐|一下|帮我|请问|有没|有没有|这个|那个|我|的|了|吗|呢|啊|么|在|是|和|与|及|或|给|看|说|到|对|把|被|从|为|关于|文章|条目|内容/g;

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
    .replace(/[\s，。！？、；：,.!?;:'"“”‘’()（）\[\]【】<>《》/\\|~`@#$%^&*+=_-]+/g, ' ')
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
  input: { question: string },
): Promise<ExploreResult> {
  const question = String(input.question || '').trim();
  if (!question) throw new ApiException('E_EXPLORE_EMPTY_QUESTION');

  const llm = await resolveLlmForUser(db, uid);
  await assertLlmHost(llm);

  const started = Date.now();
  const label = `探索：${question.slice(0, 40)}`;

  // ① 召回：近期池 + 关键词命中，按 id 去重。两路都走 owner 隔离查询。
  const recent = await db
    .select(CARD_COLUMNS)
    .from(entriesTable)
    .innerJoin(feeds, eq(feeds.id, entriesTable.feedId))
    .where(and(...entryConditions(db, uid, { feedIds: null })))
    .orderBy(desc(entriesTable.publishedAt), desc(entriesTable.id))
    .limit(EXPLORE_RECENT_POOL);

  const keywords = exploreKeywords(question);
  // entryConditions 的 q 只吃一个关键词；把多个 2-gram 各自的完整条件（含 owner 子查询）
  // 用 OR 串起来，owner 隔离不会因 OR 而失效——每个分支都限定本人频道。
  const kwRows = keywords.map((kw) => and(...entryConditions(db, uid, { feedIds: null, q: kw })));
  const keywordRows = kwRows.length
    ? await db
        .select(CARD_COLUMNS)
        .from(entriesTable)
        .innerJoin(feeds, eq(feeds.id, entriesTable.feedId))
        .where(sql`(${sql.join(kwRows, sql` or `)})`)
        .orderBy(desc(entriesTable.publishedAt), desc(entriesTable.id))
        .limit(EXPLORE_CANDIDATE_LIMIT * 2)
    : [];

  const byId = new Map<number, (typeof recent)[number]>();
  for (const r of recent) byId.set(r.id, r);
  for (const r of keywordRows) if (!byId.has(r.id)) byId.set(r.id, r);
  const pool = [...byId.values()].slice(0, EXPLORE_RECENT_POOL);

  // 没有候选就不必烧模型：直接给一句人话，refs 为空。
  if (!pool.length) {
    await recordAiUsage(db, uid, 'explore', null, true, 0, { model: llm.model, label, durationMs: Date.now() - started });
    return {
      answer: '你的订阅里暂时没有条目可供检索，先添加几个数据源或等抓取一批内容后再来问。',
      refs: [], model: llm.model, matched: 0,
    };
  }

  // ② 编号化候选：一条一行，带来源/日期/标签/摘要前 180 字；日期让「最近」类问题有依据。
  const cards = pool.map(toCard);
  const candidateText = cards.map((c, i) => {
    const tags = c.tags.length ? ` 标签:${c.tags.slice(0, 5).join('/')}` : '';
    const desc = (c.desc || '').replace(/\s+/g, ' ').slice(0, 180);
    return `#${i + 1} ${c.name}（来源:${c.feedName} · ${c.date || '日期未知'}${tags}）\n   ${desc}`;
  }).join('\n');

  const system = [
    '你是「探索」助手，帮用户从他自己的订阅条目里找答案。只根据下面给出的候选条目作答，不要臆测候选里没有的内容。',
    '候选条目每条以 #编号 开头，编号是引用凭证。回答用简体中文，简洁清楚（3~8 句）。',
    '在答案里提到某条时，紧跟 [#编号] 标注来源，例如「据 #2 …」。可引用多条，但只准用候选里出现过的编号。',
    '输出严格 JSON：{"answer":"答案正文（含 [#编号] 标注）","refs":[编号数组，按出现顺序]}。refs 只能来自候选编号；没有相关条目就给 refs:[] 并如实说明。',
    thinkingDirective(llm),
  ].join('\n');

  const messages: ChatMessage[] = [
    { role: 'system', content: system },
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
        id: c.id, name: c.name, feedName: c.feedName,
        date: c.date || '', desc: c.desc, image: c.image || null,
      });
    }

    await recordAiUsage(db, uid, 'explore', usage, true, 1, {
      model: llm.model, label, durationMs: Date.now() - started,
    });
    return { answer, refs, model: llm.model, matched: pool.length };
  } catch (e) {
    await recordAiUsage(db, uid, 'explore', null, false, 1, {
      model: llm.model, label, durationMs: Date.now() - started,
      error: (e as Error)?.message ?? String(e),
    });
    throw e;
  }
}
