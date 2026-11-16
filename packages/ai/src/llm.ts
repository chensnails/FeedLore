/**
 * 每用户模型配置（LLM）与 OpenAI 兼容调用。
 *
 * 三条与 legacy 一致、也不能改的语义：
 * 1. **模型配置只认账号自己那份**。站点级兜底（`settings.llm`）在 v1.4.0 就整层退场了：
 *    普通用户不该让自己的日报跑在别人选的模型上，管理员也不该替所有人决定。
 * 2. **apiKey 只在内存里是明文**。落库前换成 `enc.v1.*` 密文，视图层只回「是否设置 + 掩码」，
 *    绝不含明文，也不含密文。
 * 3. **出网必须走调用方注入的 fetch**。本包不接受「随便给个 URL 就请求」——
 *    `apps/server` 传进来的是 `lib/net.safeFetch`（SSRF 三道闸 + 逐跳重定向校验）。
 *    这里不自己实现一套，因为两套实现迟早会漂移，而漂移的那一套就是漏洞。
 */

import { maskSecret, decryptSecret, encryptSecret } from './crypto';
import type { LlmView } from '@feedlore/contract';

/** 调用方注入的出网实现（服务端传 `safeFetch`）。签名与全局 fetch 一致，便于直接透传。 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/* ---------------- 思考模式（reasoning） ---------------- */

/**
 * 三档深度 → `thinking_budget`（token）。
 *
 * 给的是「让它想多久」的预算，不是温度那种软约束。上限 8192 是刻意收的：
 * 再往上，日报这种小任务只会把定时调度拖到几分钟，收益递减。
 *
 * v2 侧表用整数档位（0~3），legacy 用 'low'|'medium'|'high'，对应关系：
 * 1=low / 2=medium / 3=high / 0 或越界 = medium。
 */
const THINKING_BUDGET: Record<number, number> = { 1: 512, 2: 2048, 3: 8192 };
export const THINKING_DEPTH_DEFAULT = 2;

export function normalizeThinkingDepth(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return THINKING_DEPTH_DEFAULT;
  const d = Math.trunc(n);
  return d >= 1 && d <= 3 ? d : THINKING_DEPTH_DEFAULT;
}

export const thinkingBudget = (depth: unknown): number => THINKING_BUDGET[normalizeThinkingDepth(depth)] ?? 2048;

/** 默认温度：legacy 同值。温度影响的是「选材发散度」，日报要稳定，所以偏低。 */
export const TEMPERATURE_DEFAULT = 0.3;

export function clampTemperature(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return TEMPERATURE_DEFAULT;
  return Math.min(1.5, Math.max(0, Math.round(n * 100) / 100));
}

/* ---------------- 行 ↔ 视图 ↔ 调用参数 ---------------- */

/** `user_llm` 表的一行（字段可空，因为首次保存时可能只填了其中几项）。 */
export interface LlmRow {
  encryptedKey: string | null;
  baseUrl: string | null;
  model: string | null;
  temperature?: number | null;
  thinking: boolean;
  thinkingDepth: number;
}

/** 真正拿去请求的形态：apiKey 是明文，解密失败按「没配」处理。 */
export interface ResolvedLlm {
  baseUrl: string;
  model: string;
  apiKey: string;
  temperature: number;
  thinking: boolean;
  thinkingDepth: number;
  thinkingBudget: number;
}

export function resolveUserLlm(row: LlmRow | undefined | null, cryptoSecret: string): ResolvedLlm {
  const depth = normalizeThinkingDepth(row?.thinkingDepth);
  return {
    baseUrl: (row?.baseUrl ?? '').trim(),
    model: (row?.model ?? '').trim(),
    // 解密空 = 换过 cryptoSecret 或从没配。两种都当「没配 Key」
    apiKey: row?.encryptedKey ? decryptSecret(row.encryptedKey, cryptoSecret) || '' : '',
    temperature: clampTemperature(row?.temperature ?? TEMPERATURE_DEFAULT),
    thinking: row?.thinking === true,
    thinkingDepth: depth,
    thinkingBudget: thinkingBudget(depth),
  };
}

