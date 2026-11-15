/**
 * AI 用量统计（按「账号 × 日期 × 功能」聚合）。
 *
 * 为什么聚合：只需要回答「谁、哪天、哪项功能、调了几次、烧多少 token」。聚合后行数是
 * 账号数 × 天数 × 5 类功能，可控；逐次明细会让表随调用量线性增长却没有对应分析需求。
 *
 * 两条硬约束：
 * - **统计是旁路**：任何写入失败都吞掉，绝不能让「统计挂了」把成功的模型调用变成失败；
 * - **用量只在上游返回 usage 时累加**，没回就是 0，所以 tokens 可能小于 calls 的预期。
 */

import { and, desc, eq, gte } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { aiRequestLog, aiUsageDaily, type Db } from '@feedlore/db';
import { shanghaiDate } from '@feedlore/ai';

/** 功能分类。新增调用点时必须在这里登记，否则前端「按功能」里看不到。 */
export const AI_USAGE_KINDS = ['digest', 'entry_ai', 'ai_tags', 'mcp', 'test'] as const;
export type AiUsageKind = (typeof AI_USAGE_KINDS)[number];

/** 明细保留口径：每个账号最近 200 条、且不超过 30 天（写入后顺带裁剪）。 */
export const AI_REQUEST_KEEP = 200;
export const AI_REQUEST_KEEP_DAYS = 30;

