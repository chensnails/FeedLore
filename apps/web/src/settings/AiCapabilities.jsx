/* 设置 → 模型：模型库与能力开关（0015 多路提供商 / 0016 标签单开关）。
 *
 * 独立取数、即时保存、失败回滚，不参与 ModelPane 表单的 dirty 判定——
 * 否则「改了分配没点保存模型就走人」会静默丢失。
 *
 * 拆成两个展示组件（ModelLibrary / CapabilitySwitches）共享一份 hook 数据，
 * 是为了让模型页能按「模型配置 / 能力开关」三层归位，而不是把所有东西塞进一个 Section。
 * 数据源仍是 /api/prefs 一次 GET（providers + routes），与服务端契约同源。
 *
 * 开关语义（0016）：通用能力默认开（enabled !== false），
 * ai_tags 默认关（必须 enabled === true）——与服务端 isRouteEnabled 严格一致。
 */

import React, { useEffect, useState } from 'react';
import { core } from '@core';
import { Dropdown } from '../views/Dropdown.jsx';

const S = () => core;

const CAPS = [
  { key: 'entry_ai', name: '单篇 AI', hint: '摘要 / 要点 / 翻译 / 讲解，可按动作单独指定模型' },
  { key: 'ai_tags', name: 'AI 智能标签', hint: '开启后可给条目自动打标签，也可在文章页手动触发；默认关闭，开启后会自动给新条目打标' },
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
const EMPTY_PROVIDER = { name: '', baseUrl: '', model: '', apiKey: '' };

/** 与服务端 isRouteEnabled 一致：ai_tags 默认关，其它默认开。 */
const isOn = (key, r) => (key === 'ai_tags' ? r.enabled === true : r.enabled !== false);

/** 共享数据 hook：两个组件各挂一处，但都从这一份状态读写。 */
export function useAiCapabilities() {
  const [providers, setProviders] = useState([]);
  const [routes, setRoutes] = useState({});
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);
  const [editing, setEditing] = useState(null); // null | 'new' | provider id
  const [draft, setDraft] = useState(EMPTY_PROVIDER);

  async function load() {
    try {
      const res = await S().apiFetch('/api/prefs');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const d = await res.json();
      setProviders(Array.isArray(d.llmProviders) ? d.llmProviders : []);
      setRoutes(d.llmRoutes && typeof d.llmRoutes === 'object' ? d.llmRoutes : {});
      setLoaded(true);
    } catch (err) {
      setMsg({ ok: false, text: '读取 AI 能力配置失败：' + String((err && err.message) || err) });
    }
  }
  useEffect(() => { load(); }, []);

  /** 统一 POST：失败抛出（调用方回滚），成功按服务端回包刷新。 */
  async function patch(body, okText) {
    setBusy('saving');
    setMsg(null);
    try {
      const res = await S().apiFetch('/api/prefs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(S().errText(d, '保存失败'));
      await load();
      setMsg({ ok: true, text: okText });
    } finally { setBusy(''); }
  }
  /** fn 自己调用 patch（含成功提示）；这里只负责异常兜底。 */
  async function run(fn) {
    if (busy) return;
    try { await fn(); }
    catch (err) { setBusy(''); setMsg({ ok: false, text: String((err && err.message) || err) }); }
  }

  const onToggle = (cap, on) => {
    if (busy) return;
    const prev = routes[cap.key] || {};
    setRoutes((r) => ({ ...r, [cap.key]: { ...prev, enabled: on } }));   // 乐观切换
    run(async () => {
      try {
        await patch({ llmRoutes: { [cap.key]: { enabled: on } } },
          on ? `已开启${cap.name}` : `已关闭${cap.name}`);
      } catch (err) {
        setRoutes((r) => ({ ...r, [cap.key]: prev }));                    // 失败回滚
        throw err;
      }
    });
  };
  const onAssign = (capKey, providerId, actionKey) => {
    if (busy) return;
    const prev = routes[capKey] || {};
    const nextRoute = actionKey
      ? { ...prev, actions: { ...(prev.actions || {}), [actionKey]: providerId } }
      : { ...prev, providerId };
    setRoutes((r) => ({ ...r, [capKey]: nextRoute }));
    run(async () => {
      try {
        await patch({
          llmRoutes: { [capKey]: actionKey ? { actions: { [actionKey]: providerId } } : { providerId } },
        }, '已更新模型分配');
      } catch (err) {
        setRoutes((r) => ({ ...r, [capKey]: prev }));
        throw err;
      }
    });
  };

  const startEdit = (p) => {
    setEditing(p ? p.id : 'new');
    setDraft(p
      ? { name: p.name, baseUrl: p.baseUrl, model: p.model, apiKey: '' }
      : EMPTY_PROVIDER);
  };
  const saveProvider = () => {
    const body = {
      name: draft.name || '', baseUrl: draft.baseUrl || '', model: draft.model || '',
      ...(editing !== 'new' ? { id: editing } : {}),
      ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
    };
    run(async () => {
      await patch({ llmProvider: body }, editing === 'new' ? '已添加模型' : '已保存模型');
      setEditing(null);
    });
  };
  const removeProvider = (p) => run(() => patch({ llmProviderDelete: p.id }, '已删除模型'));
  const setDefault = (p) => run(() => patch({
    llmProvider: { id: p.id, name: p.name, baseUrl: p.baseUrl, model: p.model, isDefault: true },
  }, '已设为默认'));
  const testProvider = async (p) => {
    setBusy('test:' + p.id); setMsg(null);
    try {
      const res = await S().apiFetch('/api/digest/test-llm', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        timeoutMs: S().AI_TIMEOUT_MS || 200000,
        body: JSON.stringify({ providerId: p.id }),
      });
      const d = await res.json().catch(() => ({}));
      setMsg(d.ok
        ? { ok: true, text: `${p.name || p.model} 可用：${d.reply || '连接正常'}` }
        : { ok: false, text: `${p.name || p.model} 调用失败：${S().errText(d, '未知错误')}` });
    } catch (err) {
      setMsg({ ok: false, text: '调用失败：' + String((err && err.message) || err) });
    } finally { setBusy(''); }
  };

  return {
    providers, routes, loaded, busy, msg, editing, draft, setDraft,
    load, run, onToggle, onAssign, startEdit, saveProvider, removeProvider, setDefault, testProvider,
    setEditing,
  };
}

