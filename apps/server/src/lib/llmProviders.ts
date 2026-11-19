/**
 * AI 厂商与模型的读写（0017 起拆成两层）。
 *
 * 厂商 = 名称 + baseUrl + 加密 Key（llm_vendors），可被多个模型复用；
 * 模型 = vendorId + 模型名 + 温度/思考（llm_providers）。
 * 任务路由里的 providerId 仍指向模型 id —— 0017 的回填保留了原行 id，
 * 因此历史路由不需要任何改写。
 *
 * 关键约束：
 * - Key 三态（未提供=沿用、非空=换密文、空串=清除）只作用于厂商；
 * - 视图绝不含明文/密文，只给 apiKeySet + 掩码；
 * - 每账号只允许一个 is_default 模型；
 * - 删除厂商会级联删除其模型，路由解析器对悬空 id 自动回落；
 * - 路由表按能力键**合并**，不是整表替换，避免并发保存把别的键冲掉。
 */

import {
  clampTemperature,
  decryptSecret,
  encryptSecret,
  getCryptoSecret,
  maskSecret,
  normalizeThinkingDepth,
  type ResolvedLlm,
  resolveUserLlm,
} from '@feedlore/ai';
import type {
  AiCapability,
  LlmModelInput,
  LlmModelView,
  LlmRoutes,
  LlmVendorInput,
  LlmVendorView,
} from '@feedlore/contract';
import { AI_CAPABILITIES, ENTRY_AI_ACTIONS } from '@feedlore/contract';
import { type Db, llmProviders, llmVendors, userLlm } from '@feedlore/db';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { ApiException } from './apiError';
import {
  loadDefaultModel,
  loadLlmRow,
  loadModelWithVendor,
  resolveModelLlm,
  safeRoutes,
} from './llm';
import { assertPublicHost } from './net';

/** 地址 → 展示名：没有手填名称时用主机名（tokenrhythm.studio 这种一眼能认）。 */
export function vendorLabel(name: string, baseUrl: string): string {
  const trimmed = String(name || '').trim();
  if (trimmed) return trimmed;
  const host = String(baseUrl || '')
    .replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
    .split('/')[0];
  return host || '未命名厂商';
}

/** 厂商列表（不含明文 Key），附带模型数量。 */
export async function listLlmVendors(db: Db, uid: string): Promise<LlmVendorView[]> {
  const rows = await db
    .select({
      id: llmVendors.id,
      name: llmVendors.name,
      baseUrl: llmVendors.baseUrl,
      encryptedKey: llmVendors.encryptedKey,
      modelCount: sql<number>`(select count(*)::int from ${llmProviders} where ${llmProviders.vendorId} = ${llmVendors.id})`,
    })
    .from(llmVendors)
    .where(eq(llmVendors.userId, uid))
    .orderBy(asc(llmVendors.createdAt));
  const secret = await getCryptoSecret(db);
  return rows.map((r) => {
    const enc = typeof r.encryptedKey === 'string' ? r.encryptedKey : '';
    const set = Boolean(enc);
    return {
      id: r.id,
      name: vendorLabel(r.name, r.baseUrl),
      baseUrl: r.baseUrl || '',
      modelCount: Number(r.modelCount) || 0,
      apiKeySet: set,
      apiKeyHint: set ? maskSecret(decryptSecret(enc, secret)) : '',
    };
  });
}

/** 模型列表：连接信息若挂在厂商上，以厂商为准；旧行回落到自身列。 */
export async function listLlmModels(db: Db, uid: string): Promise<LlmModelView[]> {
  const rows = await db
    .select({
      id: llmProviders.id,
      vendorId: llmProviders.vendorId,
      name: llmProviders.name,
      model: llmProviders.model,
      temperature: llmProviders.temperature,
      thinking: llmProviders.thinking,
      thinkingDepth: llmProviders.thinkingDepth,
      isDefault: llmProviders.isDefault,
      legacyBaseUrl: llmProviders.baseUrl,
      legacyKey: llmProviders.encryptedKey,
      vendorBaseUrl: llmVendors.baseUrl,
      vendorName: llmVendors.name,
      vendorKey: llmVendors.encryptedKey,
    })
    .from(llmProviders)
    .leftJoin(llmVendors, eq(llmProviders.vendorId, llmVendors.id))
    .where(eq(llmProviders.userId, uid))
    .orderBy(asc(llmProviders.createdAt));
  const secret = await getCryptoSecret(db);
  return rows.map((r) => {
    const hasVendor = Boolean(r.vendorId);
    const baseUrl = (hasVendor ? r.vendorBaseUrl : r.legacyBaseUrl) || '';
    const enc = (hasVendor ? r.vendorKey : r.legacyKey) || '';
    return {
      id: r.id,
      vendorId: r.vendorId || '',
      vendorName: vendorLabel(r.vendorName || '', baseUrl),
      name: r.name || '',
      baseUrl,
      model: r.model || '',
      temperature: clampTemperature(r.temperature ?? 0.3),
      thinking: r.thinking === true,
      thinkingDepth: normalizeThinkingDepth(r.thinkingDepth),
      isDefault: r.isDefault === true,
      apiKeySet: Boolean(enc),
      apiKeyHint: enc ? maskSecret(decryptSecret(enc, secret)) : '',
    };
  });
}