/** 三项齐了才真能调模型；缺任何一项就不该排队生成，直接告诉用户去哪补。 */
export const llmComplete = (llm: Pick<ResolvedLlm, 'baseUrl' | 'apiKey' | 'model'>): boolean =>
  Boolean(llm.baseUrl && llm.apiKey && llm.model);

/** 回给前端的视图：含「是否设置 + 掩码」，绝不含明文 / 密文。 */
export function userLlmForView(row: LlmRow | undefined | null, cryptoSecret: string): LlmView {
  const enc = typeof row?.encryptedKey === 'string' ? row.encryptedKey : '';
  const set = Boolean(enc);
  return {
    baseUrl: row?.baseUrl ?? '',
    model: row?.model ?? '',
    temperature: clampTemperature(row?.temperature ?? TEMPERATURE_DEFAULT),
    thinking: row?.thinking === true,
    thinkingDepth: normalizeThinkingDepth(row?.thinkingDepth),
    apiKeySet: set,
    // 解密失败（换过 cryptoSecret 的老数据）掩码为空，但 apiKeySet 仍为 true：
    // 「存过但解不开」和「没存过」是两种状态，混在一起会让人以为配置还在
    apiKeyHint: set ? maskSecret(decryptSecret(enc, cryptoSecret)) : '',
  };
}

/**
 * 落库字段（部分更新语义：只返回调用方真的提交了的键）。
 *
 * `apiKey` 三态：字符串非空 → 新密文；空串 → 清除；未提交 → 不动。
 * 不区分这三种，前端「只改模型名」就会把已存的 Key 一起冲掉。
 */
export function userLlmForStore(
  raw: { apiKey?: string; baseUrl?: string; model?: string; temperature?: number; thinking?: boolean; thinkingDepth?: number },
  cryptoSecret: string,
): {
  encryptedKey?: string | null;
  baseUrl?: string | null;
  model?: string | null;
  temperature?: number;
  thinking?: boolean;
  thinkingDepth?: number;
} {
  const out: {
    encryptedKey?: string | null;
    baseUrl?: string | null;
    model?: string | null;
    temperature?: number;
    thinking?: boolean;
    thinkingDepth?: number;
  } = {};

  if (raw.apiKey !== undefined) {
    out.encryptedKey = raw.apiKey ? encryptSecret(raw.apiKey, cryptoSecret) : null;
  }
  if (raw.baseUrl !== undefined) out.baseUrl = raw.baseUrl.trim().replace(/\/+$/, '') || null;
  if (raw.model !== undefined) out.model = raw.model.trim() || null;
  if (raw.temperature !== undefined) out.temperature = clampTemperature(raw.temperature);
  if (raw.thinking !== undefined) out.thinking = raw.thinking === true;
  if (raw.thinkingDepth !== undefined) out.thinkingDepth = normalizeThinkingDepth(raw.thinkingDepth);
  return out;
}

/* ---------------- 调用 ---------------- */

/** 模型地址补全到 `/chat/completions`（用户填 base 或完整路径都认）。 */
export function llmEndpoint(baseUrl: string): string {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw aiError('E_AI_NOT_CONFIGURED', 'the model base URL is empty');
  if (/\/chat\/completions$/i.test(base)) return base;
  if (/\/v\d+$/i.test(base)) return base + '/chat/completions';
  return base + '/v1/chat/completions';
}

const clamp = (s: string, n: number): string => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};

/**
 * 把上游的错误响应体收拾成一句人话。
 *
 * 为什么必须处理：OpenAI 兼容接口在地址或路径不对时，返回的常常是 nginx 的
 * 404/502 **HTML 页面**。原样截 160 字塞进日报，用户看到的是
 * `<html xmlns=...><head><title>404-1</title><meta http-equiv=...` 这一大坨标签
 * （截图验证过：降级摘要的告警和概览里各来一遍，占掉半屏）。
 * HTML 就只取 `<title>`，其余按纯文本截断。
 */
/**
 * 失败原因统一带稳定错误码：`E_AI_XXX: <英文补充>`。
 *
 * 这些消息会原样进「模型状态」列表、单篇 AI 的结果区、MCP 的错误体 —— 只给英文，
 * 用户看不懂；只给中文，又丢掉了上游细节。所以码归前端词典（apps/web/src/core/errorText.js），
 * 英文补充作为冒号后缀拼在中文后面。**新增码必须两边同步。**
 */
