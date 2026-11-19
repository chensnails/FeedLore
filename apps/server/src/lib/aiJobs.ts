/**
 * AI 异步任务（`ai_jobs`）的落库、进程内执行与状态流转。
 *
 * 设计取舍（2026-11-16，用户确认）：
 * - **新表 + 进程内执行 + 启动清扫**：提交即落库（queued），随即在本进程异步执行；
 *   进程重启时残留的 queued/running 会被 `markInterruptedJobs` 标成 failed
 *   「服务重启，任务已中断」，前端不会一直转圈。
 * - 不引入独立 worker：单容器部署，多一个循环就多一处「重复执行」的竞态；
 *   真要横向扩容再改成「抢占式领取」，现在的表结构已经够用（status 列 + 索引）。
 * - 状态单向：queued → running → succeeded / failed，**不回退**。
 *
 * 为什么需要异步：单篇生成实测 4~160 秒、日报可达数分钟，都长于 Cloudflare
 * 的 100 秒代理读超时。提交请求从此是毫秒级短连接，网关超时不再生效。
 */

import type { AiJob, AiJobBody, ExploreHistory } from '@feedlore/contract';
import { type AiJobRow, aiJobs, type Db } from '@feedlore/db';
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import {
  execDigest,
  execEntryAi,
  execEntryTags,
  execExplore,
  isRealDate,
  loadOwnedEntry,
} from './aiTasks';
import { ApiException } from './apiError';
import { log } from './logger';

/** 同一账号同时排队/运行的任务上限。超了直接 429，别让「连点五次」变成五个并发模型调用。 */
export const AI_JOB_MAX_ACTIVE = 4;

/** 任务保留：结束后 2 天内可查，之后随下次提交顺带删掉。 */
const AI_JOB_KEEP_DAYS = 2;

/** 前端约定轮询间隔（毫秒），随任务一起下发，移动端/脚本可照此节流。 */
export const AI_JOB_POLL_MS = 1_500;

/** 业务错误最多保留这么多字符，避免把整段上游 HTML 塞进列表。 */
const ERROR_MAX = 500;

const clip = (s: unknown, n: number): string => {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};

/** 行 → 契约视图。`durationMs` 运行中算到「现在」，结束后是总时长。 */
export function toJobView(row: AiJobRow, now = Date.now()): AiJob {
  const created = row.createdAt.getTime();
  const endedAt = row.finishedAt ? row.finishedAt.getTime() : now;
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    label: row.label,
    result: row.result ?? null,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    durationMs: Math.max(0, endedAt - created),
  };
}

/**
 * 原子准入：同一账号的并发提交串行化，只有活跃任务 < 上限时才插入。
 *
 * 为什么不能用单条 `INSERT … SELECT … WHERE count < N`：READ COMMITTED 下每个事务
 * 看到自己的 snapshot，并发事务都读不到别人未提交的新行，8 并发实测仍放进 5 个。
 * 这里用 PostgreSQL advisory lock 按 userId 派生锁键：同账号事务排队、不同账号并行，
 * 事务内 count + insert 对后续事务可见，上限才真正成立。锁随事务结束自动释放。
 */