/** 新增或编辑厂商。返回其 id。 */
export async function upsertLlmVendor(db: Db, uid: string, input: LlmVendorInput): Promise<string> {
  const id = input.id || crypto.randomUUID();
  const secret = await getCryptoSecret(db);

  const set: Record<string, unknown> = { updatedAt: sql`now()` };
  if (input.name !== undefined)
    set.name = String(input.name || '')
      .trim()
      .slice(0, 60);
  if (input.baseUrl !== undefined) {
    const url = String(input.baseUrl || '')
      .trim()
      .replace(/\/+$/, '');
    if (!url) throw new ApiException('E_MODEL_INCOMPLETE', { detail: 'vendor.baseUrl' });
    // 地址是出网口：与测试连接、导入同一条 SSRF 基线
    try {
      await assertPublicHost(url);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new ApiException('E_MODEL_URL_UNREACHABLE', { detail: msg });
    }
    set.baseUrl = url;
  }
  // Key 三态：未提供沿用原密文；非空换密文；空串清除。
  if (input.apiKey !== undefined) {
    set.encryptedKey = input.apiKey ? encryptSecret(input.apiKey, secret) : null;
  }

  if (input.id) {
    const [exists] = await db
      .select({ id: llmVendors.id })
      .from(llmVendors)
      .where(and(eq(llmVendors.id, id), eq(llmVendors.userId, uid)))
      .limit(1);
    if (!exists) throw new ApiException('E_LLM_PROVIDER_NOT_FOUND', { detail: id });
    await db
      .update(llmVendors)
      .set(set)
      .where(and(eq(llmVendors.id, id), eq(llmVendors.userId, uid)));
  } else {
    if (!set.baseUrl) throw new ApiException('E_MODEL_INCOMPLETE', { detail: 'vendor.baseUrl' });
    await db.insert(llmVendors).values({
      id,
      userId: uid,
      name: String(set.name ?? ''),
      baseUrl: String(set.baseUrl),
      encryptedKey: (set.encryptedKey as string | null) ?? null,
    });
  }
  return id;
}

/** 删除厂商（仅本人行）。其模型级联删除；默认模型缺失时自动补一个。 */
export async function deleteLlmVendor(db: Db, uid: string, id: string): Promise<void> {
  const res = await db
    .delete(llmVendors)
    .where(and(eq(llmVendors.id, id), eq(llmVendors.userId, uid)))
    .returning({ id: llmVendors.id });
  if (!res.length) throw new ApiException('E_LLM_PROVIDER_NOT_FOUND', { detail: id });
  await ensureDefaultModel(db, uid);
}