export function aiError(code: string, detail?: string): Error {
  return new Error(detail ? `${code}: ${detail}` : code);
}

/**
 * 中断 / 超时的稳健判定。
 *
 * 踩过的坑：Node 的 undici 在 signal 被 abort 时抛的未必是 `name === 'AbortError'`——
 * 读取响应体途中中断会变成 `TypeError: terminated`，某些版本直接把
 * `signal is aborted without reason` 当 message 抛出来。只比 name 会漏，
 * 于是底层英文原样漏到界面上（用户截图反馈过）。
 */
export function isAbortError(e: unknown, depth = 0): boolean {
  if (!e || typeof e !== 'object' || depth > 2) return false;
  const err = e as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown };
  if (err.name === 'AbortError' || err.name === 'TimeoutError' || err.code === 'ABORT_ERR') return true;
  const msg = typeof err.message === 'string' ? err.message : '';
  // undici 读响应体时中断会抛 `TypeError: terminated`，同样归到「请求被中断」
  if (/\babort(ed)?\b/i.test(msg) || /\btimed? ?out\b/i.test(msg) || /\bterminated\b/i.test(msg)) return true;
  return isAbortError(err.cause, depth + 1);
}

function cleanUpstreamError(text: string): string {
  const t = String(text ?? '').trim();
  if (!t) return 'The upstream returned an empty response';
  if (/^<(!doctype|html|\?xml)/i.test(t)) {
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(t)?.[1]?.replace(/\s+/g, ' ').trim();
    return title ? `The upstream returned an HTML page (${clamp(title, 60)})` : 'The upstream returned an HTML page instead of JSON';
  }
  return clamp(t, 160);
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * 一次调用的 token 用量（OpenAI 兼容 `usage` 字段）。
 * 上游不返回 usage 时为 null —— 缺字段不能让整次调用失败。
 */
export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatResult {
  content: string;
  usage: ChatUsage | null;
}

/** 容错解析 `usage`：字段名兼容 OpenAI（prompt_tokens / completion_tokens）。 */
export function parseChatUsage(raw: unknown): ChatUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
  const promptTokens = num(u.prompt_tokens);
  const completionTokens = num(u.completion_tokens);
  const totalTokens = num(u.total_tokens) || promptTokens + completionTokens;
  if (!promptTokens && !completionTokens && !totalTokens) return null;
  return { promptTokens, completionTokens, totalTokens };
}

export interface ChatOptions {
  /** 拿到 usage 后的回调（用于用量统计；不抛错、不影响调用结果） */
  onUsage?: (usage: ChatUsage) => void;
  /** 覆盖配置里的温度；不传则用 `llm.temperature`。 */
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * 输出 token 上限（`max_tokens`）。
   * 不设时模型会「越写越多」——摘要生成 800 字、要点写成小作文，
   * 这些 completion token 直接变成用户的等待时间。单篇动作请显式给上限。
   */
  maxTokens?: number;
  /**
   * 输出为空（模型只吐了思考链、`content` 是空串）时是否自动重试一次。
   * 混合思考模型没收到 `/no_think` 时会这样，重试通常就能拿到正常答案。
   */
  retryOnEmpty?: boolean;
  /** 本次调用的**总**时长预算（含重试）；不传则 `timeoutMs × 尝试次数`。 */
  budgetMs?: number;
}

export const LLM_TIMEOUT_MS = 180_000;

/**
 * 把 fetch 的网络层失败收敛成稳定码。
 *
 * `fetch failed` / `ECONNREFUSED` 这类原文对用户毫无信息量：既不知道是地址写错、
 * 网络不通还是上游挂了。错误码交给前端词典，具体原因（`ENOTFOUND` 等）作 detail。
 */
function networkError(e: unknown): Error {
  const err = e as { message?: unknown; cause?: { code?: unknown; message?: unknown } };
  const cause = err?.cause ?? {};
  const detail =
    (typeof cause.code === 'string' && cause.code) ||
    (typeof cause.message === 'string' && cause.message) ||
    (typeof err?.message === 'string' && err.message) ||
    'unknown network error';
  return aiError('E_AI_NETWORK', clamp(String(detail), 120));
}

