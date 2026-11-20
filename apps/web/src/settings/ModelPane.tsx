/* 设置弹层「模型」面板（2026-11-18 按 0017 厂商 / 模型两层重构）。
 *
 * 页面只讲三件事，顺序就是使用顺序：
 *   ① 模型接入：厂商是折叠组，模型缩进挂在厂商下（与 Cherry Studio / LobeChat 一致）；
 *      地址与 Key 只在厂商详情里维护，多个模型共用一份；
 *   ② 任务分配：哪项能力用哪个模型，关闭即服务端硬拦；
 *   ③ 运行状态（默认折叠）：最近调用、历史与用量，参考信息不抢版面。
 *
 * 生效方式：全部即改即生效。列表行只做展示与快捷动作，编辑收进 DetailSheet
 * （桌面右侧抽屉 / 移动端底部弹层），与数据源、规则、账号面板同一套交互。
 * 没有底部保存按钮 —— 模型配置没有「整页草稿」，不会出现「改了一半没保存」。
 *
 * data-sec 锚点：llm-access（模型接入）、llm-capabilities（任务分配）、
 * llm-status + llm-usage（运行状态）。 */

import { core } from '@core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { qk } from '../kernel/query.ts';
import { NO_AUTOFILL_PROPS, useNoAutofillName } from '../ui/noAutofill.ts';
import { Dropdown } from '../views/Dropdown.tsx';
import { modelLabel, TaskAssignments, useAiSettings } from './AiCapabilities.tsx';
import { DetailSheet } from './DetailSheet.tsx';
import { PaneFoot, Result, Section, useResult } from './primitives.tsx';

const S = () => core;
const USAGE_SPANS: Record<string, string> = { today: '今日', days7: '近 7 天', days30: '近 30 天' };
const USAGE_KINDS: Record<string, string> = {
  digest: '日报生成',
  entry_ai: '单篇 AI',
  ai_tags: 'AI 标签',
  mcp: 'MCP 调用',
  test: '测试模型',
};
const DEPTH_LABEL = { low: '轻', medium: '中', high: '深' };

/**
 * @param {*} [n]
 */
const fmtNum = (n: any) => Number(n || 0).toLocaleString('zh-CN');
/**
 * @param {*} [n]
 */
const fmtTokens = (n: any) => {
  const v = Number(n || 0);
  if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M';
  if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
  return String(v);
};
/**
 * @param {*} [url]
 */
const hostOf = (url: any) =>
  String(url || '')
    .replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
    .split('/')[0];
/**
 * @param {*} [v]
 */
const vendorLabel = (v: any) =>
  String((v && v.name) || hostOf(v && v.baseUrl) || '').trim() || '未命名厂商';

/**
 * @param {*} [n]
 */
const pad2 = (n: any) => String(n).padStart(2, '0');
/**
 * @param {*} [iso]
 */
