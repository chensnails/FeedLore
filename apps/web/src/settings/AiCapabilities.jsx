/* 设置 → 模型：数据源与任务分配（0017 厂商 / 模型两层）。
 *
 * 数据只从一次 GET /api/prefs 来（llmVendors / llmModels / llmRoutes），所有写操作都
 * 立即落库并重拉：模型页没有「保存整页」的概念，改了就是改了。
 *
 * 两层的边界：
 * - 厂商 = 名称 + baseUrl + API Key，多个模型共用一份 Key；
 * - 模型 = 所属厂商 + 上游模型名 + 温度 / 思考；默认模型是唯一的兜底。
 * 任务分配只引用模型 id，引用已删除模型时服务端解析器会自动回落默认模型。
 *
 * 开关语义（0016）：通用能力默认开（enabled !== false），
 * ai_tags 默认关（必须 enabled === true）——与服务端 isRouteEnabled 严格一致。
 */

import React, { useCallback, useEffect, useState } from 'react';
import { core } from '@core';
import { Dropdown } from '../views/Dropdown.jsx';

const S = () => core;

const CAPS = [
  { key: 'entry_ai', name: '单篇 AI', hint: '摘要 / 要点 / 翻译 / 讲解，可按动作单独指定模型' },
  { key: 'ai_tags', name: 'AI 智能标签', hint: '开启后可给条目自动打标签，也可在文章页手动触发；默认关闭' },
  { key: 'digest', name: 'AI 日报', hint: '把近期订阅整理成中文简报' },
  { key: 'explore', name: '探索问答', hint: '在全库订阅里检索并带引用回答' },
  { key: 'mcp', name: 'MCP 写工具', hint: '外部客户端通过 MCP 调用模型' },
  { key: 'auto', name: '自动任务', hint: '日报与标签的定时调度；关掉后不再后台烧额度' },
];
const ACTIONS = [
  { key: 'summary', name: '摘要' },
  { key: 'keypoints', name: '要点' },
  { key: 'translate', name: '翻译' },
  { key: 'explain', name: '讲解' },
];
const CAP_ICONS = {
  entry_ai: 'i-sparkle',
  ai_tags: 'i-tag',
  digest: 'i-file',
  explore: 'i-search',
  mcp: 'i-link',
  auto: 'i-clock',
};

/** 与服务端 isRouteEnabled 一致：ai_tags 默认关，其它默认开。 */
const capOn = (key, r) => (key === 'ai_tags' ? r.enabled === true : r.enabled !== false);

/** 模型的展示名：优先用户起的名字，其次上游模型名。 */
export function modelLabel(m) {
  return String((m && (m.name || m.model)) || '').trim() || '未命名模型';
}

/** chip 文案：未分配跟随默认模型；引用了已删除的模型时明说，避免显示成默认。 */
function chipOf(r, models, actionKey) {
  const id = actionKey ? (r.actions || {})[actionKey] : r.providerId;
  if (!id) return { label: '默认模型', custom: false };
  const m = models.find((x) => String(x.id) === String(id));
  return m ? { label: modelLabel(m), custom: true } : { label: '已移除的模型', custom: false };
}

/**
 * 模型 / 厂商 / 路由的共享状态。
 *
 * 写接口分为两类：
 * - 列表上的即时动作（开关、分配）走 `busy` + 乐观更新，失败回滚并把原因写进 `msg`；
 * - 详情层里的保存 / 删除直接把异常抛给调用方，由层内内联报错（层会立刻关闭，看不到外层提示）。
 */
