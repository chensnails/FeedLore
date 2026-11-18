/**
 * AI 智能标签的执行器与调度器（Phase 2 · 智能标签）。
 *
 * 与日报调度同款「进程内每分钟 tick」哲学（单进程够用、少一个故障点）：
 * - 只把 `user_llm.routes.ai_tags.enabled = true` 的账号捞出来（SQL 过滤），否则每分钟要把全表拉回 JS。
 *   0016 起 ai_tags 是唯一开关（默认关），旧 prefs.aiTags 已废弃并在迁移时把开启状态平移进 routes。
 * （用 left join 判缺失，已打过的自然跳过 → 天然幂等，也兼顾历史条目回填）；
 * - 复用 `chat` / `safeFetch`（SSRF 三道闸）/ 按账号隔离 / `llmComplete` 前置守卫；
 * - 模型失败写入 status='failed'（避免每 tick 空转重试），用户改好 Key 后可按需 POST 重算。
 */

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { entries, entryAiTags, feeds, userLlm, users, type Db } from '@feedlore/db';
import {
  AI_TAG_PROMPT_VERSION,
  llmComplete,
  suggestEntryTags,
  type ResolvedLlm,
} from '@feedlore/ai';
import { assertPublicHost, safeFetch } from './net';
import { recordAiUsage } from './aiUsage';
import { resolveLlmForTask, isCapabilityEnabled } from './llm';

const TICK_MS = 60 * 1000;
/** 每账号每 tick 最多处理的篇数：控制单次模型调用量，避免一上来把整库额度烧光。 */
const AI_TAG_BATCH_PER_TICK = 20;

interface UntaggedEntry {
  id: number;
  title: string;
  content: string | null;
}

/** 取该用户「还没有 AI 标签」的若干条目（owner 隔离 + 按发布时间倒序）。 */
export async function findUntaggedEntries(db: Db, uid: string, limit: number): Promise<UntaggedEntry[]> {
  return db
    .select({ id: entries.id, title: entries.title, content: entries.content })
    .from(entries)
    .innerJoin(feeds, eq(feeds.id, entries.feedId))
    .leftJoin(entryAiTags, and(eq(entryAiTags.entryId, entries.id), eq(entryAiTags.userId, uid)))
    .where(and(eq(feeds.ownerId, uid), isNull(entryAiTags.id)))
    .orderBy(sql`${entries.publishedAt} desc nulls last`, desc(entries.id))
    .limit(limit);
}

/** 为单篇生成并落库 AI 标签；返回最终状态。模型失败返回 'failed'（带上错误，不抛）。
 *  `usage` 回传给定时任务做本轮汇总（逐篇明细由 tick 合并成一条，见 aiTag 的批量段）。 */
