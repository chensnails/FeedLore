/**
 * 多路 AI 提供商的读写（0015）。prefsRoutes 只负责校验与编排，具体落库在这里。
 *
 * 关键约束：
 * - Key 三态（未提供=沿用、非空=换密文、空串=清除）复用 userLlmForStore；
 * - 视图绝不含明文/密文，只给 apiKeySet + 掩码；
 * - 每账号只允许一个 is_default，设新默认时先把旧的清掉（单事务）；
 * - 删除某路后，引用它的路由自动回落默认槽（解析器负责，不需要改 routes）；
 * - 路由表按能力键**合并**，不是整表替换，避免并发保存把别的键冲掉。
 */

import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { llmProviders, userLlm, type Db } from '@feedlore/db';
import type {
  LlmProviderInput,
  LlmProviderView,
  LlmRoutes,
  AiCapability,
} from '@feedlore/contract';
import {
  AI_CAPABILITIES,
  ENTRY_AI_ACTIONS,
} from '@feedlore/contract';
import {
  decryptSecret,
  encryptSecret,
  getCryptoSecret,
  maskSecret,
  clampTemperature,
  normalizeThinkingDepth,
  resolveUserLlm,
  type LlmRow,
  type ResolvedLlm,
} from '@feedlore/ai';
import { ApiException } from './apiError';
import { assertPublicHost } from './net';
import { safeRoutes } from './llm';

/** 提供商视图列表（不含明文 Key）。 */
export async function listLlmProviders(db: Db, uid: string): Promise<LlmProviderView[]> {
  const rows = await db
    .select()
    .from(llmProviders)
    .where(eq(llmProviders.userId, uid))
    .orderBy(llmProviders.createdAt);
  const secret = await getCryptoSecret(db);
  return rows.map((r) => {
    const enc = typeof r.encryptedKey === 'string' ? r.encryptedKey : '';
    const set = Boolean(enc);
    return {
      id: r.id,
      name: r.name || '',
      baseUrl: r.baseUrl || '',
      model: r.model || '',
      temperature: clampTemperature(r.temperature ?? 0.3),
      thinking: r.thinking === true,
      thinkingDepth: normalizeThinkingDepth(r.thinkingDepth),
      isDefault: r.isDefault === true,
      apiKeySet: set,
      apiKeyHint: set ? maskSecret(decryptSecret(enc, secret)) : '',
    };
  });
}

/** 读该账号的路由表（逐键容错，空表 = 全开 + 走默认槽）。 */
export async function loadLlmRoutes(db: Db, uid: string): Promise<LlmRoutes> {
  const [row] = await db
    .select({ routes: userLlm.routes })
    .from(userLlm)
    .where(eq(userLlm.userId, uid))
    .limit(1);
  const safe = safeRoutes(row?.routes);
  // 契约形状：只保留白名单能力键，缺省项补成「开启 + 默认槽」。
  const out: LlmRoutes = {};
  for (const cap of AI_CAPABILITIES) {
    const r = safe[cap] || {};
    out[cap] = {
      enabled: r.enabled !== false,
      providerId: r.providerId || 'default',
      ...(r.actions ? { actions: r.actions } : {}),
    };
  }
  return out;
}

/**
 * 合并路由表：只按提交的能力键覆盖，动作级键也逐项合并。
 * 校验 providerId 必须是 'default' 或本账号真实存在的行，防止指向别人的配置。
 */
export async function saveLlmRoutes(db: Db, uid: string, patch: LlmRoutes): Promise<LlmRoutes> {
  const current = await loadLlmRoutes(db, uid);
  const next: LlmRoutes = { ...current };
  for (const [key, val] of Object.entries(patch || {})) {
    if (!(AI_CAPABILITIES as readonly string[]).includes(key) || !val) continue;
    const cap = key as AiCapability;
    const prev = current[cap] || { enabled: true, providerId: 'default' };
    const merged: LlmRoutes[string] = { ...prev };
    if (typeof val.enabled === 'boolean') merged.enabled = val.enabled;
    if (typeof val.providerId === 'string' && val.providerId) merged.providerId = val.providerId;
    if (val.actions && typeof val.actions === 'object') {
      const acts: Record<string, string> = { ...(prev.actions || {}) };
      for (const [ak, av] of Object.entries(val.actions)) {
        if (!(ENTRY_AI_ACTIONS as readonly string[]).includes(ak)) continue;
        if (typeof av === 'string' && av) acts[ak] = av;
      }
      merged.actions = acts;
    }
    next[cap] = merged;
  }

  // 校验所有 providerId：'default' 或本账号存在的行。
  const ids = new Set<string>();
  for (const cap of AI_CAPABILITIES) {
    const r = next[cap];
    if (r?.providerId && r.providerId !== 'default') ids.add(r.providerId);
    for (const v of Object.values(r?.actions || {})) if (v !== 'default') ids.add(v);
  }
  if (ids.size) {
    const rows = await db
      .select({ id: llmProviders.id })
      .from(llmProviders)
      .where(and(eq(llmProviders.userId, uid), inArray(llmProviders.id, [...ids])));
    const real = new Set(rows.map((r) => r.id));
    for (const id of ids) {
      if (!real.has(id)) throw new ApiException('E_LLM_PROVIDER_NOT_FOUND', { detail: id });
    }
  }

  // user_llm 行可能不存在（老账号没配过模型）：要 upsert 出来再写 routes。
  await db
    .insert(userLlm)
    .values({ userId: uid, routes: next })
    .onConflictDoUpdate({ target: userLlm.userId, set: { routes: next, updatedAt: sql`now()` } });
  return next;
}