/** 已经是 `E_AI_*` 的错误原样上抛，避免被二次包成「网络错误」。 */
const isAiError = (e: unknown): boolean =>
  e instanceof Error && /^E_AI_[A-Z_]+/.test(e.message);

/**
 * 记录「不接受这些可选字段的上游」（按 host 记忆）。
 *
 * 思考开关各家写法不一样：vLLM / SiliconFlow 认 `chat_template_kwargs`，
 * 有的网关只认顶层 `enable_thinking`，还有的见到未知字段直接 400 UNKNOWN_FIELD。
 * 所以先按最通用的形态发；被拒就摘掉该字段重试，并记住这台上游，
 * 之后不再每次都白跑一趟 400。
 *
 * 注意这里是**进程内**记忆：重启后各试探一次，代价可接受；
 * 落库会让「上游升级后支持了」永久卡在旧结论上。
 */
const noThinkingField = new Set<string>();
const noBudgetField = new Set<string>();

const hostOf = (baseUrl: string): string => {
  try { return new URL(baseUrl).host; } catch { return baseUrl; }
};

/** 上游明确说「不认识这个字段」。 */
const isUnknownField = (e: unknown, field: string): boolean =>
  e instanceof Error
  && e.message.startsWith('E_AI_HTTP')
  && /UNKNOWN_FIELD|未知请求字段|unknown field/i.test(e.message)
  && e.message.includes(field);

/**
 * 调一次 OpenAI 兼容接口，取 `choices[0].message.content` 与 token 用量。
 *
 * 思考链（`reasoning_content`）是过程产物，日报不需要留档，所以丢掉。
 * 失败信息统一收敛成英文短句：上游的错误体常常是一大坨 HTML 或 JSON，
 * 原样抛给用户只会让人更困惑。
 *
 * 返回 `{ content, usage }`：usage 供「AI 用量」统计；上游不返回时是 null，
 * 不影响本次调用结果。
 */
export async function chat(
  messages: ChatMessage[],
  llm: ResolvedLlm,
  opts: ChatOptions & { fetchImpl: FetchLike },
): Promise<ChatResult> {
  const { baseUrl, apiKey, model } = llm;
  if (!baseUrl || !apiKey || !model) {
    throw aiError('E_AI_NOT_CONFIGURED', 'base URL, API key and model name are all required');
  }

  const temperature =
    opts.temperature !== undefined ? clampTemperature(opts.temperature) : clampTemperature(llm.temperature);

  const body: Record<string, unknown> = { model, temperature, messages };
  // 输出上限：不传就一直写到模型自己觉得够了，白等几十秒
  if (opts.maxTokens && opts.maxTokens > 0) body.max_tokens = Math.round(opts.maxTokens);

  /* 思考开关：**一个账号级配置，双向显式下发**。
   *
   * `llm.thinking` 来自 `user_llm.thinking`（设置 → 模型 →「模型思考」），默认 false。
   * 关的时候带 `enable_thinking: false`，开的时候带 `true` —— 不能只在「开」时发，
   * 那会让混合思考模型按自己的默认（通常是开）走，思考链照样吃掉几十秒。
   *
   * 实测（同一篇 3185 字）：带 false → 3.1/4.6/5.4 秒、completion 135~146；
   * 不带 → 55.9/75.6 秒、completion 3251~4131。
   *
   * 为什么不用 `chat_template_kwargs`：测试机的上游对它直接 400 UNKNOWN_FIELD。
   * 为什么还留着 system 提示里的 `/no_think`：那是对「只认文本指令」的模型的兜底，
   * 两条路不冲突（`thinkingDirective()` 在 server 侧按同一开关生成）。
   *
   * 上游不认这些字段时会 400，由下面循环摘掉重试（见 noThinkingField / noBudgetField）。 */
  const host = hostOf(baseUrl);
  if (!noThinkingField.has(host)) body.enable_thinking = llm.thinking === true;
  /* 开思考时才需要预算；不给就按上游模板自己的默认。 */
  if (llm.thinking && !noBudgetField.has(host)) body.thinking_budget = llm.thinkingBudget;

  const timeoutMs = opts.timeoutMs ?? LLM_TIMEOUT_MS;
  /** 总预算：空内容重试与字段降级都要落在同一个预算里，否则「90 秒上限」会被翻倍。 */
  const budget = opts.budgetMs ?? timeoutMs * (opts.retryOnEmpty ? 2 : 1);
  const deadline = Date.now() + budget;
  /* 步数上限 = 原始 1 次 + 字段降级 2 次（enable_thinking / thinking_budget）+ 空内容重试 1 次。
   * 每次降级都会 delete 一个字段，所以不可能无限循环。 */
  const maxSteps = 3 + (opts.retryOnEmpty ? 1 : 0);
  let emptyRetried = false;
  let lastErr: unknown = null;

  for (let step = 0; step < maxSteps; step += 1) {
    const remaining = deadline - Date.now();
    if (remaining < 1_000) break;
    try {
      return await chatOnce(body, llm, opts, Math.min(timeoutMs, remaining));
    } catch (e) {
      lastErr = e;
      /* ① 上游不认 `enable_thinking`：摘掉重量，并记住这台上游，立刻重来。 */
      if (isUnknownField(e, 'enable_thinking') && 'enable_thinking' in body) {
        delete body.enable_thinking;
        noThinkingField.add(host);
        continue;
      }
      /* ①b 上游不认 `thinking_budget`：只摘预算，思考开关本身仍然保留。 */
      if (isUnknownField(e, 'thinking_budget') && 'thinking_budget' in body) {
        delete body.thinking_budget;
        noBudgetField.add(host);
        continue;
      }
      /* ② 空内容：模型只吐了思考链，允许重试一次。 */
      if (
        opts.retryOnEmpty && !emptyRetried
        && e instanceof Error && e.message.startsWith('E_AI_NO_CONTENT')
      ) {
        emptyRetried = true;
        continue;
      }
      throw e;
    }
  }
  throw lastErr ?? aiError('E_AI_TIMEOUT', `no response within ${Math.max(1, Math.round(budget / 1000))}s`);
}

