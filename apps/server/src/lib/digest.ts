/**
 * 日报的调度与「采集范围解析」。
 *
 * 为什么抽出来：路由（手动生成）和调度器（定时生成）必须用**同一套**范围解析，
 * 否则「定时按自定义范围、手动按全部」这种不一致会让用户以为日报漏了内容。
 *
 * 调度方式与 legacy 一致——**每分钟 tick 一次，逐个账号看它自己的时间到没到**。
 * 不用「每个账号一个定时器」：任何一次偏好修改都要重算定时器，而 tick 以「今天的日期」
 * 判断是否跑过，容器半夜重启也不会漏掉谁的那一次。
 */

import { eq, sql } from 'drizzle-orm';
import { feeds, userLlm, users, type Db } from '@feedlore/db';
import {
  getCryptoSecret,
  generateDigest,
  llmComplete,
  resolveUserLlm,
  shanghaiDate,
} from '@feedlore/ai';
import { userDigest, userLayout } from './prefs';
import { safeFetch } from './net';

const TICK_MS = 60 * 1000;

/**
 * 按账号的「摘要范围」解析本次要采集的频道。
 *
 * - `override`（手动生成时前端传的 feeds）优先，并裁剪到**本人拥有且启用**的频道内；
 * - 否则按 `cfg.mode`：`all` → null（不限制）、`enabled` → 仅开采集的、`custom` → 与本人频道交集。
 *
 * ⚠️ `null` 与 `[]` 语义不同：null = 不限范围；[] = 范围内一条也没有。
 * 把空数组当 null 会让「自定义范围里一个都没选」变成「抓全站」。
 */
export async function resolveDigestScope(
  db: Db,
  ownerId: string,
  override: number[] | null,
  cfg: { mode: string; feeds: number[] },
): Promise<number[] | null> {
  const owned = await db.select({ id: feeds.id, enabled: feeds.enabled }).from(feeds).where(eq(feeds.ownerId, ownerId));

  if (override && override.length) {
    const ok = new Set(owned.filter((f) => f.enabled).map((f) => f.id));
    return override.filter((id) => ok.has(id));
  }

  const mode = ['enabled', 'all', 'custom'].includes(cfg.mode) ? cfg.mode : 'enabled';
  if (mode === 'all') return null;
  if (mode === 'enabled') return owned.filter((f) => f.enabled).map((f) => f.id);
  const own = new Set(owned.map((f) => f.id));
  return cfg.feeds.filter((id) => own.has(id));
}

/** 上海时区的 HH:MM。服务端时区固定 UTC 时，直接比较「服务器本地 08:00」会差八小时。 */
function shanghaiHhmm(now: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).format(now);
}

/**
 * 标记「今天这轮处理过了」。
 *
 * 用 `jsonb_set` 精确改一个键，而不是「读 prefs → 合并 → 整份写回」：
 * 后者会把同一时间用户正在改的其他偏好覆盖掉（读改写竞态），而这句 UPDATE 是原子的。
 *
 * 顺序也很重要：**先落标记再干活**。宁可少跑一次，也不能让失败/降级的账号
 * 每分钟重跑一遍（模型调用是花钱的，而且会把上游限流打满）。
 */
async function markAutoDone(db: Db, uid: string, today: string): Promise<void> {
  await db.execute(sql`
    update users
       set prefs = jsonb_set(coalesce(prefs, '{}'::jsonb), '{digest,lastAuto}', to_jsonb(${today}::text)),
           updated_at = now()
     where id = ${uid}
  `);
}

/**
 * 一次 tick：找出「此刻该生成」的账号并逐个生成。
 *
 * 只把 `digest.auto = true` 的账号捞出来（用 SQL 过滤），否则每分钟要把全表 prefs
 * 拉回 JS 再判断——单用户无所谓，几十个账号时纯属浪费。
 */
export async function runDigestTick(db: Db, now: Date = new Date()): Promise<number> {
  const today = shanghaiDate(now);
  const hhmm = shanghaiHhmm(now);

  const rows = await db
    .select({ id: users.id, prefs: users.prefs })
    .from(users)
    .where(sql`${users.prefs}->'digest'->>'auto' = 'true'`);

  if (!rows.length) return 0;

  const secret = await getCryptoSecret(db);
  let done = 0;

  for (const u of rows) {
    try {
      // 关掉了日报入口的账号，定时也不该替他烧额度
      if (userLayout(u.prefs).digestEnabled === false) continue;

      const cfg = userDigest(u.prefs);
      if (!cfg.auto || cfg.time !== hhmm || cfg.lastAuto === today) continue;

      await markAutoDone(db, u.id, today);

      const [llmRow] = await db
        .select({
          encryptedKey: userLlm.encryptedKey,
          baseUrl: userLlm.baseUrl,
          model: userLlm.model,
          temperature: userLlm.temperature,
          thinking: userLlm.thinking,
          thinkingDepth: userLlm.thinkingDepth,
        })
        .from(userLlm)
        .where(eq(userLlm.userId, u.id))
        .limit(1);

      const llm = resolveUserLlm(llmRow ?? null, secret);

      if (!llmComplete(llm)) {
        console.log(`[digest] 用户 ${u.id} 到点但模型没配齐，跳过（今天不再重试）`);
        continue;
      }

      const scope = await resolveDigestScope(db, u.id, null, cfg);
      const r = await generateDigest({
        db,
        ownerId: u.id,
        feedIds: scope,
        force: true,
        llm,
        style: cfg.style,
        limits: { maxPerFeed: cfg.maxPerFeed, maxTotal: cfg.maxTotal, keepDays: cfg.keepDays },
        fetchImpl: safeFetch,
      });

      done += 1;
      console.log(
        `[digest] 用户 ${u.id} 已生成 ${r.digest.date} 摘要：` +
          `${r.digest.stats.kept}/${r.digest.stats.collected} 条，${r.digest.stats.feeds} 个频道` +
          (r.digest.fallback ? '（规则降级）' : `（${r.digest.model}）`),
      );
    } catch (e) {
      console.error(`[digest] 用户 ${u.id} 自动生成失败：` + ((e as Error)?.message ?? e));
    }
  }

  return done;
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startDigestScheduler(db: Db): void {
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    void runDigestTick(db).catch((e: unknown) =>
      console.error('[digest] 定时检查失败：', (e as Error)?.message ?? e),
    );
  }, TICK_MS);
  // 不阻止进程退出（测试 / 优雅停机时不用特意 clear）
  timer.unref?.();
  console.log('[digest] 自动生成按账号调度中：每分钟检查一次各自的开关与时间');
}

export function stopDigestScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
