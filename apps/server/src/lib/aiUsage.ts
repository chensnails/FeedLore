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

import { and, eq, gte } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { aiUsageDaily, type Db } from '@feedlore/db';
import { shanghaiDate } from '@feedlore/ai';

/** 功能分类。新增调用点时必须在这里登记，否则前端「按功能」里看不到。 */
export const AI_USAGE_KINDS = ['digest', 'entry_ai', 'ai_tags', 'mcp', 'test'] as const;
export type AiUsageKind = (typeof AI_USAGE_KINDS)[number];

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

/**
 * 记一次调用。`ok=false` 时 calls 与 fails 同时 +1（失败也是一次尝试）。
 * 不抛错：调用方不需要 try/catch。
 */
export async function recordAiUsage(
  db: Db,
  userId: string,
  kind: AiUsageKind,
  usage: UsageLike | null | undefined,
  ok = true,
  /** 本次要记的调用次数（日报 map-reduce 一轮会调多次；失败一次传 1 即可） */
  calls = 1,
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
