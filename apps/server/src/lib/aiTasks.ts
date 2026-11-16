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

import { and, eq, sql } from 'drizzle-orm';
import { entries as entriesTable, entryAiTags, feeds, users, type Db } from '@feedlore/db';
import type { EntryAiBody } from '@feedlore/contract';
import {
  chat,
  type ChatMessage,
  getCryptoSecret,
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