/** 发一次请求。重试、预算与 body 组装都在 `chat` 里，这里只管单次往返。 */
async function chatOnce(
  body: Record<string, unknown>,
  llm: ResolvedLlm,
  opts: ChatOptions & { fetchImpl: FetchLike },
  timeoutMs: number,
): Promise<ChatResult> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  // 调用方自己的 signal（比如请求被客户端断开）也要能中断这次出网
  const onAbort = (): void => ctl.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const resp = await opts.fetchImpl(llmEndpoint(llm.baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + llm.apiKey },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });

    const text = await resp.text();
    if (!resp.ok) {
      // 401/403 单独说清楚：这类错误 90% 是 Key 失效，让用户去改 Key 而不是查网络
      if (resp.status === 401 || resp.status === 403) {
        throw aiError('E_AI_AUTH', `${resp.status}, the API key is invalid or lacks permission`);
      }
      throw aiError('E_AI_HTTP', `${resp.status} ${cleanUpstreamError(text)}`);
    }

    let data: { choices?: Array<{ message?: { content?: string } }>; usage?: unknown };
    try {
      data = JSON.parse(text) as typeof data;
    } catch {
      throw aiError('E_AI_BAD_RESPONSE', 'the response is not valid JSON');
    }
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw aiError('E_AI_NO_CONTENT', 'the response has no content');
    const usage = parseChatUsage(data.usage);
    if (usage) {
      // 统计是旁路：回调里抛错不能把已经成功的模型调用变成失败
      try { opts.onUsage?.(usage); } catch { /* ignore */ }
    }
    return { content, usage };
  } catch (e) {
    if (isAiError(e)) throw e;
    if (isAbortError(e)) {
      /* 主动取消与「到点超时」是两件事：混成一句「超时」会让排障完全跑偏
       * （用户切走、服务端关闭连接时，模型其实没超时）。 */
      if (opts.signal?.aborted) throw aiError('E_AI_ABORTED', 'the request was cancelled');
      throw aiError('E_AI_TIMEOUT', `no response within ${Math.max(1, Math.round(timeoutMs / 1000))}s`);
    }
    throw networkError(e);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/** 从模型返回里稳健地取出 JSON（容忍 ```json 包裹与前后废话）。 */
export function extractJson(text: string): Record<string, unknown> {
  const t = String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) throw aiError('E_AI_BAD_RESPONSE', 'the model returned no JSON');
  try {
    return JSON.parse(t.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    throw aiError('E_AI_BAD_RESPONSE', 'the model returned malformed JSON');
  }
}

/**
 * 模型列表地址：与 `llmEndpoint` 同源推导（`/chat/completions` → `/models`）。
 * 用户填 base、`/v1` 还是完整对话路径，都落到同一个列表地址上。
 */
export function modelsEndpoint(baseUrl: string): string {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw aiError('E_AI_NOT_CONFIGURED', 'the model base URL is empty');
  const chat = base.replace(/\/chat\/completions$/i, '');
  if (chat !== base) return chat + '/models';
  if (/\/v\d+$/i.test(base)) return base + '/models';
  return base + '/v1/models';
}

/** 上游模型列表的容错解析：OpenAI 是 `{data:[{id}]}`，也有服务回 `{models:[...]}` 或裸数组。 */
export function parseModelList(raw: unknown): string[] {
  const pick = (v: unknown): string | null => {
    if (typeof v === 'string') return v.trim() || null;
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const id = o.id ?? o.name ?? o.model;
      return typeof id === 'string' && id.trim() ? id.trim() : null;
    }
    return null;
  };
  let arr: unknown = raw;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    arr = Array.isArray(o.data) ? o.data : Array.isArray(o.models) ? o.models : [];
  }
  if (!Array.isArray(arr)) return [];
  const out = new Set<string>();
  for (const item of arr) {
    const id = pick(item);
    if (id) out.add(id);
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

/**
 * 拉一次上游模型列表。失败抛错（由路由收敛成 `ok:false + error`）：
 * 不兼容的上游、Key 无效、网络不通是三种常见失败，这里只负责带上足够辨识的信息。
 */
export async function listModels(
  llm: Pick<ResolvedLlm, 'baseUrl' | 'apiKey'>,
  fetchImpl: FetchLike,
  timeoutMs = 20_000,
): Promise<string[]> {
  const { baseUrl, apiKey } = llm;
  if (!baseUrl || !apiKey) {
    throw aiError('E_AI_NOT_CONFIGURED', 'base URL and API key are both required');
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(modelsEndpoint(baseUrl), {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + apiKey, Accept: 'application/json' },
      signal: ctl.signal,
    });
    const text = await resp.text();
    if (!resp.ok) {
      if (resp.status === 401 || resp.status === 403) {
        throw aiError('E_AI_AUTH', `${resp.status}, the API key is invalid or lacks permission`);
      }
      throw aiError('E_AI_HTTP', `${resp.status} on /models, ${cleanUpstreamError(text)}`);
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw aiError('E_AI_BAD_RESPONSE', 'the /models response is not valid JSON');
    }
    const models = parseModelList(data);
    if (!models.length) throw aiError('E_AI_NO_MODELS', 'the upstream returned an empty model list');
    return models;
  } catch (e) {
    if (isAiError(e)) throw e;
    if (isAbortError(e)) {
      throw aiError('E_AI_TIMEOUT', `no response within ${Math.max(1, Math.round(timeoutMs / 1000))}s`);
    }
    throw networkError(e);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 连通性测试：真的走一遍保存后的请求形态（含思考指令）。
 * 失败不抛，返回 `{ok:false,error}` —— 这是给用户看的诊断，不是异常。
 */
export async function testLlm(
  llm: ResolvedLlm,
  fetchImpl: FetchLike,
  onUsage?: (usage: ChatUsage) => void,
): Promise<{ ok: boolean; error?: string; reply?: string }> {
  try {
    const { content } = await chat(
      [
        // 带上思考指令，让「测试模型」真的走一遍保存后的实际请求形态
        { role: 'system', content: '你是一个测试助手，只输出 JSON。' + (llm.thinking ? ' /think' : ' /no_think') },
        { role: 'user', content: '输出 {"ok": true, "msg": "连接正常"}' },
      ],
      llm,
      { temperature: 0, fetchImpl, timeoutMs: 45_000, onUsage },
    );
    const j = extractJson(content);
    return { ok: true, reply: typeof j.msg === 'string' ? j.msg : '连接正常' };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}
