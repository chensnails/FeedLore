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
  if (!base) throw new Error('未配置模型地址');
  if (/\/chat\/completions$/i.test(base)) return base;
  if (/\/v\d+$/i.test(base)) return base + '/chat/completions';
  return base + '/v1/chat/completions';
}

const clamp = (s: string, n: number): string => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  /** 覆盖配置里的温度；不传则用 `llm.temperature`。 */
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export const LLM_TIMEOUT_MS = 180_000;

/**
 * 调一次 OpenAI 兼容接口，只取 `choices[0].message.content`。
 *
 * 思考链（`reasoning_content`）是过程产物，日报不需要留档，所以丢掉。
 * 失败信息统一收敛成中文短句：上游的错误体常常是一大坨 HTML 或 JSON，
 * 原样抛给用户只会让人更困惑。
 */
export async function chat(
  messages: ChatMessage[],
  llm: ResolvedLlm,
  opts: ChatOptions & { fetchImpl: FetchLike },
): Promise<string> {
  const { baseUrl, apiKey, model } = llm;
  if (!baseUrl || !apiKey || !model) {
    throw new Error('模型未配置完整（地址 / Key / 模型名）——到「设置 · 模型」补齐');
  }

  const temperature =
    opts.temperature !== undefined ? clampTemperature(opts.temperature) : clampTemperature(llm.temperature);

  const body: Record<string, unknown> = { model, temperature, messages };

  /* 开思考时把预算交给推理模板。`chat_template_kwargs` 是 vLLM / SiliconFlow 这类
   * OpenAI 兼容服务的透传口，模板里对应 enable_thinking 与 thinking_budget；
   * 不支持的上游会忽略这个字段（顶多没生效，不会因为未知键拒请求）。 */
  if (llm.thinking) {
    body.chat_template_kwargs = { enable_thinking: true, thinking_budget: llm.thinkingBudget };
  }

  const timeoutMs = opts.timeoutMs ?? LLM_TIMEOUT_MS;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  // 调用方自己的 signal（比如请求被客户端断开）也要能中断这次出网
  const onAbort = (): void => ctl.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const resp = await opts.fetchImpl(llmEndpoint(baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });

    const text = await resp.text();
    if (!resp.ok) {
      // 401/403 单独说清楚：这类错误 90% 是 Key 失效，让用户去改 Key 而不是查网络
      if (resp.status === 401 || resp.status === 403) {
        throw new Error(`模型拒绝鉴权（${resp.status}）：Key 无效或无权限`);
      }
      throw new Error(`模型返回 ${resp.status}：${clamp(text, 160)}`);
    }

    let data: { choices?: Array<{ message?: { content?: string } }> };
    try {
      data = JSON.parse(text) as typeof data;
    } catch {
      throw new Error('模型响应不是合法 JSON');
    }
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('模型响应缺少 content');
    return content;
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw new Error('模型请求超时');
    throw e;
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
  if (start < 0 || end <= start) throw new Error('模型未返回 JSON');
  return JSON.parse(t.slice(start, end + 1)) as Record<string, unknown>;
}

/**
 * 连通性测试：真的走一遍保存后的请求形态（含思考指令）。
 * 失败不抛，返回 `{ok:false,error}` —— 这是给用户看的诊断，不是异常。
 */
export async function testLlm(
  llm: ResolvedLlm,
  fetchImpl: FetchLike,
): Promise<{ ok: boolean; error?: string; reply?: string }> {
  try {
    const content = await chat(
      [
        // 带上思考指令，让「测试模型」真的走一遍保存后的实际请求形态
        { role: 'system', content: '你是一个测试助手，只输出 JSON。' + (llm.thinking ? ' /think' : ' /no_think') },
        { role: 'user', content: '输出 {"ok": true, "msg": "连接正常"}' },
      ],
      llm,
      { temperature: 0, fetchImpl, timeoutMs: 45_000 },
    );
    const j = extractJson(content);
    return { ok: true, reply: typeof j.msg === 'string' ? j.msg : '连接正常' };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}
