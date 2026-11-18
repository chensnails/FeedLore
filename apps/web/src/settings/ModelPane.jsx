/* 设置弹层「模型」面板（v1.4.0 起 React 化，原 index.html 内联 DOM + app.js 绑定迁移至此）。
 * 行为与旧实现等价且实现更干净：
 * - 表单由受控状态管理（旧实现裸读 DOM .value）；
 * - 进入面板拉一次 /api/prefs 回填（旧 loadModelForm），Key 永不回填明文（服务端只给
 *   apiKeySet + 掩码），留空 = 不修改；temperature 数值化后发送（旧实现传字符串，
 *   依赖服务端 clampNum 容错）；
 * - 保存 / 测试 / 清除三个动作的请求体与旧实现逐字段一致，成功后重新拉取刷新掩码态。
 * - 页面按四张大卡片组织（2026-11-18 深度重构）：
 *   ① 多路提供商管理与添加（llm-library，提到最前）
 *   ② 模式设置（llm-api 默认槽 + llm-thinking 思考模式/深度，合成一张卡）
 *   ③ 能力开关与模型分配（llm-capabilities，6 能力 + 四动作 + AI 标签单开关）
 *   ④ 模型状态与统计（llm-status 状态/历史 + llm-usage 用量，合成一张卡）
 *   AI 标签开关 0016 起收口到能力开关区，废弃 prefs.aiTags，不再单列 Section。
 *
 * 卡片靠 Section 的可选 cardNo/cardDesc 渲染；四个 data-sec 锚点保持原样
 * （llm-library / llm-api / llm-capabilities / llm-status 仍指向对应卡片），
 * 旧测试与巡检选择器不失效。所有控件 id / data-cap 逐字保留。 */

import { core } from '@core';
import React, { useEffect, useRef, useState } from 'react';
import { PaneFoot, Result, Section, useFormLoadGuard } from './primitives.jsx';
import { NO_AUTOFILL_PROPS, useNoAutofillName } from '../ui/noAutofill.js';
import { Dropdown } from '../views/Dropdown.jsx';
import { useAiCapabilities, ModelLibrary, CapabilitySwitches } from './AiCapabilities.jsx';

const S = () => core;   // 核心逻辑单例（@core，v2.0.0 起改为模块引用）

const MODEL_PRESETS = [
  'Qwen/Qwen3-8B',
  'Qwen/Qwen3-30B-A3B-Instruct-2507',
  'Qwen/Qwen3-235B-A22B-Instruct-2507',
  'deepseek-ai/DeepSeek-V3',
  'THUDM/GLM-4-9B-0414',
];

const EMPTY = {
  baseUrl: '', model: '', temperature: '0.3', apiKeySet: false, apiKeyHint: '',
  thinking: false, thinkingDepth: 'medium',
};

const USAGE_SPANS = { today: '今日', days7: '近 7 天', days30: '近 30 天' };
const USAGE_KINDS = {
  digest: '日报生成',
  entry_ai: '单篇 AI',
  ai_tags: 'AI 标签',
  mcp: 'MCP 调用',
  test: '测试模型',
};

const fmtNum = (n) => Number(n || 0).toLocaleString('zh-CN');
const fmtTokens = (n) => {
  const v = Number(n || 0);
  if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M';
  if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
  return String(v);
};

const parseTemp = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0.3;
};