async function insertIfUnderLimit(
  db: Db,
  values: {
    id: string;
    userId: string;
    kind: string;
    label: string;
    input: Record<string, unknown>;
  },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    // hashtext → int4，advisory lock 接受两个 int4（这里第二参固定 0）
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${values.userId}), 0)`);
    const [row] = await tx
      .select({ n: count() })
      .from(aiJobs)
      .where(and(eq(aiJobs.userId, values.userId), inArray(aiJobs.status, ['queued', 'running'])));
    if (Number(row?.n ?? 0) >= AI_JOB_MAX_ACTIVE) return false;
    await tx.insert(aiJobs).values({
      id: values.id,
      userId: values.userId,
      kind: values.kind as 'entry_ai' | 'ai_tags' | 'digest',
      status: 'queued',
      label: values.label,
      input: values.input,
    });
    return true;
  });
}

/** 顺带清理过期任务：失败不影响提交。 */
async function pruneOldJobs(db: Db, uid: string): Promise<void> {
  try {
    // 常量直接进 SQL（不是用户输入，走 sql.raw 更省一个占位符的类型推断问题）
    await db.execute(
      sql`delete from ai_jobs where user_id = ${uid} and created_at < now() - ${sql.raw(`interval '${AI_JOB_KEEP_DAYS} days'`)}`,
    );
  } catch {
    /* 清理是旁路 */
  }
}

/**
 * 失败原因带上稳定码：前端词典按 `E_*` 翻译，没有码就只能看到英文。
 * `ApiException.message` 已经是英文说明，`code` 才是给界面看的键。
 */
function jobErrorMessage(e: unknown): string {
  if (e instanceof ApiException) return `${e.code}: ${e.message}`;
  return clip((e as Error)?.message ?? String(e), ERROR_MAX);
}

/**
 * 提交一个任务并立即返回（真正的执行在 `setImmediate` 里）。
 *
 * 提交阶段就把能快速判定的错误判掉（条目不存在 / 没权限 / 日期非法 / 任务过多），
 * 让调用方马上拿到 4xx —— 比「先收下、再在轮询里报失败」清楚得多。
 */
export async function createJob(db: Db, uid: string, body: AiJobBody): Promise<AiJobRow> {
  const kind = body.kind;

  let label = '';
  let entryId: number | null = null;
  let action: 'summary' | 'keypoints' | 'translate' | 'explain' = body.action ?? 'summary';
  let date = '';

  if (kind === 'entry_ai' || kind === 'ai_tags') {
    const n = Number(body.entryId);
    if (!Number.isInteger(n) || n <= 0) throw new ApiException('E_ENTRY_NOT_FOUND');
    entryId = n;
    // 提交时校验 owner 并取标题：既做标签，也把「找不到条目」提前到提交阶段
    const entry = await loadOwnedEntry(db, uid, n);
    label = kind === 'ai_tags' ? 'AI 标签' : (entry.title ?? '').trim() || '单篇 AI';
    if (kind === 'ai_tags') action = 'summary';
  } else if (kind === 'explore') {
    const q = (body.question ?? '').trim();
    if (!q) throw new ApiException('E_EXPLORE_EMPTY_QUESTION');
    label = `探索：${q.slice(0, 40)}`;
  } else {
    date = (body.date ?? '').trim();
    if (date && !isRealDate(date)) throw new ApiException('E_DATE_INVALID');
    label = date ? `日报 ${date}` : '日报';
  }

  const input: Record<string, unknown> = {};
  if (entryId != null) input.entryId = entryId;
  if (kind === 'entry_ai') {
    input.action = action;
    if (body.targetLang) input.targetLang = body.targetLang;
  }
  if (kind === 'digest') {
    if (date) input.date = date;
    if (body.force === true) input.force = true;
    if (Array.isArray(body.feeds) && body.feeds.length) input.feeds = body.feeds;
  }
  if (kind === 'explore') {
    input.question = (body.question ?? '').trim();
    if (Array.isArray(body.history) && body.history.length) input.history = body.history;
  }

  const id = crypto.randomUUID();
  // 原子准入：超限返回 false → 429。绝不能拆成「先 count 再 insert」，并发会绕过。
  const inserted = await insertIfUnderLimit(db, {
    id,
    userId: uid,
    kind,
    label: clip(label, 120),
    input,
  });
  if (!inserted) throw new ApiException('E_AI_BUSY');

  await pruneOldJobs(db, uid);

  /* setImmediate：先把响应交回去，再开始跑模型。
   * 不用 `void runJob(...)` 直接调用 —— 那会在同一个微任务链里先跑一阵子，
   * 慢一点的模型会让「立即返回」变成「等几百毫秒」。 */
  setImmediate(() => {
    void runJob(db, id).catch((e) => {
      log.warn(`[ai-job] ${id} crashed outside handler:`, (e as Error)?.message ?? e);
    });
  });

  // db.execute 的 RETURNING 是 raw snake_case 行；重新读一条规范化的 AiJobRow 给 toJobView
  return (await readJobRow(db, uid, id))!;
}

async function readJobRow(db: Db, uid: string, id: string): Promise<AiJobRow | null> {
  const [row] = await db
    .select()
    .from(aiJobs)
    .where(and(eq(aiJobs.id, id), eq(aiJobs.userId, uid)))
    .limit(1);
  return row ?? null;
}

/** 读任务（owner 隔离：拿别人的 id 一律当作不存在）。 */
export async function readJob(db: Db, uid: string, id: string): Promise<AiJob | null> {
  const row = await readJobRow(db, uid, String(id ?? ''));
  return row ? toJobView(row) : null;
}

/**
 * 执行一个任务。所有异常都在这里收敛成 `failed` 状态，绝不外抛 ——
 * 任务失败是正常业务结果，不是进程级错误。
 */
export async function runJob(db: Db, id: string): Promise<void> {
  /* 抢占：只有 queued 能被改成 running。
   * 多实例或重复调度时，抢不到就直接退出（同一任务不会跑两遍）。 */
  const [job] = await db
    .update(aiJobs)
    .set({ status: 'running', startedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(aiJobs.id, id), eq(aiJobs.status, 'queued')))
    .returning();
  if (!job) return;

  const input = (job.input ?? {}) as Record<string, unknown>;
  const entryId = Number(input.entryId);

  try {
    let result: unknown;
    if (job.kind === 'entry_ai') {
      const action = (typeof input.action === 'string' ? input.action : 'summary') as
        | 'summary'
        | 'keypoints'
        | 'translate'
        | 'explain';
      const targetLang = typeof input.targetLang === 'string' ? input.targetLang : undefined;
      result = await execEntryAi(db, job.userId, { entryId, action, targetLang });
    } else if (job.kind === 'ai_tags') {
      result = await execEntryTags(db, job.userId, entryId);
    } else if (job.kind === 'digest') {
      result = await execDigest(db, job.userId, {
        date: typeof input.date === 'string' ? input.date : undefined,
        force: input.force === true,
        feeds: Array.isArray(input.feeds) ? (input.feeds as number[]) : null,
      });
    } else if (job.kind === 'explore') {
      result = await execExplore(db, job.userId, {
        question: typeof input.question === 'string' ? input.question : '',
        history: Array.isArray(input.history) ? (input.history as ExploreHistory) : [],
      });
    } else {
      throw new Error(`Unknown AI job kind: ${job.kind}`);
    }

    await db
      .update(aiJobs)
      .set({
        status: 'succeeded',
        result: result as object,
        error: '',
        finishedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(eq(aiJobs.id, id));
  } catch (e) {
    const message = jobErrorMessage(e) || 'AI 调用失败';
    try {
      await db
        .update(aiJobs)
        .set({ status: 'failed', error: message, finishedAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(aiJobs.id, id));
    } catch (inner) {
      log.warn(`[ai-job] ${id} failed to record error:`, (inner as Error)?.message ?? inner);
    }
  }
}

/**
 * 启动清扫：把上次进程残留的 queued / running 标成 failed。
 *
 * 不做「自动续跑」是刻意的：模型调用不是幂等操作（一次未必是同一份结果），
 * 而且用户此刻很可能已经重试过了。如实标失败、让前端提示「重新提交」最不容易出错。
 */
export async function markInterruptedJobs(db: Db): Promise<number> {
  try {
    const rows = await db
      .update(aiJobs)
      .set({
        status: 'failed',
        error: 'E_AI_JOB_RESTARTED: the service restarted before the task finished',
        finishedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(inArray(aiJobs.status, ['queued', 'running']))
      .returning({ id: aiJobs.id });
    if (rows.length) log.info(`[ai-job] marked ${rows.length} interrupted task(s) as failed`);
    return rows.length;
  } catch (e) {
    // 表还没建（迁移未跑）时不要阻断启动
    log.warn('[ai-job] startup sweep skipped:', (e as Error)?.message ?? e);
    return 0;
  }
}
