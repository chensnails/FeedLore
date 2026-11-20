/* AI 异步任务的浏览器客户端：提交 + 轮询。
 *
 * 为什么要这一层：单篇生成实测 4~160 秒、日报可达数分钟，都长于网关的 100 秒读超时。
 * 改成「提交 → 轮询」后，每个请求都是短连接，超时与断线都不再等于任务失败。
 *
 * 约定（与服务端 lib/aiJobs.ts 对齐）：
 * - 提交 `POST /api/ai/jobs` 立即返回 `{ job: { id, status } }`；
 * - 之后每 `AI_JOB_POLL_MS` 取一次 `GET /api/ai/jobs/:id`；
 * - 状态单向：queued → running → succeeded | failed，**没有取消态**（刷新页面即放弃等待，
 *   任务在服务端照常跑完并写进模型状态列表）。
 * - 轮询到 succeeded/failed 即停止；超过 `maxMs` 仍未结束就按超时处理，
 *   但**任务本身没停** —— 提示文案要说清「可稍后在模型状态里看结果」。
 */

/** 轮询间隔：1.5 秒。服务端一次模型调用以秒计，再密只是浪费请求。 */
export const AI_JOB_POLL_MS = 1500;
/** 前几次轮询用更短的间隔：任务通常几秒内结束，先密后疏能把「看到结果」提前 1 秒多。 */
export const AI_JOB_FAST_POLL_MS = 400;
export const AI_JOB_FAST_POLLS = 3;
/** 前端等待上限：比服务端最长的单次预算（日报多批）再宽一点，超了只放弃等待，不取消任务。 */
export const AI_JOB_MAX_MS = 240_000;

import type { AiJob, AiJobBody, AiJobError, AiPollOpts, ApiErrorBody } from './types.ts';

/** 最小 core 依赖面：aiJob 只用 apiFetch 与 errText，避免依赖整个 core 单例类型。 */
type AiJobCore = {
  apiFetch: (url: string, opts?: Record<string, unknown>) => Promise<Response>;
  errText: (data: ApiErrorBody | null, fallback: string) => string;
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * 提交任务。失败抛错（message 里是已经翻译过的中文）：
 * 提交阶段就会返回 4xx —— 条目不存在、越权、日期非法、任务过多都在这里。
 */
export async function submitAiJob(core: AiJobCore, body: AiJobBody): Promise<AiJob> {
  const res = await core.apiFetch('/api/ai/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as ApiErrorBody & { job?: AiJob };
  if (!res.ok) throw new Error(core.errText(data, '提交 AI 任务失败'));
  const job = data && data.job;
  if (!job || !job.id) throw new Error('提交 AI 任务失败：服务端没有返回任务号');
  return job;
}

/**
 * 轮询到任务结束。onStatus 拿到新状态时回调（更新「排队中 / 生成中」）；
 * isCancelled 返回 true 就停轮询（组件卸载 / 用户切走）。
 * 成功返回完整 job（含 result）；失败 / 超时 / 中止抛带 job 字段的 Error。
 */
export async function pollAiJob(
  core: AiJobCore,
  jobId: string,
  opts: AiPollOpts = {},
): Promise<AiJob> {
  const onStatus = typeof opts.onStatus === 'function' ? opts.onStatus : null;
  const isCancelled = typeof opts.isCancelled === 'function' ? opts.isCancelled : () => false;
  const maxMs = Number(opts.maxMs) > 0 ? Number(opts.maxMs) : AI_JOB_MAX_MS;
  const startedAt = Date.now();
  let last: AiJob | null = null;
  let polls = 0;

  while (Date.now() - startedAt < maxMs) {
    if (isCancelled()) {
      const aborted: AiJobError = new Error('E_AI_ABORTED: the page stopped waiting');
      aborted.job = last;
      throw aborted;
    }
    const res = await core.apiFetch('/api/ai/jobs/' + encodeURIComponent(jobId));
    const data = (await res.json().catch(() => ({}))) as ApiErrorBody & { job?: AiJob };
    if (!res.ok) throw new Error(core.errText(data, '读取任务状态失败'));
    const job = data && data.job;
    if (!job) throw new Error('读取任务状态失败：响应里没有任务');
    last = job;
    if (onStatus) onStatus(job);
    if (job.status === 'succeeded') return job;
    if (job.status === 'failed') {
      const failed: AiJobError = new Error(job.error || 'AI 调用失败');
      failed.job = job;
      throw failed;
    }
    polls += 1;
    await sleep(polls <= AI_JOB_FAST_POLLS ? AI_JOB_FAST_POLL_MS : AI_JOB_POLL_MS);
  }
  const timeout: AiJobError = new Error(
    'E_AI_TIMEOUT: the task is still running after ' + Math.round(maxMs / 1000) + 's',
  );
  timeout.job = last;
  throw timeout;
}