const fmtReqTime = (iso: any) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  return d.toDateString() === new Date().toDateString()
    ? hm
    : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hm}`;
};
/**
 * @param {*} [iso]
 */
const fmtRel = (iso: any) => {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  const diff = Date.now() - t;
  if (diff < 60e3) return '刚刚';
  if (diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前';
  if (diff < 86400e3) return Math.floor(diff / 3600e3) + ' 小时前';
  return Math.floor(diff / 86400e3) + ' 天前';
};
/**
 * @param {*} [ms]
 */
const fmtDur = (ms: any) => {
  const v = Number(ms || 0);
  if (!v) return '—';
  if (v < 1000) return v + 'ms';
  return v >= 10000 ? Math.round(v / 1000) + 's' : (v / 1000).toFixed(1) + 's';
};

/* 界面用 low/medium/high 三档，落库是 1/2/3 的整数（0 表示未设置）。 */
/**
 * @param {*} [d]
 */
const depthToNum = (d: any) => (d === 'low' ? 1 : d === 'high' ? 3 : 2);
/**
 * @param {*} [n]
 */
const numToDepth = (n: any) => (n === 1 ? 'low' : n === 3 ? 'high' : 'medium');
/**
 * @param {*} [t]
 */
const tempText = (t: any) => String(Number.isFinite(Number(t)) ? Number(t) : 0.3);

/* ============================ 模型详情层 ============================ */

/**
 * @param {*} opts
 */

function ModelSheet({ ai, model, initialVendorId, onClose, onNeedVendor }: any) {
  const editing = !!model;
  const [vendorId, setVendorId] = useState<any>(
    model ? model.vendorId || ai.vendors[0]?.id || '' : initialVendorId || ai.vendors[0]?.id || '',
  );
  const [name, setName] = useState<any>(model ? model.name || '' : '');
  const [upstream, setUpstream] = useState<any>(model ? model.model || '' : '');
  const [temperature, setTemperature] = useState<any>(tempText(model ? model.temperature : 0.3));
  const [thinking, setThinking] = useState<any>(!!(model && model.thinking));
  const [depth, setDepth] = useState<any>(numToDepth(model ? model.thinkingDepth : 2));
  const [isDefault, setIsDefault] = useState<any>(!!(model && model.isDefault));
  /** @type {*} */
  const [list, setList] = useState<any>(null);
  const [listBusy, setListBusy] = useState<any>(false);
  const [listErr, setListErr] = useState<any>('');
  const [busy, setBusy] = useState<any>('');
  const [result, showResult] = useResult();

  const vendorOptions = ai.vendors.map(
    /** @param {*} [v] */ (v: any) => ({ value: v.id, label: v.name }),
  );
  const lockedDefault = editing && model.isDefault;

  async function fetchList() {
    if (!vendorId) {
      setListErr('先选择厂商');
      return;
    }
    setListBusy(true);
    setListErr('');
    try {
      const arr = await ai.fetchUpstreamModels(vendorId);
      setList(arr.length ? arr : null);
      if (!arr.length) setListErr('上游没有返回模型列表，可直接手填模型名');
    } catch (err) {
      setList(null);
      setListErr(String((err && err.message) || err));
    } finally {
      setListBusy(false);
    }
  }

  async function save() {
    if (!vendorId) {
      showResult(false, '先在「模型接入」里添加一个厂商');
      return;
    }
    if (!upstream.trim()) {
      showResult(false, '模型名不能为空');
      return;
    }
    const t = Number(temperature);
    if (!Number.isFinite(t) || t < 0 || t > 2) {
      showResult(false, '温度需在 0 ~ 2 之间');
      return;
    }
    setBusy('save');
    try {
      await ai.saveModel(
        {
          vendorId,
          name: name.trim(),
          model: upstream.trim(),
          temperature: t,
          thinking,
          thinkingDepth: depthToNum(depth),
          isDefault: lockedDefault ? true : isDefault,
        },
        editing ? model.id : undefined,
      );
      onClose();
    } catch (err) {
      showResult(false, '保存失败：' + String((err && err.message) || err));
    } finally {
      setBusy('');
    }
  }

  async function runTest() {
    if (!editing) return;
    setBusy('test');
    const r = await ai.testModel(model.id);
    showResult(r.ok, r.text);
    setBusy('');
  }

  async function remove() {
    const ok = await S().confirm({
      title: '删除这个模型？',
      desc: '引用它的任务会自动回落到默认模型；上游厂商与 Key 不受影响。',
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    setBusy('delete');
    try {
      await ai.removeModel(model.id);
      onClose();
    } catch (err) {
      showResult(false, '删除失败：' + String((err && err.message) || err));
      setBusy('');
    }
  }

  const foot = (
    <>
      {editing ? (
        <button
          className="btn btn-danger"
          type="button"
          id="modelSheetDelete"
          disabled={!!busy}
          onClick={remove}
        >
          {busy === 'delete' ? '删除中…' : '删除模型'}
        </button>
      ) : null}
      {editing ? (
        <button
          className="btn"
          type="button"
          id="modelSheetTest"
          disabled={!!busy}
          onClick={runTest}
        >
          {busy === 'test' ? '测试中…' : '测试'}
        </button>
      ) : null}
      <button
        className="btn btn-primary"
        type="button"
        id="modelSheetSave"
        disabled={!!busy || !ai.vendors.length}
        onClick={save}
      >
        {busy === 'save' ? '保存中…' : editing ? '保存' : '添加模型'}
      </button>
    </>
  );

  return (
    <DetailSheet
      title={editing ? `模型 · ${modelLabel(model)}` : '添加模型'}
      subtitle={
        editing ? model.vendorName || '未绑定厂商' : '模型只决定上游名字与参数，地址与 Key 在厂商里'
      }
      onClose={onClose}
      foot={foot}
      saveHint="保存后立即生效；测试会真的调一次上游并在「运行状态」里留一条记录。"
    >
      {!ai.vendors.length ? (
        <div className="hint pane-msg" role="status">
          还没有厂商。模型的地址与 Key 都挂在厂商上，先添加一个厂商再回来选模型。
          <button type="button" className="btn btn-ghost btn-sm ml-3" onClick={onNeedVendor}>
            添加厂商
          </button>
        </div>
      ) : null}

      <div className="form-row">
        <label>厂商</label>
        <Dropdown
          id="modelVendor"
          wrapId="modelVendorDD"
          title="所属厂商"
          ariaLabel="所属厂商"
          disabled={!vendorOptions.length}
          value={vendorId}
          valueLabel={vendorOptions.length ? '选择厂商' : '还没有厂商'}
          onChange={setVendorId}
          options={vendorOptions}
        />
        <small className="form-tip">同一厂商下的模型共用地址与 Key；换厂商不需要重填 Key。</small>
      </div>

      <div className="form-row">
        <label htmlFor="modelName">显示名称</label>
        <input
          id="modelName"
          type="text"
          maxLength={60}
          placeholder="如：便宜模型 / 日报专用（可留空）"
          value={name}
          onChange={/** @param {*} [e] */ (e: any) => setName(e.target.value)}
        />
        <small className="form-tip">只用于本页展示；留空时显示上游模型名。</small>
      </div>

      <div className="form-row">
        <label htmlFor="modelUpstream">上游模型名</label>
        <div className="input-with-btn">
          <input
            id="modelUpstream"
            type="text"
            spellCheck="false"
            placeholder="Qwen/Qwen3-8B"
            value={upstream}
            onChange={/** @param {*} [e] */ (e: any) => setUpstream(e.target.value)}
          />
          {list ? (
            <Dropdown
              id="modelUpstreamPick"
              wrapId="modelUpstreamPickDD"
              title="从上游列表选择"
              ariaLabel="从上游列表选择"
              value={upstream}
              valueLabel="选模型"
              onChange={setUpstream}
              options={list.map(/** @param {*} [m] */ (m: any) => ({ value: m, label: m }))}
            />
          ) : null}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            id="fetchUpstreamBtn"
            disabled={listBusy || !vendorId}
            onClick={fetchList}
          >
            {listBusy ? '获取中…' : list ? '重新获取' : '获取列表'}
          </button>
        </div>
        {listErr ? (
          <small className="form-tip is-warn" role="status">
            {listErr}
          </small>
        ) : null}
        <small className="form-tip">
          会向上游请求 <code>/models</code>；拉不到也可以直接手填。
        </small>
      </div>

      <div className="form-row">
        <label htmlFor="modelTemp">温度</label>
        <input
          id="modelTemp"
          type="number"
          min="0"
          max="2"
          step="0.05"
          value={temperature}
          onChange={/** @param {*} [e] */ (e: any) => setTemperature(e.target.value)}
        />
        <small className="form-tip">越低越稳定保守，越高越发散。摘要建议 0.2 ~ 0.5。</small>
      </div>

      <div className="form-row">
        <label className="form-row-head">
          <span>思考模式</span>
          <span className="switch">
            <input
              id="modelThinking"
              type="checkbox"
              checked={thinking}
              onChange={/** @param {*} [e] */ (e: any) => setThinking(e.target.checked)}
            />
            <span className="switch-slider" />
          </span>
        </label>
        <small className="form-tip">
          只对这个模型生效。打开后先推理再回答，更贴复杂选材但更慢、更耗额度； 仅对
          <code>Qwen3</code> / <code>DeepSeek</code> 这类支持思考的上游有效。
        </small>
      </div>

      <div className="form-row" hidden={!thinking}>
        <label>思考深度</label>
        <Dropdown
          id="modelDepth"
          wrapId="modelDepthDD"
          title="思考深度"
          ariaLabel="思考深度"
          value={depth}
          onChange={setDepth}
          options={[
            { value: 'low', label: '轻 · 少量推理，接近不开思考' },
            { value: 'medium', label: '中 · 默认，够它把选材想过一遍' },
            { value: 'high', label: '深 · 充分推理，长清单时更明显' },
          ]}
        />
        <small className="form-tip">日报「中」通常够；条目多、分类总跑偏时才用「深」。</small>
      </div>

      <div className="form-row">
        <label className="form-row-head">
          <span>设为默认模型</span>
          <span className="switch">
            <input
              id="modelIsDefault"
              type="checkbox"
              checked={lockedDefault || isDefault}
              disabled={lockedDefault}
              onChange={/** @param {*} [e] */ (e: any) => setIsDefault(e.target.checked)}
            />
            <span className="switch-slider" />
          </span>
        </label>
        <small className="form-tip">默认模型兜底所有没有单独分配的任务，全站只保留一个。</small>
      </div>

      <Result id="modelSheetResult" result={result} />
    </DetailSheet>
  );
}

/* ============================ 厂商详情层 ============================ */

/**
 * @param {*} opts
 */
function VendorSheet({ ai, vendor, onClose, onSaved }: any) {
  const editing = !!vendor;
  const keyName = useNoAutofillName('vendor-key');
  const urlName = useNoAutofillName('vendor-url');
  const [name, setName] = useState<any>(vendor ? vendor.name || '' : '');
  const [baseUrl, setBaseUrl] = useState<any>(vendor ? vendor.baseUrl || '' : '');
  const [apiKey, setApiKey] = useState<any>('');
  const [showKey, setShowKey] = useState<any>(false);
  const [clearKey, setClearKey] = useState<any>(false);
  const [busy, setBusy] = useState<any>('');
  const [result, showResult] = useResult();

  const saved = !!(vendor && vendor.apiKeySet);

  async function save() {
    if (!baseUrl.trim()) {
      showResult(false, '接口地址不能为空');
      return;
    }
    setBusy('save');
    try {
      const payload: any = { name: name.trim(), baseUrl: baseUrl.trim() };
      const typed = apiKey.trim();
      if (clearKey) payload.apiKey = '';
      else if (typed) payload.apiKey = typed;
      await ai.saveVendor(payload, editing ? vendor.id : undefined);
      onSaved();
    } catch (err) {
      showResult(false, '保存失败：' + String((err && err.message) || err));
    } finally {
      setBusy('');
    }
  }

  async function remove() {
    const n = vendor.modelCount || 0;
    const ok = await S().confirm({
      title: '删除这个厂商？',
      desc: n
        ? `它下面的 ${n} 个模型会一起删除，引用这些模型的任务自动回落到默认模型。`
        : '这个厂商还没有模型，删除后不影响其它配置。',
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    setBusy('delete');
    try {
      await ai.removeVendor(vendor.id);
      onClose();
    } catch (err) {
      showResult(false, '删除失败：' + String((err && err.message) || err));
      setBusy('');
    }
  }

  const foot = (
    <>
      {editing ? (
        <button
          className="btn btn-danger"
          type="button"
          id="vendorSheetDelete"
          disabled={!!busy}
          onClick={remove}
        >
          {busy === 'delete' ? '删除中…' : '删除厂商'}
        </button>
      ) : null}
      <button
        className="btn btn-primary"
        type="button"
        id="vendorSheetSave"
        disabled={!!busy}
        onClick={save}
      >
        {busy === 'save' ? '保存中…' : editing ? '保存' : '添加厂商'}
      </button>
    </>
  );

  return (
    <DetailSheet
      title={editing ? `厂商 · ${vendor.name || hostOf(vendor.baseUrl)}` : '添加厂商'}
      subtitle={
        editing
          ? `${vendor.modelCount || 0} 个模型共用这份连接信息`
          : '地址与 Key 只填一次，模型里直接选'
      }
      onClose={onClose}
      foot={foot}
      saveHint="地址是出网口，保存前会做一次可达性与安全校验。"
    >
      <div className="form-row">
        <label htmlFor="vendorName">名称</label>
        <input
          id="vendorName"
          type="text"
          maxLength={60}
          placeholder="如：硅基流动 / 火山方舟（可留空，默认用域名）"
          value={name}
          onChange={/** @param {*} [e] */ (e: any) => setName(e.target.value)}
        />
      </div>

      <div className="form-row">
        <label htmlFor="vendorBaseUrl">接口地址（OpenAI 兼容）</label>
        <input
          id="vendorBaseUrl"
          name={urlName}
          type="url"
          placeholder="https://api.siliconflow.cn/v1"
          value={baseUrl}
          onChange={/** @param {*} [e] */ (e: any) => setBaseUrl(e.target.value)}
          {...NO_AUTOFILL_PROPS}
        />
        <small className="form-tip">
          填到 <code>/v1</code> 或完整 <code>/chat/completions</code> 均可。
        </small>
      </div>

      <div className="form-row">
        <label htmlFor="vendorKey">API Key</label>
        <div className="input-with-btn">
          <input
            id="vendorKey"
            name={keyName}
            type={showKey ? 'text' : 'password'}
            placeholder={saved ? '已保存，留空则不修改' : 'sk-...'}
            value={apiKey}
            onChange={
              /** @param {*} [e] */ (e: any) => {
                setApiKey(e.target.value);
                setClearKey(false);
              }
            }
            {...NO_AUTOFILL_PROPS}
          />
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setShowKey(/** @param {*} [v] */ (v: any) => !v)}
          >
            {showKey ? '隐藏' : '显示'}
          </button>
          {saved ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={!!busy}
              onClick={() => {
                setClearKey(true);
                setApiKey('');
              }}
            >
              清除
            </button>
          ) : null}
        </div>
        <small className="form-tip">
          {clearKey ? (
            '保存后清除已存的 Key。'
          ) : saved ? (
            <>
              已保存：<code>{vendor.apiKeyHint || '••••'}</code> · 加密存储，不回显明文。
            </>
          ) : (
            'Key 加密存储，页面只显示掩码。同一厂商下所有模型共用。'
          )}
        </small>
      </div>

      <Result id="vendorSheetResult" result={result} />
    </DetailSheet>
  );
}

/* ============================ 主面板 ============================ */

/**
 * @param {*} opts
 */
export function ModelPane({ onDirtyChange }: any) {
  const paneRef: any = useRef<any>(null);
  const ai = useAiSettings();
  const { vendors, models, loaded, loadError, busy, msg } = ai;

  // 详情层：{ kind: 'model'|'vendor', id: string|null }；id 为 null = 新建
  /** @type {*} */
  const [sheet, setSheet] = useState<any>(null);
  // 在模型层里点「添加厂商」后，厂商保存完要自动回到新建模型
  const [pendingModel, setPendingModel] = useState<any>(false);
  // 厂商组的展开状态；没动过的组默认展开默认模型所在厂商
  const [openGroups, setOpenGroups] = useState<any>({});

  /** @type {*} */
  const [usage, setUsage] = useState<any>(null);
  const [usageBusy, setUsageBusy] = useState<any>(false);
  /** @type {*} */
  const [requests, setRequests] = useState<any>(null);
  const [reqError, setReqError] = useState<any>('');
  const [reqBusy, setReqBusy] = useState<any>(false);
  const [reqLimit, setReqLimit] = useState<any>(20);
  const [keepInfo, setKeepInfo] = useState<any>({ keep: 200, days: 30 });
  const [statusResult, showStatusResult] = useResult();

  useEffect(() => {
    const s = S();
    if (s && s.bindSections && paneRef.current) s.bindSections(paneRef.current);
  }, []);
  useEffect(() => {
    if (onDirtyChange) onDirtyChange(false);
  }, [onDirtyChange]);
  // V5：用量 / 请求历史交给 Query；queryFn 走 core.apiFetch 端口，测试桩照常生效。
  // 条数切换通过 queryKey 带 reqLimit 自动重拉（无需手动发请求）。
  const usageQuery = useQuery({
    queryKey: qk.aiUsage,
    queryFn: async () => {
      const res = await S().apiFetch('/api/ai-usage?days=30');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(S().errText(data, 'HTTP ' + res.status));
      return data;
    },
    refetchOnMount: 'always',
    gcTime: 0,
    retry: false,
  });
  const requestsQuery = useQuery({
    queryKey: qk.aiRequests(reqLimit),
    queryFn: async () => {
      const res = await S().apiFetch(
        '/api/ai-requests?limit=' + encodeURIComponent(String(reqLimit)),
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(S().errText(data, 'HTTP ' + res.status));
      return data;
    },
    refetchOnMount: 'always',
    gcTime: 0,
    retry: false,
  });

  // 用量：参考信息，失败静默留空（保留原语义）。
  useEffect(() => {
    setUsageBusy(false);
    if (usageQuery.data) setUsage(usageQuery.data);
  }, [usageQuery.data]);

  // 请求历史：回填列表 + keepInfo；失败写 reqError 并保住旧列表。
  useEffect(() => {
    setReqBusy(false);
    if (!requestsQuery.data) return;
    setReqError('');
    const data = requestsQuery.data;
    setRequests(Array.isArray(data.requests) ? data.requests : []);
    setKeepInfo({
      keep: Number(data.keep) > 0 ? Number(data.keep) : 200,
      days: Number(data.keepDays) > 0 ? Number(data.keepDays) : 30,
    });
  }, [requestsQuery.data]);
  useEffect(() => {
    if (!requestsQuery.isError) return;
    const err: any = requestsQuery.error;
    setReqError(String(err?.message || err));
    setRequests((prev: any) => (Array.isArray(prev) ? prev : []));
  }, [requestsQuery.isError, requestsQuery.error]);

  // 写后 / 手动刷新沿用原入口：refetch 强制重拉并触发上面的回填。
  async function loadUsage() {
    setUsageBusy(true);
    await usageQuery.refetch();
    setUsageBusy(false);
  }
  async function loadRequests(_limit?: any) {
    setReqBusy(true);
    setReqError('');
    await requestsQuery.refetch();
    setReqBusy(false);
  }

  function refreshAll() {
    loadRequests();
    loadUsage();
  }

  const defaultModel =
    models.find(/** @param {*} [m] */ (m: any) => m.isDefault) || models[0] || null;

  /* ---- 运行状态：只用本地记录推断，不额外打一次模型（看状态不烧 token） ---- */
  const recent: any = Array.isArray(requests) ? requests : [];
  const lastReq = recent[0] || null;
  const status = (() => {
    if (!defaultModel)
      return { cls: 'is-off', label: '未配置', detail: '先添加厂商与模型才能调用' };
    if (!defaultModel.model)
      return { cls: 'is-off', label: '未配置', detail: '默认模型还没填上游模型名' };
    if (!defaultModel.apiKeySet)
      return { cls: 'is-off', label: '缺少 Key', detail: '默认模型所属厂商还没有 API Key' };
    if (requests === null && !reqError) return { cls: 'is-idle', label: '读取中…', detail: '' };
    if (reqError && !recent.length) return { cls: 'is-fail', label: '状态未知', detail: reqError };
    if (!lastReq)
      return {
        cls: 'is-idle',
        label: '未测试',
        detail: '还没有调用记录，可以点「测试默认模型」先验一次',
      };
    if (lastReq.ok) {
      return {
        cls: 'is-ok',
        label: '可用',
        detail: `最近一次成功 · ${fmtRel(lastReq.createdAt)} · ${USAGE_KINDS[lastReq.kind] || lastReq.kind}`,
      };
    }
    return {
      cls: 'is-fail',
      label: '最近失败',
      detail: `${fmtRel(lastReq.createdAt)} · ${S().errText(lastReq.error || '', '调用失败')}`,
    };
  })();
  const avgMs = (() => {
    const ok = recent.filter(/** @param {*} [r] */ (r: any) => r.ok && Number(r.durationMs) > 0);
    if (!ok.length) return 0;
    return Math.round(
      ok.reduce(
        /** @param {*} [a] @param {*} [r] */ (a: any, r: any) => a + Number(r.durationMs),
        0,
      ) / ok.length,
    );
  })();
  const todayCalls = usage?.today?.calls || 0;
  const todayFails = usage?.today?.fails || 0;
  const reqLoading = requests === null && !reqError;

  async function testDefault() {
    const r = await ai.testModel();
    showStatusResult(r.ok, r.text);
    loadRequests();
  }

  /**
   * @param {*} [kind]
   * @param {*} [id]
   */
  const openRow = (kind: any, id: any) => setSheet({ kind, id });

  /**
   * @param {*} [fn]
   */
  const rowKeyDown = (fn: any) => /** @param {*} [ev] */ (ev: any) => {
    if (ev.target !== ev.currentTarget) return;
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      fn();
    }
  };

  /**
   * @param {*} [m]
   * @param {*} [loose]
   */
  const renderModelRow = (m: any, loose: any) => {
    const depth = numToDepth(m.thinkingDepth);
    return (
      <div
        className="sl-row is-nested"
        key={m.id}
        data-model-id={m.id}
        role="button"
        tabIndex={0}
        aria-label={`编辑模型「${modelLabel(m)}」`}
        onClick={() => openRow('model', m.id)}
        onKeyDown={rowKeyDown(() => openRow('model', m.id))}
      >
        <div className="sl-main">
          <div className="sl-name">{modelLabel(m)}</div>
          <div className="sl-sub">
            {loose ? `${m.vendorName || '未绑定厂商'} · ` : ''}
            温度 {tempText(m.temperature)} · {m.thinking ? `思考${DEPTH_LABEL[depth]}` : '不思考'}
          </div>
        </div>
        <span
          className="sl-side"
          onClick={/** @param {*} [ev] */ (ev: any) => ev.stopPropagation()}
        >
          {m.isDefault ? (
            <span className="sl-badge">默认</span>
          ) : m.vendorId ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={!!busy}
              onClick={() => ai.makeDefault(m)}
            >
              设为默认
            </button>
          ) : (
            <span className="sl-badge muted">旧配置</span>
          )}
        </span>
        <svg className="ico feed-caret" aria-hidden="true" focusable="false">
          <use href="#i-chevron-right" />
        </svg>
      </div>
    );
  };

  const currentModel =
    sheet && sheet.kind === 'model' && sheet.id
      ? models.find(/** @param {*} [m] */ (m: any) => m.id === sheet.id) || null
      : null;
  const currentVendor =
    sheet && sheet.kind === 'vendor' && sheet.id
      ? vendors.find(/** @param {*} [v] */ (v: any) => v.id === sheet.id) || null
      : null;
  const looseModels: any = models.filter(/** @param {*} [m] */ (m: any) => !m.vendorId);
  const autoOpenVendorId = (defaultModel && defaultModel.vendorId) || vendors[0]?.id || '';
  const accessSub = !loaded
    ? '读取中…'
    : vendors.length
      ? `${vendors.length} 个厂商 · ${models.length} 个模型` +
        (defaultModel ? ` · 默认 ${modelLabel(defaultModel)}` : '')
      : '未配置';

  return (
    <div className="tab-pane" data-pane="model" ref={paneRef}>
      <div className="pane-scroll">
        {loadError ? (
          <div className="hint pane-msg lg" role="alert">
            {loadError}
            <button type="button" className="btn btn-ghost btn-sm ml-3" onClick={ai.load}>
              重试
            </button>
          </div>
        ) : null}
        {msg ? <Result id="llmResult" result={{ ok: msg.ok, msg: msg.text }} /> : null}

        {/* ---------- ① 模型接入：厂商折叠组，模型缩进挂在厂商下 ---------- */}
        <Section secKey="llm-access" title="模型接入" sub={accessSub} open>
          <div className="sl-toolbar">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              id="addVendorBtn"
              onClick={() => openRow('vendor', null)}
            >
              + 添加厂商
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              id="addModelBtn"
              disabled={!vendors.length}
              onClick={() => openRow('model', null)}
            >
              + 添加模型
            </button>
            <span className="sl-toolbar-note">点厂商展开模型；地址与 Key 在厂商详情里维护。</span>
          </div>

          {!loaded ? (
            <div className="sl-empty">正在读取模型配置…</div>
          ) : !vendors.length ? (
            <div className="sl-empty">
              还没有接入厂商。添加一个 OpenAI 兼容的接口地址与 Key，再在它下面建模型。
            </div>
          ) : (
            <div className="sl-list">
              {vendors.map(
                /** @param {*} [v] */ (v: any) => {
                  const own: any = models.filter(
                    /** @param {*} [m] */ (m: any) => m.vendorId === v.id,
                  );
                  const label = vendorLabel(v);
                  const open = v.id in openGroups ? openGroups[v.id] : v.id === autoOpenVendorId;
                  return (
                    <details
                      className="sl-group"
                      key={v.id}
                      data-vendor-id={v.id}
                      open={open}
                      onToggle={
                        /** @param {*} [ev] */ (ev: any) => {
                          const isOpen = ev.currentTarget.open;
                          setOpenGroups(
                            /** @param {*} [prev] */ (prev: any) =>
                              prev[v.id] === isOpen ? prev : { ...prev, [v.id]: isOpen },
                          );
                        }
                      }
                    >
                      <summary className="sl-row sl-group-head">
                        <span
                          className="sl-ava"
                          style={{ background: 'var(--surface-2)', color: 'var(--text-muted)' }}
                        >
                          <svg className="ico" aria-hidden="true" focusable="false">
                            <use href="#i-link" />
                          </svg>
                        </span>
                        <div className="sl-main">
                          <div className="sl-name">{label}</div>
                          <div className="sl-sub">
                            {hostOf(v.baseUrl) || '未填地址'} · {own.length} 个模型
                          </div>
                        </div>
                        <span className="sl-side">
                          <span className={'sl-badge' + (v.apiKeySet ? '' : ' muted')}>
                            {v.apiKeySet ? 'Key 已设' : '未设 Key'}
                          </span>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm sl-group-edit"
                            aria-label={`编辑厂商「${label}」`}
                            onClick={
                              /** @param {*} [ev] */ (ev: any) => {
                                ev.preventDefault();
                                ev.stopPropagation();
                                openRow('vendor', v.id);
                              }
                            }
                          >
                            编辑
                          </button>
                        </span>
                        <svg
                          className="ico feed-caret sl-group-caret"
                          aria-hidden="true"
                          focusable="false"
                        >
                          <use href="#i-chevron-right" />
                        </svg>
                      </summary>
                      <div className="sl-models">
                        {own.length ? (
                          own.map(/** @param {*} [m] */ (m: any) => renderModelRow(m, false))
                        ) : (
                          <div className="sl-empty is-inline">这个厂商下还没有模型。</div>
                        )}
                        <div className="sl-group-foot">
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            data-vendor-add={v.id}
                            onClick={() => setSheet({ kind: 'model', id: null, vendorId: v.id })}
                          >
                            + 添加模型
                          </button>
                        </div>
                      </div>
                    </details>
                  );
                },
              )}
              {looseModels.length ? (
                <details className="sl-group" data-vendor-id="__none" open>
                  <summary className="sl-row sl-group-head">
                    <span className="sl-ava warn">
                      <svg className="ico" aria-hidden="true" focusable="false">
                        <use href="#i-link" />
                      </svg>
                    </span>
                    <div className="sl-main">
                      <div className="sl-name">未归入厂商</div>
                      <div className="sl-sub">{looseModels.length} 个模型 · 点开后可改选厂商</div>
                    </div>
                    <svg
                      className="ico feed-caret sl-group-caret"
                      aria-hidden="true"
                      focusable="false"
                    >
                      <use href="#i-chevron-right" />
                    </svg>
                  </summary>
                  <div className="sl-models">
                    {looseModels.map(/** @param {*} [m] */ (m: any) => renderModelRow(m, true))}
                  </div>
                </details>
              ) : null}
            </div>
          )}
        </Section>

        {/* ---------- ② 任务分配 ---------- */}
        <Section secKey="llm-capabilities" title="任务分配" sub="能力开关与模型" open>
          <TaskAssignments ai={ai} />
        </Section>

        {/* ---------- ③ 运行状态（默认折叠） ---------- */}
        <Section
          secKey="llm-status"
          title="运行状态"
          sub={status.label + (lastReq ? ' · ' + fmtRel(lastReq.createdAt) : '')}
        >
          <div className="ms-head">
            <span className={'ms-badge ' + status.cls}>{status.label}</span>
            <span
              className="ms-model"
              title={defaultModel ? modelLabel(defaultModel) : '未设置模型'}
            >
              {defaultModel ? modelLabel(defaultModel) : '未设置模型'}
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              id="testLlmBtn"
              disabled={busy === 'test' || !defaultModel}
              onClick={testDefault}
            >
              {busy === 'test' ? '测试中…' : '测试默认模型'}
            </button>
            <span className="ms-head-note">{status.detail}</span>
          </div>

          <Result id="llmStatusResult" result={statusResult} />

          <div className="ms-stats" id="modelStatusStats">
            <div className="ms-stat">
              <span className="ms-stat-label">今日调用</span>
              <strong className="ms-stat-value">{fmtNum(todayCalls)}</strong>
            </div>
            <div className="ms-stat">
              <span className="ms-stat-label">今日失败</span>
              <strong className={'ms-stat-value' + (todayFails ? ' is-fail' : '')}>
                {fmtNum(todayFails)}
              </strong>
            </div>
            <div className="ms-stat">
              <span className="ms-stat-label">最近成功平均耗时</span>
              <strong className="ms-stat-value">{avgMs ? fmtDur(avgMs) : '—'}</strong>
            </div>
          </div>

          <div className="ms-list-head">
            <span className="ms-list-title">历史请求</span>
            <span className="ms-list-note">
              只保留最近 {keepInfo.keep} 条 · {keepInfo.days} 天
            </span>
            <Dropdown
              id="aiRequestsLimit"
              wrapId="aiRequestsLimitDD"
              title="显示条数"
              ariaLabel="显示条数"
              value={String(reqLimit)}
              options={[
                { value: 20, label: '20 条' },
                { value: 50, label: '50 条' },
              ]}
              onChange={
                /** @param {*} [v] */ (v: any) => {
                  // setReqLimit 改变 queryKey，requestsQuery 自动重拉对应条数。
                  setReqLimit(Number(v) || 20);
                }
              }
            />
            <button
              className="btn btn-ghost btn-sm"
              id="modelRefreshAll"
              type="button"
              disabled={reqBusy || usageBusy}
              aria-busy={reqBusy || usageBusy ? 'true' : undefined}
              onClick={refreshAll}
            >
              {reqBusy || usageBusy ? '刷新中…' : '刷新'}
            </button>
          </div>

          {reqLoading ? (
            <div className="ms-skeleton" id="modelRequestLoading" aria-hidden="true">
              <div className="ms-skeleton-row" />
              <div className="ms-skeleton-row" />
              <div className="ms-skeleton-row" />
            </div>
          ) : reqError && !recent.length ? (
            <div className="ms-empty is-err" id="modelRequestError" role="alert">
              <span>读取请求记录失败：{reqError}</span>
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => loadRequests()}>
                重试
              </button>
            </div>
          ) : recent.length === 0 ? (
            <div className="ms-empty" id="modelRequestEmpty">
              还没有请求记录。生成日报、用单篇 AI、打标签或点「测试默认模型」之后，
              每次调用都会记在这里（时间 · 功能 · 内容 · 耗时 · tokens · 结果）。
            </div>
          ) : (
            <ul className="ms-list" id="modelRequestList">
              {recent.map(
                /** @param {*} [r] */ (r: any) => (
                  <li className={'ms-row' + (r.ok ? '' : ' is-fail')} key={r.id} data-kind={r.kind}>
                    <span className="ms-time" title={new Date(r.createdAt).toLocaleString('zh-CN')}>
                      {fmtReqTime(r.createdAt)}
                    </span>
                    <span className="ms-kind">{USAGE_KINDS[r.kind] || r.kind}</span>
                    <span className="ms-label" title={r.label || ''}>
                      {r.label || '—'}
                    </span>
                    <span className="ms-dur">{fmtDur(r.durationMs)}</span>
                    <span className="ms-tok">{r.totalTokens ? fmtTokens(r.totalTokens) : '—'}</span>
                    <span className={'ms-state' + (r.ok ? '' : ' is-fail')}>
                      {r.ok ? '成功' : '失败'}
                    </span>
                    {!r.ok && r.error ? (
                      <span className="ms-err" title={r.error}>
                        {S().errText(r.error, '调用失败')}
                      </span>
                    ) : null}
                  </li>
                ),
              )}
            </ul>
          )}

          <div className="model-sub" data-sec="llm-usage">
            <div className="model-sub-head">
              <span className="model-sub-title">AI 用量</span>
              <span className="sec-sub">
                {usage && usage.today
                  ? `${fmtNum(usage.today.calls)} 次 · ${fmtTokens(usage.today.totalTokens)} tokens（今日）`
                  : '暂无调用'}
              </span>
            </div>
            <div className="usage-grid" id="aiUsageGrid" aria-live="polite">
              {['today', 'days7', 'days30'].map(
                /** @param {*} [k] */ (k: any) => (
                  <div className="usage-cell" key={k}>
                    <span className="usage-cell-label">{USAGE_SPANS[k]}</span>
                    <span className="usage-cell-value">{fmtNum(usage?.[k]?.calls || 0)} 次</span>
                    <span className="usage-cell-sub">
                      {fmtTokens(usage?.[k]?.totalTokens || 0)} tokens
                    </span>
                    {usage?.[k]?.fails ? (
                      <span className="usage-cell-fail">失败 {fmtNum(usage[k].fails)} 次</span>
                    ) : null}
                  </div>
                ),
              )}
            </div>
            {usage && usage.byKind && usage.byKind.length ? (
              <ul className="usage-list" id="aiUsageKinds">
                {usage.byKind.map(
                  /** @param {*} [r] */ (r: any) => (
                    <li key={r.kind}>
                      <span className="usage-kind">{USAGE_KINDS[r.kind] || r.kind}</span>
                      <span className="usage-num">{fmtNum(r.calls)} 次</span>
                      <span className="usage-num">{fmtTokens(r.totalTokens)} tokens</span>
                    </li>
                  ),
                )}
              </ul>
            ) : (
              <small className="form-tip">
                近 30 天还没有调用记录。生成日报、用单篇 AI 或开启 AI 标签后会出现在这里。
              </small>
            )}
            <div className="usage-foot">
              <small className="form-tip">
                统计口径：每次真实调用记一次（失败的也计入次数）。token 只在模型返回 usage 时累加，
                所以上游不回 usage 时次数会增加而 token 不变。
              </small>
            </div>
          </div>
        </Section>
      </div>

      <PaneFoot
        lead={
          <span className="hint">
            模型配置跟随账号：只对你自己生效，不会用上别人的地址或 Key。所有修改即改即生效。
          </span>
        }
      />

      {sheet && sheet.kind === 'model' ? (
        <ModelSheet
          ai={ai}
          model={sheet.id ? currentModel : null}
          initialVendorId={sheet.vendorId || ''}
          onClose={() => setSheet(null)}
          onNeedVendor={() => {
            setPendingModel(true);
            setSheet({ kind: 'vendor', id: null });
          }}
        />
      ) : null}

      {sheet && sheet.kind === 'vendor' ? (
        <VendorSheet
          ai={ai}
          vendor={sheet.id ? currentVendor : null}
          onClose={() => {
            setPendingModel(false);
            setSheet(null);
          }}
          onSaved={() => {
            const wantModel = pendingModel;
            setPendingModel(false);
            setSheet(wantModel ? { kind: 'model', id: null } : null);
          }}
        />
      ) : null}
    </div>
  );
}
