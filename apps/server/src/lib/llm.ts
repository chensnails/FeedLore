/**
 * 每账号模型配置的读取与**按任务路由**（0015 多路提供商）。
 *
 * 收口原因：现在有 6 处入口要拿模型配置（单篇 AI / AI 标签 / 日报 / 探索 /
 * MCP / 测试连接），其中三处原本直接查 user_llm 表。若路由逻辑散在各处，
 * 定时调度器会绕过「能力开关」继续烧额度。所有入口一律走本文件的
 * `resolveLlmForTask`，由它统一判断开关、选提供商、回落默认槽。
 *
 * 本文件不碰密钥明文以外的事：`@feedlore/ai` 的 resolveUserLlm 负责解密与完整性。
 */

import { getCryptoSecret, type ResolvedLlm, resolveUserLlm } from '@feedlore/ai';
import type { AiCapability } from '@feedlore/contract';
import { type Db, type LlmRoutes, llmProviders, llmVendors, userLlm } from '@feedlore/db';
import { and, eq } from 'drizzle-orm';
import { ApiException } from './apiError';

/** 读该账号的 user_llm 行（默认槽 + 路由表）；没有则返回 undefined。 */
export async function loadLlmRow(
  db: Db,
  uid: string,
): Promise<
  | {
      encryptedKey: string | null;
      baseUrl: string | null;
      model: string | null;
      temperature?: number | null;
      thinking: boolean;
      thinkingDepth: number;
      routes: LlmRoutes;
    }
  | undefined
> {
  const [row] = await db
    .select({
      encryptedKey: userLlm.encryptedKey,
      baseUrl: userLlm.baseUrl,
      model: userLlm.model,
      temperature: userLlm.temperature,
      thinking: userLlm.thinking,
      thinkingDepth: userLlm.thinkingDepth,
      routes: userLlm.routes,
    })
    .from(userLlm)
    .where(eq(userLlm.userId, uid))
    .limit(1);
  return row;
}

/** 能力键 → 中文名（错误详情与界面用）。 */ export const CAPABILITY_LABEL: Record<
  AiCapability,
  string
> = {
  entry_ai: '单篇 AI',
  ai_tags: 'AI 标签',
  digest: '日报',
  explore: '探索问答',
  mcp: 'MCP',
  auto: '自动任务',
};

/** 把 jsonb 里的路由表安全地收敛成对象（前端结构不可信，逐键容错）。 */
export function safeRoutes(raw: unknown): LlmRoutes {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: LlmRoutes = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const r = v as Record<string, unknown>;
    const route: LlmRoutes[string] = {};
    if (typeof r.enabled === 'boolean') route.enabled = r.enabled;
    if (typeof r.providerId === 'string' && r.providerId) route.providerId = r.providerId;
    if (r.actions && typeof r.actions === 'object' && !Array.isArray(r.actions)) {
      const acts: Record<string, string> = {};
      for (const [ak, av] of Object.entries(r.actions as Record<string, unknown>)) {
        if (typeof av === 'string' && av) acts[ak] = av;
      }
      route.actions = acts;
    }
    out[k] = route;
  }
  return out;
}

/** 挑出本次要用的 providerId：动作级 > 能力级 > 'default'。 */
export function pickProviderId(routes: LlmRoutes, task: AiCapability, action?: string): string {
  const r = routes[task];
  if (!r) return 'default';
  if (action && r.actions?.[action]) return r.actions[action]!;
  return r.providerId || 'default';
}

/**
 * 能力是否开启的**唯一判定**（纯函数，解析器与调度器共用，也是单测入口）。
 * - 通用能力：默认开，仅 enabled === false 关闭（0015 兼容语义）；
 * - ai_tags：默认关，必须 enabled === true（0016 单开关收口，见下）。
 */
export function isRouteEnabled(routes: LlmRoutes, task: AiCapability): boolean {
  const enabled = routes[task]?.enabled;
  return task === 'ai_tags' ? enabled === true : enabled !== false;
}

/** 模型行 + 其厂商的连接信息。vendorId 为空 = 0017 回填前的旧行，按自身列兜底。 */
export interface ModelRow {
  id: string;
  encryptedKey: string | null;
  baseUrl: string | null;
  model: string | null;
  temperature: number | null;
  thinking: boolean;
  thinkingDepth: number;
  vendorId: string | null;
  vendorBaseUrl: string | null;
  vendorEncryptedKey: string | null;
}

const MODEL_COLUMNS = {
  id: llmProviders.id,
  encryptedKey: llmProviders.encryptedKey,
  baseUrl: llmProviders.baseUrl,
  model: llmProviders.model,
  temperature: llmProviders.temperature,
  thinking: llmProviders.thinking,
  thinkingDepth: llmProviders.thinkingDepth,
  vendorId: llmProviders.vendorId,
  vendorBaseUrl: llmVendors.baseUrl,
  vendorEncryptedKey: llmVendors.encryptedKey,
} as const;