/** 新增或编辑模型。返回其 id。 */
export async function upsertLlmModel(db: Db, uid: string, input: LlmModelInput): Promise<string> {
  const id = input.id || crypto.randomUUID();
  const vendorId = String(input.vendorId || '').trim();
  if (!vendorId) throw new ApiException('E_MODEL_INCOMPLETE', { detail: 'model.vendorId' });

  const [vendor] = await db
    .select({ id: llmVendors.id })
    .from(llmVendors)
    .where(and(eq(llmVendors.id, vendorId), eq(llmVendors.userId, uid)))
    .limit(1);
  if (!vendor) throw new ApiException('E_LLM_PROVIDER_NOT_FOUND', { detail: vendorId });

  const model = String(input.model || '').trim();
  if (!model) throw new ApiException('E_MODEL_INCOMPLETE', { detail: 'model.model' });

  const set: Record<string, unknown> = {
    vendorId,
    model,
    updatedAt: sql`now()`,
  };
  if (input.name !== undefined)
    set.name = String(input.name || '')
      .trim()
      .slice(0, 60);
  if (input.temperature !== undefined) set.temperature = clampTemperature(input.temperature);
  if (input.thinking !== undefined) set.thinking = input.thinking === true;
  if (input.thinkingDepth !== undefined)
    set.thinkingDepth = normalizeThinkingDepth(input.thinkingDepth);

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
    await db.insert(llmProviders).values({
      id,
      userId: uid,
      vendorId,
      name: String(set.name ?? ''),
      model,
      temperature: input.temperature === undefined ? null : clampTemperature(input.temperature),
      thinking: input.thinking === true,
      thinkingDepth:
        input.thinkingDepth === undefined ? 0 : normalizeThinkingDepth(input.thinkingDepth),
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
  } else {
    await ensureDefaultModel(db, uid);
  }
  return id;
}

/** 删除模型（仅本人行）。引用它的路由由解析器自动回落；默认模型缺失时自动补一个。 */
export async function deleteLlmModel(db: Db, uid: string, id: string): Promise<void> {
  const res = await db
    .delete(llmProviders)
    .where(and(eq(llmProviders.id, id), eq(llmProviders.userId, uid)))
    .returning({ id: llmProviders.id });
  if (!res.length) throw new ApiException('E_LLM_PROVIDER_NOT_FOUND', { detail: id });
  await ensureDefaultModel(db, uid);
}

/** 没有默认模型时，把最早创建的模型补成默认（删默认 / 首次添加都会走到）。 */
export async function ensureDefaultModel(db: Db, uid: string): Promise<void> {
  const [has] = await db
    .select({ id: llmProviders.id })
    .from(llmProviders)
    .where(and(eq(llmProviders.userId, uid), eq(llmProviders.isDefault, true)))
    .limit(1);
  if (has) return;
  const [first] = await db
    .select({ id: llmProviders.id })
    .from(llmProviders)
    .where(eq(llmProviders.userId, uid))
    .orderBy(asc(llmProviders.createdAt))
    .limit(1);
  if (!first) return;
  await db
    .update(llmProviders)
    .set({ isDefault: true })
    .where(and(eq(llmProviders.id, first.id), eq(llmProviders.userId, uid)));
}

/** 读该账号的路由表（逐键容错，空表 = 全开 + 走默认模型）。 */
export async function loadLlmRoutes(db: Db, uid: string): Promise<LlmRoutes> {
  const [row] = await db
    .select({ routes: userLlm.routes })
    .from(userLlm)
    .where(eq(userLlm.userId, uid))
    .limit(1);
  const safe = safeRoutes(row?.routes);
  // 契约形状：只保留白名单能力键，缺省项补成「开启 + 默认模型」。
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
 * 校验 providerId 必须是 'default' 或本账号真实存在的模型，防止指向别人的配置。
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

  // 校验所有 providerId：'default' 或本账号存在的模型。
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

/**
 * 「测试连接 / 拉模型列表」用的配置解析。
 * - modelId：测指定模型；
 * - 不传：默认模型 → 旧默认槽（未迁移账号）。
 * 测试不受能力开关限制（关掉某能力也应能验证配置是否正确）。
 */
export async function resolveModelForTest(
  db: Db,
  uid: string,
  modelId?: string,
): Promise<ResolvedLlm> {
  const secret = await getCryptoSecret(db);
  if (modelId) {
    const row = await loadModelWithVendor(db, uid, modelId);
    if (!row) throw new ApiException('E_LLM_PROVIDER_NOT_FOUND', { detail: modelId });
    return resolveModelLlm(row, secret);
  }
  const def = await loadDefaultModel(db, uid);
  if (def) return resolveModelLlm(def, secret);
  const base = await loadLlmRow(db, uid);
  return resolveUserLlm(base ?? null, secret);
}

/** 「拉上游模型列表」只需要厂商的连接信息；vendorId 不传时走默认模型所属厂商。 */
export async function resolveVendorCredentials(
  db: Db,
  uid: string,
  vendorId?: string,
): Promise<{ baseUrl: string; apiKey: string }> {
  const secret = await getCryptoSecret(db);
  if (vendorId) {
    const [v] = await db
      .select({ baseUrl: llmVendors.baseUrl, encryptedKey: llmVendors.encryptedKey })
      .from(llmVendors)
      .where(and(eq(llmVendors.id, vendorId), eq(llmVendors.userId, uid)))
      .limit(1);
    if (!v) throw new ApiException('E_LLM_PROVIDER_NOT_FOUND', { detail: vendorId });
    return {
      baseUrl: (v.baseUrl || '').trim(),
      apiKey: v.encryptedKey ? decryptSecret(v.encryptedKey, secret) : '',
    };
  }
  const def = await loadDefaultModel(db, uid);
  if (def) {
    const llm = resolveModelLlm(def, secret);
    return { baseUrl: llm.baseUrl, apiKey: llm.apiKey };
  }
  const base = await loadLlmRow(db, uid);
  const llm = resolveUserLlm(base ?? null, secret);
  return { baseUrl: llm.baseUrl, apiKey: llm.apiKey };
}