/** 模型列表 + 添加/编辑。`lead` 用于把「默认模型」那一行插到列表最前面，
 *  让页面上只有一个模型列表、地址/Key/模型名只有一套 UI（2026-11-18 简化）。 */
export function ModelLibrary({ cap, lead }) {
  const { providers, loaded, busy, msg, editing, draft, setDraft,
    startEdit, saveProvider, removeProvider, setDefault, testProvider, setEditing } = cap;
  return (
    <div className="ai-cap ai-cap-lib">
      {msg ? <div className={'hint ' + (msg.ok ? 'is-ok' : 'is-err')} role="status">{msg.text}</div> : null}

      {lead || null}

      <h3 className="ai-cap-h">{lead ? '其它模型' : '已添加的模型'}</h3>
      {lead ? null : <p className="hint">默认模型在上方「模型」里配置；未单独分配的任务统一走它。</p>}
      {!loaded ? <p className="hint">读取中…</p> : null}
      <div className="ai-cap-providers">
        {providers.map((p) => (
          <div className="ai-cap-provider" key={p.id} data-provider-id={p.id}>
            <div className="ai-cap-p-main">
              <span className="ai-cap-p-name">{p.name || p.model || '未命名'}</span>
              {p.isDefault ? <span className="ai-cap-badge">默认</span> : null}
              <span className="hint">{p.model || '未填模型'} · {p.apiKeySet ? 'Key 已设置' : '未设 Key'}</span>
            </div>
            <div className="ai-cap-p-actions">
              <button className="btn btn-ghost btn-sm" type="button" disabled={!!busy}
                onClick={() => startEdit(p)}>编辑</button>
              <button className="btn btn-ghost btn-sm" type="button" disabled={!!busy || busy === 'test:' + p.id}
                onClick={() => testProvider(p)}>{busy === 'test:' + p.id ? '测试中…' : '测试'}</button>
              {!p.isDefault ? <button className="btn btn-ghost btn-sm" type="button" disabled={!!busy}
                onClick={() => setDefault(p)}>设默认</button> : null}
              <button className="btn btn-ghost btn-sm" type="button" disabled={!!busy}
                onClick={() => removeProvider(p)}>删除</button>
            </div>
          </div>
        ))}
        {!providers.length && loaded ? <p className="hint">还没有额外模型，所有任务都用「默认模型」。</p> : null}
      </div>

      <h3 className="ai-cap-h">添加模型</h3>
      {editing ? (
        <div className="ai-cap-editor">
          <div className="form-row">
            <label htmlFor="aiCapName">名称</label>
            <input id="aiCapName" type="text" placeholder="如：便宜模型 / 强模型"
              value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </div>
          <div className="form-row">
            <label htmlFor="aiCapBaseUrl">模型地址（OpenAI 兼容）</label>
            <input id="aiCapBaseUrl" type="url" spellCheck="false" placeholder="https://api.example.com/v1"
              value={draft.baseUrl} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} />
          </div>
          <div className="form-row">
            <label htmlFor="aiCapModel">模型名</label>
            <input id="aiCapModel" type="text" spellCheck="false" placeholder="Qwen/Qwen3-8B"
              value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} />
          </div>
          <div className="form-row">
            <label htmlFor="aiCapKey">API Key</label>
            <input id="aiCapKey" type="password" autoComplete="off" placeholder={editing === 'new' ? 'sk-...' : '留空则不修改'}
              value={draft.apiKey} onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })} />
          </div>
          <div className="ai-cap-editor-actions">
            <button className="btn btn-primary btn-sm" id="aiCapSaveProvider" type="button" disabled={!!busy}
              onClick={saveProvider}>{busy ? '保存中…' : editing === 'new' ? '添加模型' : '保存修改'}</button>
            <button className="btn btn-ghost btn-sm" type="button" onClick={() => setEditing(null)}>取消</button>
          </div>
        </div>
      ) : (
        <button className="btn btn-ghost btn-sm" id="aiCapAddProvider" type="button"
          onClick={() => startEdit(null)}>+ 添加模型</button>
      )}
    </div>
  );
}