/** 读指定模型（本人）。 */
export async function loadModelWithVendor(
  db: Db,
  uid: string,
  modelId: string,
): Promise<ModelRow | undefined> {
  const [row] = await db
    .select(MODEL_COLUMNS)
    .from(llmProviders)
    .leftJoin(llmVendors, eq(llmProviders.vendorId, llmVendors.id))
    .where(and(eq(llmProviders.id, modelId), eq(llmProviders.userId, uid)))
    .limit(1);
  return row;
}

/** 读默认模型（本人）。 */
export async function loadDefaultModel(db: Db, uid: string): Promise<ModelRow | undefined> {
  const [row] = await db
    .select(MODEL_COLUMNS)
    .from(llmProviders)
    .leftJoin(llmVendors, eq(llmProviders.vendorId, llmVendors.id))
    .where(and(eq(llmProviders.userId, uid), eq(llmProviders.isDefault, true)))
    .limit(1);
  return row;
}

/** 模型行 → 可请求配置：有厂商时连接信息以厂商为准（厂商清掉 Key 不能回落到旧列）。 */
export function resolveModelLlm(row: ModelRow, secret: string): ResolvedLlm {
  const hasVendor = Boolean(row.vendorId);
  return resolveUserLlm(
    {
      baseUrl: hasVendor ? row.vendorBaseUrl : row.baseUrl,
      encryptedKey: hasVendor ? row.vendorEncryptedKey : row.encryptedKey,
      model: row.model,
      temperature: row.temperature,
      thinking: row.thinking,
      thinkingDepth: row.thinkingDepth,
    },
    secret,
  );
}

/**
 * 按任务解析模型配置：开关判断 → 选模型 → 回落默认模型 → 旧默认槽。
 *
 * 回落链（任何一环缺失都继续往下，绝不因为删了一路就让全站 AI 崩掉）：
 *   1. 能力/动作绑定的模型行（llm_providers.id）；
 *   2. is_default=true 的模型行；
 *   3. user_llm 旧默认槽（0017 回填前的账号，保证无缝升级）。
 *
 * 关闭语义：routes[task].enabled === false 时抛 E_AI_DISABLED（403），
 * 服务端硬拦，API / MCP / 调度器都绕不过去。
 */
export async function resolveLlmForTask(
  db: Db,
  uid: string,
  task: AiCapability,
  action?: string,
): Promise<ResolvedLlm> {
  const secret = await getCryptoSecret(db);
  const base = await loadLlmRow(db, uid);
  const routes = safeRoutes(base?.routes);

  // 关闭语义：由 isRouteEnabled 统一判定（ai_tags 默认关，其它默认开）。
  if (!isRouteEnabled(routes, task)) {
    throw new ApiException('E_AI_DISABLED', { detail: CAPABILITY_LABEL[task] });
  }

  const wanted = pickProviderId(routes, task, action);
  if (wanted !== 'default') {
    const row = await loadModelWithVendor(db, uid, wanted);
    if (row) return resolveModelLlm(row, secret);
    // 引用了已删除的模型：不报错，走下面的默认回落。
  }

  const defaultRow = await loadDefaultModel(db, uid);
  if (defaultRow) return resolveModelLlm(defaultRow, secret);

  // 兼容旧数据：user_llm 三件套仍是默认槽。
  return resolveUserLlm(base ?? null, secret);
}

/**
 * 只判断开关（不解析模型），供调度器在遍历账号时快速跳过关闭的能力。
 * 不查 providers 表，比 resolveLlmForTask 轻。
 *
 * 语义分两档：
 * - 通用能力（entry_ai/digest/explore/mcp/auto）：enabled !== false，即**默认开**
 *   （routes 为空 = 全开走默认槽，这是 0015 定下的兼容语义）。
 * - ai_tags：**默认关**，必须 routes.ai_tags.enabled === true 才算开。
 *   原因：自动打标会给全库每篇条目烧一份模型额度，旧 prefs.aiTags 也是默认关；
 *   0016 把旧开关的开启状态平移进 routes，所以这里特判不会让老用户突然被扣额度。
 *   AI 标签现在是单一开关（routes.ai_tags），prefs.aiTags 已废弃。
 */
export async function isCapabilityEnabled(
  db: Db,
  uid: string,
  task: AiCapability,
): Promise<boolean> {
  const base = await loadLlmRow(db, uid);
  return isRouteEnabled(safeRoutes(base?.routes), task);
}