/** 新增或编辑一路提供商。返回其 id。 */
export async function upsertLlmProvider(db: Db, uid: string, input: LlmProviderInput): Promise<string> {
  const id = input.id || crypto.randomUUID();
  const secret = await getCryptoSecret(db);

  // baseUrl 是出网口：只在真的提交且非空时校验，避免编辑名称也被拦。
  if (input.baseUrl !== undefined && input.baseUrl.trim()) {
    try {
      await assertPublicHost(input.baseUrl.trim());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new ApiException('E_MODEL_URL_UNREACHABLE', { detail: msg });
    }
  }

  const set: Record<string, unknown> = {
    name: (input.name || '').trim().slice(0, 60),
    updatedAt: sql`now()`,
  };
  if (input.baseUrl !== undefined) set.baseUrl = input.baseUrl.trim().replace(/\/+$/, '') || null;
  if (input.model !== undefined) set.model = input.model.trim() || null;
  if (input.temperature !== undefined) set.temperature = clampTemperature(input.temperature);
  if (input.thinking !== undefined) set.thinking = input.thinking === true;
  if (input.thinkingDepth !== undefined) set.thinkingDepth = normalizeThinkingDepth(input.thinkingDepth);
  // Key 三态：未提供沿用原密文；非空换密文；空串清除。
  if (input.apiKey !== undefined) {
    set.encryptedKey = input.apiKey ? encryptSecret(input.apiKey, secret) : null;
  }

  if (input.id) {
    const [exists] = await db
      .select({ id: llmProviders.id })
      .from(llmProviders)
      .where(and(eq(llmProviders.id, id), eq(llmProviders.userId, uid)))
      .limit(1);
    if (!exists) throw new ApiException('E_LLM_PROVIDER_NOT_FOUND', { detail: id });
    await db
      .update(llmProviders)
      .set(set)
      .where(and(eq(llmProviders.id, id), eq(llmProviders.userId, uid)));
  } else {
    // 新增时若没给 apiKey，显式写 null（视图会显示「未设 Key」）。
    if (input.apiKey === undefined) set.encryptedKey = null;
    await db.insert(llmProviders).values({
      id,
      userId: uid,
      name: String(set.name ?? ''),
      baseUrl: (set.baseUrl as string | null) ?? null,
      model: (set.model as string | null) ?? null,
      temperature: (set.temperature as number | undefined) ?? null,
      thinking: (set.thinking as boolean | undefined) ?? false,
      thinkingDepth: (set.thinkingDepth as number | undefined) ?? 0,
      encryptedKey: (set.encryptedKey as string | null) ?? null,
      isDefault: false,
    });
  }

  if (input.isDefault === true) {
    // 单账号只允许一个默认：先清其它行，再标本行。
    await db
      .update(llmProviders)
      .set({ isDefault: false })
      .where(and(eq(llmProviders.userId, uid), ne(llmProviders.id, id)));
    await db
      .update(llmProviders)
      .set({ isDefault: true })
      .where(and(eq(llmProviders.id, id), eq(llmProviders.userId, uid)));
  }
  return id;
}

/**
 * 「测试连接 / 拉模型列表」用的配置解析：可指定测哪一路提供商。
 * 测试不受能力开关限制（关掉某能力也应能验证配置是否正确）。
 * 指定 providerId 但行不存在时抛 E_LLM_PROVIDER_NOT_FOUND；不传则回落默认槽。
 */
export async function resolveProviderForTest(
  db: Db,
  uid: string,
  providerId?: string,
): Promise<ResolvedLlm> {
  const secret = await getCryptoSecret(db);
  if (providerId && providerId !== 'default') {
    const [row] = await db
      .select()
      .from(llmProviders)
      .where(and(eq(llmProviders.id, providerId), eq(llmProviders.userId, uid)))
      .limit(1);
    if (!row) throw new ApiException('E_LLM_PROVIDER_NOT_FOUND', { detail: providerId });
    return resolveUserLlm(row as LlmRow, secret);
  }
  const [base] = await db.select().from(userLlm).where(eq(userLlm.userId, uid)).limit(1);
  if (base) {
    const [def] = await db
      .select()
      .from(llmProviders)
      .where(and(eq(llmProviders.userId, uid), eq(llmProviders.isDefault, true)))
      .limit(1);
    if (def) return resolveUserLlm(def as LlmRow, secret);
    return resolveUserLlm(base as LlmRow, secret);
  }
  return resolveUserLlm(null, secret);
}

/** 删除一路提供商（仅本人行）。引用它的路由由解析器自动回落默认槽。 */
export async function deleteLlmProvider(db: Db, uid: string, id: string): Promise<void> {
  const res = await db
    .delete(llmProviders)
    .where(and(eq(llmProviders.id, id), eq(llmProviders.userId, uid)))
    .returning({ id: llmProviders.id });
  if (!res.length) throw new ApiException('E_LLM_PROVIDER_NOT_FOUND', { detail: id });
}