export interface UsageLike {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** 日期位移（纯函数，便于单测）。只做 YYYY-MM-DD 的日历加减。 */
export function shiftDate(date: string, deltaDays: number): string {
  const d = new Date(date + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return date;
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

/** 一次调用附带的明细字段（可选：调用方没传就只落聚合）。 */
export interface AiRequestMeta {
  /** 实际使用的模型名（列表里显示「当时用哪个模型跑出来的」） */
  model?: string;
  /** 这次在做什么：文章标题 / 日报日期 / MCP 工具名 / 「测试连接」 */
  label?: string;
  /** 端到端耗时（毫秒） */
  durationMs?: number;
  /** 失败原因（成功留空） */
  error?: string;
}

const clip = (s: unknown, n: number): string => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};

/**
 * 记一次调用：日聚合 + 明细一行，写明细后顺带裁剪。
 * `ok=false` 时 calls 与 fails 同时 +1（失败也是一次尝试）。
 * 不抛错：调用方不需要 try/catch —— 统计与日志都是旁路。
 */
export async function recordAiUsage(
  db: Db,
  userId: string,
  kind: AiUsageKind,
  usage: UsageLike | null | undefined,
  ok = true,
  /** 本次要记的调用次数（日报 map-reduce 一轮会调多次；失败一次传 1 即可） */
  calls = 1,
  /** 明细字段（模型 / 在做什么 / 耗时 / 失败原因）；不传就只记聚合 */
  meta?: AiRequestMeta,
): Promise<void> {
  const promptTokens = Math.max(0, Math.round(usage?.promptTokens ?? 0));
  const completionTokens = Math.max(0, Math.round(usage?.completionTokens ?? 0));
  const fails = ok ? 0 : 1;
  const n = Math.max(1, Math.round(calls));
  try {
    await db
      .insert(aiUsageDaily)
      .values({
        userId,
        date: shanghaiDate(),
        kind,
        calls: n,
        fails,
        promptTokens,
        completionTokens,
      })
      .onConflictDoUpdate({
        target: [aiUsageDaily.userId, aiUsageDaily.date, aiUsageDaily.kind],
        set: {
          calls: sql`${aiUsageDaily.calls} + ${n}`,
          fails: sql`${aiUsageDaily.fails} + ${fails}`,
          promptTokens: sql`${aiUsageDaily.promptTokens} + ${promptTokens}`,
          completionTokens: sql`${aiUsageDaily.completionTokens} + ${completionTokens}`,
        },
      });
  } catch {
    /* 旁路：统计失败不影响业务 */
  }

  // 明细与裁剪同样吞错：日志写不进去，模型调用照样算成功
  try {
    await db.insert(aiRequestLog).values({
      userId,
      kind,
      model: clip(meta?.model, 120),
      label: clip(meta?.label, 160),
      ok,
      calls: n,
      durationMs: Math.max(0, Math.round(meta?.durationMs ?? 0)),
      promptTokens,
      completionTokens,
      error: ok ? '' : clip(meta?.error, 300),
    });
    // 每个账号只留最近 200 条 / 30 天：溢出的一两条在每次写入后顺带清掉，表大小有上界
    await db.execute(sql`
      delete from ${aiRequestLog}
      where ${aiRequestLog.userId} = ${userId}
        and (
          ${aiRequestLog.createdAt} < now() - make_interval(days => ${AI_REQUEST_KEEP_DAYS})
          or ${aiRequestLog.id} not in (
            select id from ${aiRequestLog}
            where ${aiRequestLog.userId} = ${userId}
            order by ${aiRequestLog.id} desc
            limit ${AI_REQUEST_KEEP}
          )
        )
    `);
  } catch {
    /* 旁路 */
  }
}

export interface AiRequestView {
  id: number;
  kind: string;
  model: string;
  label: string;
  ok: boolean;
  calls: number;
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  error: string;
  createdAt: string;
}

/** 读最近 `limit` 条明细（本人），新的在前。 */
export async function readAiRequests(db: Db, userId: string, limit = 50): Promise<AiRequestView[]> {
  const n = Math.max(1, Math.min(AI_REQUEST_KEEP, Math.round(limit)));
  const rows = await db
    .select({
      id: aiRequestLog.id,
      kind: aiRequestLog.kind,
      model: aiRequestLog.model,
      label: aiRequestLog.label,
      ok: aiRequestLog.ok,
      calls: aiRequestLog.calls,
      durationMs: aiRequestLog.durationMs,
      promptTokens: aiRequestLog.promptTokens,
      completionTokens: aiRequestLog.completionTokens,
      error: aiRequestLog.error,
      createdAt: aiRequestLog.createdAt,
    })
    .from(aiRequestLog)
    .where(eq(aiRequestLog.userId, userId))
    .orderBy(desc(aiRequestLog.createdAt), desc(aiRequestLog.id))
    .limit(n);

  return rows.map((r) => {
    const promptTokens = Number(r.promptTokens);
    const completionTokens = Number(r.completionTokens);
    return {
      id: Number(r.id),
      kind: r.kind,
      model: r.model,
      label: r.label,
      ok: r.ok,
      calls: r.calls,
      durationMs: r.durationMs,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      error: r.error,
      createdAt: (r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt)).toISOString(),
    };
  });
}

export interface UsageTotal {
  calls: number;
  fails: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface UsageSummary {
  today: UsageTotal;
  days7: UsageTotal;
  days30: UsageTotal;
  byKind: Array<{ kind: string; calls: number; fails: number; totalTokens: number }>;
  series: Array<{ date: string; calls: number; totalTokens: number }>;
}

const emptyTotal = (): UsageTotal => ({ calls: 0, fails: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 });

/** 读某个账号近 `days` 天的用量（含今日），顺带算出今日 / 近 7 天两个口径的合计。 */
export async function readAiUsageSummary(db: Db, userId: string, days = 30): Promise<UsageSummary> {
  const today = shanghaiDate();
  const span = Math.max(1, Math.min(365, Math.round(days)));
  const since = shiftDate(today, -(span - 1));
  const since7 = shiftDate(today, -6);

  const rows = await db
    .select({
      date: aiUsageDaily.date,
      kind: aiUsageDaily.kind,
      calls: aiUsageDaily.calls,
      fails: aiUsageDaily.fails,
      promptTokens: aiUsageDaily.promptTokens,
      completionTokens: aiUsageDaily.completionTokens,
    })
    .from(aiUsageDaily)
    .where(and(eq(aiUsageDaily.userId, userId), gte(aiUsageDaily.date, since)));

  const todayTotal = emptyTotal();
  const weekTotal = emptyTotal();
  const monthTotal = emptyTotal();
  const byKind = new Map<string, { kind: string; calls: number; fails: number; totalTokens: number }>();
  const byDate = new Map<string, { date: string; calls: number; totalTokens: number }>();

  for (const r of rows) {
    const totalTokens = Number(r.promptTokens) + Number(r.completionTokens);
    const buckets = [monthTotal];
    if (r.date >= since7) buckets.push(weekTotal);
    if (r.date === today) buckets.push(todayTotal);
    for (const b of buckets) {
      b.calls += r.calls;
      b.fails += r.fails;
      b.promptTokens += Number(r.promptTokens);
      b.completionTokens += Number(r.completionTokens);
      b.totalTokens += totalTokens;
    }

    const k = byKind.get(r.kind) || { kind: r.kind, calls: 0, fails: 0, totalTokens: 0 };
    k.calls += r.calls;
    k.fails += r.fails;
    k.totalTokens += totalTokens;
    byKind.set(r.kind, k);

    const d = byDate.get(r.date) || { date: r.date, calls: 0, totalTokens: 0 };
    d.calls += r.calls;
    d.totalTokens += totalTokens;
    byDate.set(r.date, d);
  }

  return {
    today: todayTotal,
    days7: weekTotal,
    days30: monthTotal,
    byKind: [...byKind.values()].sort((a, b) => b.totalTokens - a.totalTokens || b.calls - a.calls),
    series: [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
  };
}