/* ---- 请求明细的时间 / 耗时呈现 ---- */
const pad2 = (n) => String(n).padStart(2, '0');
/** 当天只给 HH:MM，跨天补 MM-DD —— 列表里全是「今天 16:02」会看不出是哪一天。 */
const fmtReqTime = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  return d.toDateString() === new Date().toDateString() ? hm : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hm}`;
};
/** 相对时间：状态徽标旁只放「2 分钟前」这种短说法。 */
const fmtRel = (iso) => {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  const diff = Date.now() - t;
  if (diff < 60e3) return '刚刚';
  if (diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前';
  if (diff < 86400e3) return Math.floor(diff / 3600e3) + ' 小时前';
  return Math.floor(diff / 86400e3) + ' 天前';
};
const fmtDur = (ms) => {
  const v = Number(ms || 0);
  if (!v) return '—';
  if (v < 1000) return v + 'ms';
  return v >= 10000 ? Math.round(v / 1000) + 's' : (v / 1000).toFixed(1) + 's';
};

/* 思考深度：界面用 low/medium/high 三档，v2 落库是 1/2/3 的整数（0 表示未设置）。
   两边显式换算，别依赖服务端「数字转字符串」——契约里写的就是 number。 */
const depthToNum = (d) => (d === 'low' ? 1 : d === 'high' ? 3 : 2);
const numToDepth = (n) => (n === 1 ? 'low' : n === 3 ? 'high' : 'medium');
const DEPTH_LABEL = { low: '轻', medium: '中', high: '深' };

export function ModelPane({ onDirtyChange }) {
  const keyName = useNoAutofillName('llm-key');
  // 模型地址紧挨着密码框，Chrome/Edge Android 会把它启发式当成账号字段，把保存的
  // username 塞进来。给它和 Key 一样的非语义唯一 name + 反填充标记（见 ui/noAutofill.js）。
  const urlName = useNoAutofillName('llm-url');
  const paneRef = useRef(null);
  // 模型库与能力开关共享一份取数（一次 GET），两个展示组件分别挂到对应层级。
  const aiCap = useAiCapabilities();
  const [form, setForm] = useState(EMPTY);
  const [savedForm, setSavedForm] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  // result: { ok, msg } | null
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState('');   // '' | 'test' | 'save' | 'clear'
  /* enable_thinking 全局开关：默认槽的思考配置。点一下即落库，失败回滚。
     它必须写进账号的模型配置（`user_llm.thinking`），下一次调用起生效，
     而不是每次请求由前端临时传参：前端传参会出现「日报带了、单篇没带」的漂移。 */
  const [thinkingBusy, setThinkingBusy] = useState(false);
  /* AI 用量：进页面拉一次，之后手动刷新。读接口不消耗额度。 */
  const [usage, setUsage] = useState(null);
  const [usageBusy, setUsageBusy] = useState(false);
  /* 模型状态：最近调用明细 + 上游模型列表。
     - requests 为 null = 读取中；读取失败只影响这一块（下方仍可改配置）。
     - modelList 为 null = 还没拉过上游列表，输入框照旧手填 + 预设。 */
  const [requests, setRequests] = useState(null);
  const [reqError, setReqError] = useState('');
  const [reqBusy, setReqBusy] = useState(false);
  const [reqLimit, setReqLimit] = useState(20);
  const [keepInfo, setKeepInfo] = useState({ keep: 200, days: 30 });
  const [modelList, setModelList] = useState(null);
  const [modelBusy, setModelBusy] = useState(false);
  const [modelErr, setModelErr] = useState('');
  // 与日报面板同一条守卫：GET 回来前用户已输入，就不能用服务端旧值覆盖表单
  const guard = useFormLoadGuard();

  /* ---- 未保存改动：表单指纹 + 已输入但未保存的 Key ---- */
  const formDirty = !!savedForm && JSON.stringify(form) !== savedForm;
  const dirty = formDirty || apiKey.trim() !== '';
  useEffect(() => {
    if (onDirtyChange) onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  // 进入「模型」页拉一次配置（旧 loadModelForm 的迁移）；面板随 tab 切换挂载/卸载。
  // 注意：不清 result——保存 / 清除成功后要保留「已保存」提示（与旧实现一致），
  // 读取失败时才在 catch 里置 err；初次进入时 result 本就为 null。
  useEffect(() => { load(); loadUsage(); loadRequests(); }, []);

  // 折叠分组的开合按账号持久化（与其他设置面板同一机制）
  useEffect(() => {
    const s = S();
    if (s && s.bindSections && paneRef.current) s.bindSections(paneRef.current);
  }, []);

  // force：保存 / 清除成功后的主动重拉，属于「用户已确认」，必须允许回填并重置 touched；
  // 只有挂载那次（load() 无参）才受守卫保护，避免覆盖加载期间的输入。
  async function load(force = false) {
    if (force) guard.reset();
    try {
      const res = await S().apiFetch('/api/prefs');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const llm = data.llm || {};
      const next = {
        baseUrl: llm.baseUrl || '',
        model: llm.model || '',
        temperature: String(llm.temperature == null ? 0.3 : llm.temperature),
        thinking: llm.thinking === true,
        thinkingDepth: numToDepth(llm.thinkingDepth),
        apiKeySet: !!llm.apiKeySet,
        apiKeyHint: llm.apiKeyHint || '••••',
      };
      // 用户已在加载完成前输入：只补一条脏态基线，不覆盖任何输入框
      const applied = guard.apply(() => {
        setForm(next);
        setSavedForm(JSON.stringify(next));
        // Key 输入框每次回填都清空并回到掩码态：留空 = 不修改
        setApiKey('');
        setShowKey(false);
      });
      if (!applied) setSavedForm((s) => s || JSON.stringify(EMPTY));
    } catch (err) {
      // 读取失败时以当前空表单为基线，用户仍可手填后保存
      guard.apply(() => setSavedForm(JSON.stringify(EMPTY)));
      setResult({ ok: false, msg: '读取配置失败：' + String((err && err.message) || err) });
    }
  }

  const set = (k) => (ev) => { guard.mark(); setForm((f) => Object.assign({}, f, { [k]: ev.target.value })); };

  const onTest = async () => {
    setBusy('test');
    setResult(null);
    try {
      const res = await S().apiFetch('/api/digest/test-llm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // 测试连接真的发一次模型请求（服务端上限 45s），别被 30s 写超时先掐断
        timeoutMs: S().AI_TIMEOUT_MS || 200000,
        body: JSON.stringify({
          llm: {
            baseUrl: form.baseUrl, apiKey, model: form.model,
            // 思考两项也带上：刚把开关拨开、还没保存就能试出这上游认不认
            thinking: form.thinking, thinkingDepth: depthToNum(form.thinkingDepth),
          },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.ok) setResult({ ok: true, msg: `模型可用：${data.reply || '连接正常'}` });
      else setResult({ ok: false, msg: '调用失败：' + S().errText(data, '未知错误') });
    } catch (err) {
      setResult({ ok: false, msg: '调用失败：' + String((err && err.message) || err) });
    } finally {
      setBusy('');
    }
  };

  // 当前表单值 → 保存用的 llm 片段（Key 留空则不传，服务端沿用原密文）
  const llmPatch = (extra) => Object.assign({
    baseUrl: form.baseUrl,
    model: form.model,
    temperature: parseTemp(form.temperature),
    thinking: form.thinking,
    thinkingDepth: depthToNum(form.thinkingDepth),
  }, extra);

  const onSave = async () => {
    setBusy('save');
    try {
      const typedKey = apiKey.trim();
      const res = await S().apiFetch('/api/prefs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ llm: llmPatch(typedKey ? { apiKey: typedKey } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setResult({ ok: false, msg: S().errText(data, '保存失败') }); return; }
      const msg = typedKey ? '模型配置与 API Key 已保存' : '模型配置已保存';
      // 表单保存只用内联结果，不再叠一层 toast（列表级动作才用 toast）
      setResult({ ok: true, msg });
      await load(true);
      // 保存成功后自动拉一次上游模型列表（Key 都没配就别白跑一趟）
      if (typedKey || form.apiKeySet) refreshModels(true);
      // 配置可能已经能用了，顺手刷新状态区，别让「最近失败」停在旧结论上
      loadRequests();
    } catch (err) {
      setResult({ ok: false, msg: '保存失败：' + String((err && err.message) || err) });
    } finally {
      setBusy('');
    }
  };

  const onClearKey = async () => {
    const ok = await S().confirm({
      title: '清除已保存的 API Key？',
      desc: '清除后这个账号将无法调用模型，日报直到重新填写前都生成不了。',
      confirmText: '清除',
      danger: true,
    });
    if (!ok) return;
    setBusy('clear');
    try {
      const res = await S().apiFetch('/api/prefs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ llm: llmPatch({ clearApiKey: true }) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setResult({ ok: false, msg: S().errText(data, '清除失败') }); return; }
      setResult({ ok: true, msg: 'API Key 已清除' });
      await load(true);
      // Key 没了就拉不到模型列表，把上一次的结果一并清掉，免得下拉里还留着过期的名字
      setModelList(null);
      setModelErr('');
    } catch (err) {
      setResult({ ok: false, msg: '清除失败：' + String((err && err.message) || err) });
    } finally {
      setBusy('');
    }
  };

  /* 把 enable_thinking / 深度写进账号模型配置。返回 true 表示已落库。
   * 只提交这一个字段：`user_llm` 的保存是部分更新语义，不会碰用户还没保存的其它输入。 */
  async function patchThinking(patch, okMsg) {
    const res = await S().apiFetch('/api/prefs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ llm: patch }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setResult({ ok: false, msg: S().errText(data, '保存思考开关失败') });
      return false;
    }
    setResult({ ok: true, msg: okMsg });
    return true;
  }

  /* 保存成功后同步脏态基线：开关是即时生效的，不该让页面一直显示「有未保存的更改」。 */
  function syncSavedForm(patch) {
    setSavedForm((s) => {
      if (!s) return s;
      try { return JSON.stringify(Object.assign(JSON.parse(s), patch)); } catch { return s; }
    });
  }

  /** enable_thinking 开关：默认关；作用于本账号全部 AI 调用（日报 / 单篇 / 标签 / MCP / 测试）。 */
  const onToggleThinking = async (ev) => {
    const on = ev.target.checked;
    if (thinkingBusy) return;
    const prev = form.thinking;
    guard.mark();
    setForm((f) => Object.assign({}, f, { thinking: on }));
    setThinkingBusy(true);
    try {
      const ok = await patchThinking({ thinking: on }, on ? '已开启模型思考（全部 AI 调用生效）' : '已关闭模型思考（全部 AI 调用生效）');
      if (!ok) { setForm((f) => Object.assign({}, f, { thinking: prev })); return; }
      syncSavedForm({ thinking: on });
    } catch (err) {
      setForm((f) => Object.assign({}, f, { thinking: prev }));
      setResult({ ok: false, msg: '保存思考开关失败：' + String((err && err.message) || err) });
    } finally {
      setThinkingBusy(false);
    }
  };

  /** 思考深度同样是账号级配置，改完即生效（只有开思考时才有意义）。 */
  const onDepthChange = async (depth) => {
    if (thinkingBusy) return;
    const prev = form.thinkingDepth;
    guard.mark();
    setForm((f) => Object.assign({}, f, { thinkingDepth: depth }));
    setThinkingBusy(true);
    try {
      const ok = await patchThinking({ thinkingDepth: depthToNum(depth) }, `思考深度已设为「${DEPTH_LABEL[depth] || '中'}」`);
      if (!ok) { setForm((f) => Object.assign({}, f, { thinkingDepth: prev })); return; }
      syncSavedForm({ thinkingDepth: depth });
    } catch (err) {
      setForm((f) => Object.assign({}, f, { thinkingDepth: prev }));
      setResult({ ok: false, msg: '保存思考深度失败：' + String((err && err.message) || err) });
    } finally {
      setThinkingBusy(false);
    }
  };

  async function loadUsage() {
    setUsageBusy(true);
    try {
      const res = await S().apiFetch('/api/ai-usage?days=30');
      const data = await res.json().catch(() => ({}));
      // 读失败不打扰用户：这一块是参考信息，静默留空即可
      if (res.ok) setUsage(data);
    } catch {
      /* 忽略 */
    } finally {
      setUsageBusy(false);
    }
  }

  /* 最近调用明细：只读接口。读失败只在「模型状态」区里报，不影响上面的配置表单。 */
  async function loadRequests(limit = reqLimit) {
    setReqBusy(true);
    setReqError('');
    try {
      const res = await S().apiFetch('/api/ai-requests?limit=' + encodeURIComponent(String(limit)));
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(S().errText(data, 'HTTP ' + res.status));
      setRequests(Array.isArray(data.requests) ? data.requests : []);
      setKeepInfo({
        keep: Number(data.keep) > 0 ? Number(data.keep) : 200,
        days: Number(data.keepDays) > 0 ? Number(data.keepDays) : 30,
      });
    } catch (err) {
      setReqError(String((err && err.message) || err));
      setRequests((prev) => (Array.isArray(prev) ? prev : []));
    } finally {
      setReqBusy(false);
    }
  }

  /* 拉上游模型列表（OpenAI 兼容 GET {base}/models）。
     - 临时带上输入框刚填的 baseUrl / Key：还没保存也该能拉；
     - auto=true 是保存成功后自动跑一次：失败只在这块提示，不打断保存结果；
     - 失败一律退回手填，不做成阻塞。 */
  async function refreshModels(auto = false) {
    if (modelBusy) return;
    setModelBusy(true);
    setModelErr('');
    try {
      const typedKey = apiKey.trim();
      const res = await S().apiFetch('/api/llm/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // 上游拉列表可能慢（服务端 20s 上限），留出余量
        timeoutMs: S().AI_TIMEOUT_MS || 200000,
        body: JSON.stringify({
          llm: Object.assign({ baseUrl: form.baseUrl }, typedKey ? { apiKey: typedKey } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(S().errText(data, '获取模型列表失败'));
      if (!data.ok) {
        setModelList(null);
        setModelErr(S().errText(data, '上游没有返回模型列表，请手动填写模型名称'));
        return;
      }
      const list = Array.isArray(data.models) ? data.models : [];
      setModelList(list.length ? list : null);
      if (!list.length) setModelErr('上游没有返回模型列表，请手动填写模型名称');
    } catch (err) {
      setModelList(null);
      setModelErr((auto ? '自动获取模型列表失败：' : '') + String((err && err.message) || err));
    } finally {
      setModelBusy(false);
    }
  }

  const saved = form.apiKeySet;

  /* ---- 模型状态：只用本地记录推断，不额外打一次模型（看状态不烧 token） ---- */
  const recent = Array.isArray(requests) ? requests : [];
  const lastReq = recent[0] || null;
  const status = (() => {
    if (!saved || !String(form.model || '').trim()) {
      return { cls: 'is-off', label: '未配置', detail: '地址 / Key / 模型名三项齐了才能调用' };
    }
    if (requests === null && !reqError) return { cls: 'is-idle', label: '读取中…', detail: '' };
    if (reqError && !recent.length) return { cls: 'is-fail', label: '状态未知', detail: reqError };
    if (!lastReq) return { cls: 'is-idle', label: '未测试', detail: '还没有调用记录，可以用底部的「测试模型」先验一次' };
    if (lastReq.ok) {
      return {
        cls: 'is-ok',
        label: '可用',
        detail: `最近一次成功 · ${fmtRel(lastReq.createdAt)} · ${USAGE_KINDS[lastReq.kind] || lastReq.kind}`,
      };
    }
    // 失败原因可能是 `E_AI_TIMEOUT: ...` 这类稳定码，过一遍词典；英文原文留在列表行的 title 里
    return { cls: 'is-fail', label: '最近失败', detail: `${fmtRel(lastReq.createdAt)} · ${S().errText(lastReq.error || '', '调用失败')}` };
  })();
  const avgMs = (() => {
    const ok = recent.filter((r) => r.ok && Number(r.durationMs) > 0);
    if (!ok.length) return 0;
    return Math.round(ok.reduce((a, r) => a + Number(r.durationMs), 0) / ok.length);
  })();
  const todayCalls = usage?.today?.calls || 0;
  const todayFails = usage?.today?.fails || 0;
  const reqLoading = requests === null && !reqError;

  return (
    <div className="tab-pane" data-pane="model" ref={paneRef}>
      <div className="pane-scroll">
        {/* ① 模型配置层：默认模型的额外模型列表 / 添加，与「接口与密钥」同层。
            共享 aiCap 的取数，即时保存、不进表单脏态。 */}
        <Section secKey="llm-library" title="多路提供商管理" sub="添加并统一管理多个模型" cardNo="01" cardDesc="添加一个或多个 OpenAI 兼容模型，供下方各项能力按需分配；未单独分配的任务走默认模型。">
          <ModelLibrary cap={aiCap} />
        </Section>
        <Section secKey="llm-api" title="模式设置" sub={form.model || '未配置'} cardNo="02" cardDesc="默认模型的地址、密钥与生成参数，以及思考模式开关与深度。这里的默认模型兜底所有未单独分配的能力。" open>
        <div className="form-row">
          <label htmlFor="llmBaseUrl">模型地址（OpenAI 兼容）</label>
          <input
            id="llmBaseUrl"
            name={urlName}
            type="url"
            placeholder="https://api.siliconflow.cn/v1/chat/completions"
            value={form.baseUrl}
            onChange={set('baseUrl')}
            {...NO_AUTOFILL_PROPS}
          />
          <small className="form-tip">支持任意 OpenAI 兼容接口；填到 <code>/v1</code> 或完整的 <code>/chat/completions</code> 均可</small>
        </div>
        <div className="form-row">
          <label htmlFor="llmApiKey">API Key</label>
          <div className="input-with-btn">
            <input
              id="llmApiKey"
              name={keyName}
              type={showKey ? 'text' : 'password'}
              placeholder={saved ? '已保存，留空则不修改' : 'sk-...'}
              value={apiKey}
              onChange={(ev) => { guard.mark(); setApiKey(ev.target.value); }}
              {...NO_AUTOFILL_PROPS}
            />
            <button
              className="btn btn-ghost btn-sm"
              id="toggleLlmKey"
              type="button"
              onClick={() => setShowKey((v) => !v)}
            >
              {showKey ? '隐藏' : '显示'}
            </button>
            <button
              className="btn btn-ghost btn-sm"
              id="clearLlmKey"
              type="button"
              hidden={!saved}
              disabled={busy === 'clear'}
              onClick={onClearKey}
            >
              清除
            </button>
          </div>
          <small className="form-tip" id="llmKeyHint">
            {saved ? (
              <>已保存：<code>{form.apiKeyHint}</code> · 加密存储，不回显明文；要更换就直接粘贴新的，要删除点「清除」</>
            ) : (
              <>尚未设置。保存后以加密形式落库，页面只显示掩码。</>
            )}
          </small>
        </div>
        <div className="form-grid form-grid-2">
          <div className="form-row">
            <label htmlFor="llmModel">模型名称</label>
            {/* 输入框保持可手填：/models 拉不到（或上游不实现）时照样能填名字。
                候选用自绘 Dropdown，不用 datalist —— Android Chrome 把多项 datalist
                渲染成一排空心胶囊（点不动、看不清），真机实测不可用。 */}
            <div className="input-with-btn">
              <input
                id="llmModel"
                type="text"
                placeholder="Qwen/Qwen3-8B"
                spellCheck="false"
                value={form.model}
                onChange={set('model')}
              />
              <Dropdown
                id="modelPickBtn"
                wrapId="modelPickDD"
                title="从列表选择模型"
                ariaLabel="从列表选择模型"
                valueLabel="选模型"
                options={(modelList && modelList.length ? modelList : MODEL_PRESETS).map((m) => ({ value: m, label: m }))}
                onChange={(v) => { guard.mark(); setForm((f) => Object.assign({}, f, { model: String(v) })); }}
              />
              <button
                className="btn btn-ghost btn-sm"
                id="fetchModelsBtn"
                type="button"
                disabled={modelBusy}
                aria-busy={modelBusy ? 'true' : undefined}
                title="向当前模型地址请求 /models，拉取可用模型名"
                onClick={() => refreshModels(false)}
              >
                {modelBusy ? '获取中…' : modelList ? '重新获取' : '获取模型'}
              </button>
            </div>
            {modelErr ? (
              <small className="form-tip is-warn" id="modelListHint" role="status">{modelErr}</small>
            ) : modelList ? (
              <small className="form-tip" id="modelListHint" role="status">
                已从上游获取 {modelList.length} 个模型，点「选模型」从列表挑；也可以继续手填。
              </small>
            ) : null}
            {/* 思考模式的说明与「列表状态」分开两条：拉到列表后这条不该消失 */}
            <small className="form-tip" id="llmModelTip">免费额度推荐 <strong>Qwen/Qwen3-8B</strong>；{form.thinking
              ? '已开启思考：系统提示改用 /think，并随请求下发思考预算'
              : '系统提示内置 /no_think 关闭思考模式，速度更快'}
            </small>
          </div>
          <div className="form-row">
            <label htmlFor="llmTemp">温度</label>
            <input
              id="llmTemp"
              type="number"
              min="0"
              max="1.5"
              step="0.05"
              value={form.temperature}
              onChange={set('temperature')}
            />
            <small className="form-tip">越低越稳定保守，越高越发散。摘要建议 0.2 ~ 0.5</small>
          </div>
        </div>
        {/* 卡片 02 内的「思考模式」子节：与默认模型同属一张卡，不再单独折叠。
            enable_thinking 是账号级开关（默认关），拨动即落库；它决定每次调用快 10 倍还是慢 10 倍。 */}
        <div className="model-sub" data-sec="llm-thinking">
          <div className="model-sub-head">
            <span className="model-sub-title">思考模式</span>
            <span className="sec-sub">{form.thinking ? `已开启 · 深度${DEPTH_LABEL[form.thinkingDepth]}` : '已关闭 · 全部调用生效'}</span>
          </div>
        <div className="form-row">
          <label className="form-row-head">
            <span>让模型先思考再回答</span>
            <span className="switch">
              <input
                id="llmThinking"
                type="checkbox"
                checked={form.thinking}
                disabled={thinkingBusy}
                onChange={onToggleThinking}
              />
              <span className="switch-slider" />
            </span>
          </label>
          <small className="form-tip">
            <b>默认关闭，拨动即生效</b>，作用于本账号全部 AI 调用。关闭时每次请求带
            <code>enable_thinking: false</code>，只给答案不给推理（同一篇长文实测 56 秒降到 4 秒）；
            打开后先思考再答，更贴复杂选材但明显更慢、更耗额度。仅对 Qwen3 / DeepSeek 这类支持思考的模型有效；
            上游不认识该字段时会自动去掉重试。
          </small>
        </div>
        <div className="form-row" hidden={!form.thinking}>
          <label>思考深度</label>
          <Dropdown id="llmDepth" wrapId="llmDepthDD" title="思考深度" ariaLabel="思考深度"
            value={form.thinkingDepth} disabled={thinkingBusy} onChange={(v) => onDepthChange(v)}
            options={[
              { value: 'low', label: '轻 · 少量推理，接近不开思考' },
              { value: 'medium', label: '中 · 默认，够它把选材想过一遍' },
              { value: 'high', label: '深 · 充分推理，长清单时更明显' },
            ]} />
          <small className="form-tip">账号级配置，改完即生效；日报「中」通常够，条目多、分类总跑偏时才用「深」。</small>
        </div>
        </div>
        </Section>
        {/* ③ 能力开关层：6 个能力的开关 + 模型分配，标签单开关也在这里（0016）。 */}
        <Section secKey="llm-capabilities" title="能力开关与模型分配" sub="每个任务用哪个模型" cardNo="03" cardDesc="按能力启停 AI 调用并指定模型；关闭后服务端直接拒绝此类调用，不再消耗额度。">
          <CapabilitySwitches cap={aiCap} />
        </Section>
        {/* ③ 运行诊断层：模型状态（本地最近一次调用推断）+ 用量统计。
            「测试模型」放在底部动作栏——看状态不消耗额度，点测试才真调一次。 */}
        <Section secKey="llm-status" title="模型状态与统计"
          sub={status.label + (lastReq ? ' · ' + fmtRel(lastReq.createdAt) : '')}
          cardNo="04" cardDesc="最近一次调用推断的可用状态、请求历史与近 30 天用量。查看不消耗额度，点底部「测试模型」才真调一次。">
          <div className="ms-head">
            <span className={'ms-badge ' + status.cls}>{status.label}</span>
            <span className="ms-model" title={String(form.model || '').trim() || '未设置模型'}>
              {String(form.model || '').trim() || '未设置模型'}
            </span>
            {status.detail ? <span className="ms-head-note">{status.detail}</span> : null}
          </div>

          <div className="ms-stats" id="modelStatusStats">
            <div className="ms-stat">
              <span className="ms-stat-label">今日调用</span>
              <strong className="ms-stat-value">{fmtNum(todayCalls)}</strong>
            </div>
            <div className="ms-stat">
              <span className="ms-stat-label">今日失败</span>
              <strong className={'ms-stat-value' + (todayFails ? ' is-fail' : '')}>{fmtNum(todayFails)}</strong>
            </div>
            <div className="ms-stat">
              <span className="ms-stat-label">最近成功平均耗时</span>
              <strong className="ms-stat-value">{avgMs ? fmtDur(avgMs) : '—'}</strong>
            </div>
          </div>

          <div className="ms-list-head">
            <span className="ms-list-title">历史请求</span>
            <span className="ms-list-note">只保留最近 {keepInfo.keep} 条 · {keepInfo.days} 天</span>
            <Dropdown id="aiRequestsLimit" wrapId="aiRequestsLimitDD" title="显示条数"
              ariaLabel="显示条数" value={String(reqLimit)}
              options={[{ value: 20, label: '20 条' }, { value: 50, label: '50 条' }]}
              onChange={(v) => { const n = Number(v) || 20; setReqLimit(n); loadRequests(n); }} />
            <button className="btn btn-ghost btn-sm" id="aiRequestsRefresh" type="button"
              disabled={reqBusy} aria-busy={reqBusy ? 'true' : undefined} onClick={() => loadRequests()}>
              {reqBusy ? '刷新中…' : '刷新'}
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
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => loadRequests()}>重试</button>
            </div>
          ) : recent.length === 0 ? (
            <div className="ms-empty" id="modelRequestEmpty">
              还没有请求记录。生成日报、用单篇 AI、打标签或点底部「测试模型」之后，
              每次调用都会记在这里（时间 · 功能 · 内容 · 耗时 · tokens · 结果）。
            </div>
          ) : (
            <ul className="ms-list" id="modelRequestList">
              {recent.map((r) => (
                <li className={'ms-row' + (r.ok ? '' : ' is-fail')} key={r.id} data-kind={r.kind}>
                  <span className="ms-time" title={new Date(r.createdAt).toLocaleString('zh-CN')}>{fmtReqTime(r.createdAt)}</span>
                  <span className="ms-kind">{USAGE_KINDS[r.kind] || r.kind}</span>
                  <span className="ms-label" title={r.label || ''}>{r.label || '—'}</span>
                  <span className="ms-dur">{fmtDur(r.durationMs)}</span>
                  <span className="ms-tok">{r.totalTokens ? fmtTokens(r.totalTokens) : '—'}</span>
                  <span className={'ms-state' + (r.ok ? '' : ' is-fail')}>{r.ok ? '成功' : '失败'}</span>
                  {!r.ok && r.error ? <span className="ms-err" title={r.error}>{S().errText(r.error, '调用失败')}</span> : null}
                </li>
              ))}
            </ul>
          )}
          <small className="form-tip">
            状态按最近一次调用推断：成功即「可用」，失败即「最近失败」并给出原因。
            想立刻确认，点底部「测试模型」——那会真的调一次并在列表里留一条记录。
          </small>
        {/* 卡片 04 内的「AI 用量」子节：与状态/历史同属一张卡，不再单独折叠。 */}
        <div className="model-sub" data-sec="llm-usage">
          <div className="model-sub-head">
            <span className="model-sub-title">AI 用量</span>
            <span className="sec-sub">{usage && usage.today ? `${fmtNum(usage.today.calls)} 次 · ${fmtTokens(usage.today.totalTokens)} tokens（今日）` : '暂无调用'}</span>
          </div>
        <div className="usage-grid" id="aiUsageGrid" aria-live="polite">
          {['today', 'days7', 'days30'].map((k) => (
            <div className="usage-cell" key={k}>
              <span className="usage-cell-label">{USAGE_SPANS[k]}</span>
              <span className="usage-cell-value">{fmtNum(usage?.[k]?.calls || 0)} 次</span>
              <span className="usage-cell-sub">{fmtTokens(usage?.[k]?.totalTokens || 0)} tokens</span>
              {usage?.[k]?.fails ? <span className="usage-cell-fail">失败 {fmtNum(usage[k].fails)} 次</span> : null}
            </div>
          ))}
        </div>
        {usage && usage.byKind && usage.byKind.length ? (
          <ul className="usage-list" id="aiUsageKinds">
            {usage.byKind.map((r) => (
              <li key={r.kind}>
                <span className="usage-kind">{USAGE_KINDS[r.kind] || r.kind}</span>
                <span className="usage-num">{fmtNum(r.calls)} 次</span>
                <span className="usage-num">{fmtTokens(r.totalTokens)} tokens</span>
              </li>
            ))}
          </ul>
        ) : (
          <small className="form-tip">近 30 天还没有调用记录。生成日报、用单篇 AI 或开启 AI 标签后会出现在这里。</small>
        )}
        <div className="usage-foot">
          <small className="form-tip">
            统计口径：每次真实调用记一次（失败的也计入次数）。token 只在模型返回 usage 时累加，
            所以上游不回 usage 时次数会增加而 token 不变。
          </small>
          <button className="btn btn-ghost btn-sm" id="aiUsageRefresh" type="button"
            disabled={usageBusy} onClick={loadUsage}>
            {usageBusy ? '刷新中…' : '刷新'}
          </button>
        </div>
        </div>
        </Section>

        {result ? <Result id="llmResult" result={result} /> : null}
      </div>
      <PaneFoot dirty={dirty} lead={<span className="hint">模型配置完全跟随账号：这一份只对你自己生效，不会用上别人的地址或 Key，也没有站点默认值可回退——三项都填好才能生成日报</span>}>
        <button
          className="btn btn-ghost"
          id="testLlmBtn"
          type="button"
          disabled={busy === 'test'}
          onClick={onTest}
        >
          {busy === 'test' ? '测试中…' : '测试模型'}
        </button>
        <button
          className="btn btn-primary"
          id="saveLlmBtn"
          type="button"
          disabled={busy === 'save' || !dirty}
          onClick={onSave}
        >
          {busy === 'save' ? '保存中…' : '保存模型'}
        </button>
      </PaneFoot>
    </div>
  );
}