export function useAiSettings() {
  const [vendors, setVendors] = useState([]);
  const [models, setModels] = useState([]);
  const [routes, setRoutes] = useState({});
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await S().apiFetch('/api/prefs');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const d = await res.json();
      setVendors(Array.isArray(d.llmVendors) ? d.llmVendors : []);
      setModels(Array.isArray(d.llmModels) ? d.llmModels : []);
      setRoutes(d.llmRoutes && typeof d.llmRoutes === 'object' ? d.llmRoutes : {});
      setLoadError('');
      setLoaded(true);
    } catch (err) {
      setLoadError('读取模型配置失败：' + String((err && err.message) || err));
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const post = async (body) => {
    const res = await S().apiFetch('/api/prefs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(S().errText(d, '保存失败'));
    await load();
    return d;
  };

  /* ---- 列表级即时动作：乐观更新 + 失败回滚 ---- */
  const routeAction = async (nextRoutes, body, okText) => {
    if (busy) return;
    const prev = routes;
    setRoutes(nextRoutes);
    setBusy('routes');
    setMsg(null);
    try {
      await post(body);
      setMsg({ ok: true, text: okText });
    } catch (err) {
      setRoutes(prev);
      setMsg({ ok: false, text: String((err && err.message) || err) });
    } finally {
      setBusy('');
    }
  };

  const onToggle = (cap, on) => {
    const prev = routes[cap.key] || {};
    routeAction(
      { ...routes, [cap.key]: { ...prev, enabled: on } },
      { llmRoutes: { [cap.key]: { enabled: on } } },
      on ? `已开启${cap.name}` : `已关闭${cap.name}`,
    );
  };

  const onAssign = (capKey, modelId, actionKey) => {
    const prev = routes[capKey] || {};
    const nextRoute = actionKey
      ? { ...prev, actions: { ...(prev.actions || {}), [actionKey]: modelId } }
      : { ...prev, providerId: modelId };
    routeAction(
      { ...routes, [capKey]: nextRoute },
      { llmRoutes: { [capKey]: actionKey ? { actions: { [actionKey]: modelId } } : { providerId: modelId } } },
      '已更新模型分配',
    );
  };

  /* ---- 详情层动作：失败抛给调用方 ---- */
  const saveVendor = (input, id) => post({ llmVendor: id ? { ...input, id } : input });
  const removeVendor = (id) => post({ llmVendorDelete: id });
  const saveModel = (input, id) => post({ llmModel: id ? { ...input, id } : input });
  const removeModel = (id) => post({ llmModelDelete: id });
  const setDefaultModel = (m) => post({
    llmModel: { id: m.id, vendorId: m.vendorId, model: m.model, isDefault: true },
  });

  /** 列表行上的「设为默认」：即时生效，失败只提示不抛。 */
  const makeDefault = async (m) => {
    if (busy) return;
    setBusy('default');
    setMsg(null);
    try {
      await setDefaultModel(m);
      setMsg({ ok: true, text: `已将「${modelLabel(m)}」设为默认模型` });
    } catch (err) {
      setMsg({ ok: false, text: String((err && err.message) || err) });
    } finally {
      setBusy('');
    }
  };

  /** 拉上游模型列表（OpenAI 兼容 GET {base}/models），只读、不消耗模型额度。 */
  const fetchUpstreamModels = async (vendorId) => {
    const res = await S().apiFetch('/api/llm/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeoutMs: S().AI_TIMEOUT_MS || 200000,
      body: JSON.stringify({ vendorId }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(S().errText(d, '模型列表获取失败'));
    if (!d.ok) throw new Error(S().errText(d, '上游没有返回模型列表，可直接手填模型名'));
    return Array.isArray(d.models) ? d.models : [];
  };

  /** 真发一次模型请求。不传 modelId = 测当前默认模型。返回 { ok, text }，不写全局提示。 */
  const testModel = async (modelId) => {
    setBusy('test');
    try {
      const res = await S().apiFetch('/api/digest/test-llm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        timeoutMs: S().AI_TIMEOUT_MS || 200000,
        body: JSON.stringify(modelId ? { modelId } : {}),
      });
      const d = await res.json().catch(() => ({}));
      return d.ok
        ? { ok: true, text: `模型可用：${d.reply || '连接正常'}` }
        : { ok: false, text: '调用失败：' + S().errText(d, '未知错误') };
    } catch (err) {
      return { ok: false, text: '调用失败：' + String((err && err.message) || err) };
    } finally {
      setBusy('');
    }
  };

  return {
    vendors, models, routes, loaded, loadError, busy, msg,
    load, onToggle, onAssign,
    saveVendor, removeVendor, saveModel, removeModel, setDefaultModel, makeDefault,
    fetchUpstreamModels, testModel,
  };
}

/** 任务分配：一项能力一行（名称 / 说明 + 模型 chip + 开关）；单篇四动作的高级分配默认收起。 */
export function TaskAssignments({ ai }) {
  const { models, routes, busy, onToggle, onAssign } = ai;
  const options = [
    { value: 'default', label: '默认模型', group: '' },
    ...models.map((m) => ({
      value: m.id,
      label: modelLabel(m),
      group: m.vendorName || '',
    })),
  ];
  return (
    <div className="ai-cap">
      <p className="hint">关闭某项能力后，服务端会直接拒绝这类调用（包括 API 与 MCP），不再消耗额度。</p>
      <div className="ai-cap-matrix">
        {CAPS.map((c) => {
          const r = routes[c.key] || {};
          const enabled = capOn(c.key, r);
          const chip = chipOf(r, models, null);
          return (
            <div className={'ai-cap-row' + (enabled ? '' : ' is-off')} key={c.key} data-cap={c.key}>
              <div className="ai-cap-main">
                <div className="ai-cap-top">
                  <span className="ai-cap-ico" aria-hidden="true">
                    <svg className="ico" focusable="false"><use href={'#' + CAP_ICONS[c.key]} /></svg>
                  </span>
                  <span className="ai-cap-name">{c.name}</span>
                  {c.key === 'ai_tags' && !enabled ? <span className="ai-cap-tag">默认关闭</span> : null}
                </div>
                <small className="form-tip ai-cap-hint">{c.hint}</small>
                {c.key === 'entry_ai' && enabled && models.length > 1 ? (
                  <details className="ai-cap-adv ai-cap-actions-adv">
                    <summary>高级：按动作单独指定模型</summary>
                    <div className="ai-cap-actions">
                      {ACTIONS.map((a) => (
                        <label key={a.key} className="ai-cap-action">
                          <span>{a.name}</span>
                          <Dropdown id={'aiCapAction-' + a.key} wrapId={'aiCapActionDD-' + a.key}
                            title={`${a.name}使用的模型`} ariaLabel={`${a.name}使用的模型`}
                            disabled={!!busy} value={(r.actions || {})[a.key] || r.providerId || 'default'}
                            onChange={(v) => onAssign(c.key, v, a.key)}
                            options={options} extraClass="ai-cap-act-chip" />
                        </label>
                      ))}
                    </div>
                    <p className="form-tip">不改就跟随上面的「单篇 AI」模型；这里只覆盖单个动作。</p>
                  </details>
                ) : null}
              </div>
              <div className="ai-cap-ctl">
                <Dropdown id={'aiCapModel-' + c.key} wrapId={'aiCapModelDD-' + c.key}
                  title={`${c.name}使用的模型`} ariaLabel={`${c.name}使用的模型`}
                  disabled={!!busy || !enabled} value={r.providerId || 'default'}
                  valueLabel={chip.label}
                  onChange={(v) => onAssign(c.key, v)}
                  options={options} extraClass="ai-cap-chip"
                  dataAttrs={{ 'data-custom': chip.custom ? 'true' : 'false' }} />
                <label className="ai-cap-sw">
                  <span className="switch">
                    <input type="checkbox" checked={enabled} disabled={!!busy}
                      aria-label={`${c.name}开关`}
                      onChange={(e) => onToggle(c, e.target.checked)} />
                    <span className="switch-slider" />
                  </span>
                </label>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