/** 功能开关 + 模型分配：归到「能力开关」层。 */
export function CapabilitySwitches({ cap }) {
  const { providers, routes, busy, onToggle, onAssign } = cap;
  const options = [
    { id: 'default', label: '默认模型' },
    ...providers.map((p) => ({ id: p.id, label: p.name || p.model || p.id })),
  ];
  return (
    <div className="ai-cap ai-cap-caps">
      <p className="hint">关闭某项能力后，服务端会直接拒绝这类调用（包括 API 与 MCP），不再消耗额度。</p>
      <div className="ai-cap-matrix">
        {CAPS.map((c) => {
          const r = routes[c.key] || {};
          const enabled = isOn(c.key, r);
          return (
            <div className="ai-cap-row" key={c.key} data-cap={c.key}>
              <div className="ai-cap-row-head">
                <label className="ai-cap-sw">
                  <span className="ai-cap-sw-name">{c.name}</span>
                  <span className="switch">
                    <input type="checkbox" checked={enabled} disabled={!!busy}
                      aria-label={`${c.name}开关`}
                      onChange={(e) => onToggle(c, e.target.checked)} />
                    <span className="switch-slider" />
                  </span>
                </label>
                <Dropdown id={'aiCapModel-' + c.key} wrapId={'aiCapModelDD-' + c.key}
                  title={`${c.name}使用的模型`} ariaLabel={`${c.name}使用的模型`}
                  disabled={!!busy || !enabled} value={r.providerId || 'default'}
                  onChange={(v) => onAssign(c.key, v)}
                  options={options.map((o) => ({ value: o.id, label: o.label }))} />
              </div>
              <small className="form-tip">{c.hint}</small>
              {c.key === 'entry_ai' && enabled && providers.length ? (
                /* 四动作的独立模型分配收进「高级」：默认全部跟随上面的能力模型，
                   只有想「翻译用便宜模型、摘要用强模型」这类精细控制时才展开。 */
                <details className="ai-cap-actions-adv">
                  <summary>高级：按动作单独指定模型</summary>
                  <div className="ai-cap-actions">
                    {ACTIONS.map((a) => (
                      <label key={a.key} className="ai-cap-action">
                        <span>{a.name}</span>
                        <Dropdown id={'aiCapAction-' + a.key} wrapId={'aiCapActionDD-' + a.key}
                          title={`${a.name}使用的模型`} ariaLabel={`${a.name}使用的模型`}
                          disabled={!!busy} value={(r.actions || {})[a.key] || r.providerId || 'default'}
                          onChange={(v) => onAssign(c.key, v, a.key)}
                          options={options.map((o) => ({ value: o.id, label: o.label }))} />
                      </label>
                    ))}
                  </div>
                  <small className="form-tip">不改就跟随上面的「单篇 AI」模型；这里只覆盖单个动作。</small>
                </details>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