export async function tagEntry(
  db: Db,
  uid: string,
  entry: UntaggedEntry,
  llm: ResolvedLlm,
): Promise<{ status: 'done' | 'failed'; tags: string[]; error?: string; usage?: { promptTokens: number; completionTokens: number; totalTokens: number } }> {
  const id = crypto.randomUUID();
  const started = Date.now();
  const label = (entry.title ?? '').trim() || 'AI 标签';
  try {
    const { tags, usage } = await suggestEntryTags(entry.title, entry.content ?? '', llm, safeFetch);
    // 只记聚合：定时打标一分钟能跑 20 篇，逐篇落明细会把「模型状态」列表刷满
    await recordAiUsage(db, uid, 'ai_tags', usage, true, 1, {
      model: llm.model,
      label,
      durationMs: Date.now() - started,
      detail: false,
    });
    await db
      .insert(entryAiTags)
      .values({
        id,
        userId: uid,
        entryId: entry.id,
        tags,
        model: llm.model,
        promptVersion: AI_TAG_PROMPT_VERSION,
        status: 'done',
      })
      .onConflictDoUpdate({
        target: [entryAiTags.userId, entryAiTags.entryId],
        set: { tags, model: llm.model, promptVersion: AI_TAG_PROMPT_VERSION, status: 'done', error: null, updatedAt: sql`now()` },
      });
    return { status: 'done', tags, usage: usage ?? undefined };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await recordAiUsage(db, uid, 'ai_tags', null, false, 1, {
      model: llm.model,
      label,
      durationMs: Date.now() - started,
      error: message,
      detail: false,
    });
    await db
      .insert(entryAiTags)
      .values({
        id,
        userId: uid,
        entryId: entry.id,
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
    return { status: 'failed', tags: [], error: message };
  }
}

/**
 * 一次 tick：找出「此刻该打标签」的账号并逐个处理。
 * SQL 直接按 user_llm.routes.ai_tags.enabled = true 过滤（innerJoin），
 * 这样每分钟只拉回真正开了这一项的账号。
 */
export async function runAiTagTick(db: Db, _now: Date = new Date()): Promise<number> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(userLlm, eq(userLlm.userId, users.id))
    .where(sql`${userLlm.routes}->'ai_tags'->>'enabled' = 'true'`);
  if (!rows.length) return 0;

  let done = 0;

  for (const u of rows) {
    try {
      // 「自动任务」开关：关掉后定时调度不烧额度
      if (!(await isCapabilityEnabled(db, u.id, 'auto'))) continue;
      // 「AI 标签」单开关：默认关，必须显式开启（isCapabilityEnabled 特判）
      if (!(await isCapabilityEnabled(db, u.id, 'ai_tags'))) continue;

      const llm = await resolveLlmForTask(db, u.id, 'ai_tags');
      if (!llmComplete(llm)) continue; // 没配模型：跳过这一账号（不会无限重试）

      // 地址不可用先拦下，别等 180 秒超时（与日报生成一致）
      if (llm.baseUrl) {
        try {
          await assertPublicHost(llm.baseUrl);
        } catch {
          continue;
        }
      }

      const batch = await findUntaggedEntries(db, u.id, AI_TAG_BATCH_PER_TICK);
      if (!batch.length) continue;

      /* 本轮汇总成一条明细：一分钟能跑 20 篇，逐篇落明细会把「模型状态」列表整屏刷成
         打标记录，把用户真正关心的日报 / 单篇调用挤掉。用量仍是逐篇精确记账（tagEntry 内），
         这里只用 aggregate:false 补一条「本轮发生了什么」。 */
      const batchStarted = Date.now();
      let okCount = 0;
      let failCount = 0;
      let promptTokens = 0;
      let completionTokens = 0;
      let firstError = '';
      for (const e of batch) {
        const r = await tagEntry(db, u.id, e, llm);
        done += 1;
        if (r.usage) {
          promptTokens += r.usage.promptTokens;
          completionTokens += r.usage.completionTokens;
        }
        if (r.status === 'failed') {
          failCount += 1;
          firstError = firstError || (r.error || '打标失败');
          console.warn(`[ai-tags] user ${u.id} entry ${e.id} tagging failed: ${r.error}`);
        } else {
          okCount += 1;
        }
      }
      await recordAiUsage(
        db,
        u.id,
        'ai_tags',
        { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
        failCount === 0,
        batch.length,
        {
          model: llm.model,
          label: `自动打标 · ${okCount} 成功${failCount ? ` / ${failCount} 失败` : ''}`,
          durationMs: Date.now() - batchStarted,
          error: firstError,
          aggregate: false,
        },
      );
      console.log(`[ai-tags] user ${u.id} tagged ${batch.length} entries`);
    } catch (e) {
      console.error(`[ai-tags] tick failed for user ${u.id}: ` + ((e as Error)?.message ?? e));
    }
  }

  return done;
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startAiTagScheduler(db: Db): void {
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    void runAiTagTick(db).catch((e: unknown) =>
      console.error('[ai-tags] scheduler tick failed: ', (e as Error)?.message ?? e),
    );
  }, TICK_MS);
  timer.unref?.();
  console.log('[ai-tags] scheduled per account: untagged entries tagged every minute (enabled accounts only)');
}

export function stopAiTagScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
