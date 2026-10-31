/* 设置弹层「模型」面板（v1.4.0 起 React 化，原 index.html 内联 DOM + app.js 绑定迁移至此）。
 * 行为与旧实现等价且实现更干净：
 * - 表单由受控状态管理（旧实现裸读 DOM .value）；
 * - 进入面板拉一次 /api/prefs 回填（旧 loadModelForm），Key 永不回填明文（服务端只给
 *   apiKeySet + 掩码），留空 = 不修改；temperature 数值化后发送（旧实现传字符串，
 *   依赖服务端 clampNum 容错）；
 * - 保存 / 测试 / 清除三个动作的请求体与旧实现逐字段一致，成功后重新拉取刷新掩码态。
 * 类名 / ID / data 属性与旧 DOM 完全一致，样式零改动。 */

import { core } from '@core';
import React, { useEffect, useState } from 'react';

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

const parseTemp = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0.3;
};

/* 思考深度：界面用 low/medium/high 三档，v2 落库是 1/2/3 的整数（0 表示未设置）。
   两边显式换算，别依赖服务端「数字转字符串」——契约里写的就是 number。 */
const depthToNum = (d) => (d === 'low' ? 1 : d === 'high' ? 3 : 2);
const numToDepth = (n) => (n === 1 ? 'low' : n === 3 ? 'high' : 'medium');

export function ModelPane() {
  const [form, setForm] = useState(EMPTY);
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  // result: { ok, msg } | null
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState('');   // '' | 'test' | 'save' | 'clear'

  // 进入「模型」页拉一次配置（旧 loadModelForm 的迁移）；面板随 tab 切换挂载/卸载。
  // 注意：不清 result——保存 / 清除成功后要保留「已保存」提示（与旧实现一致），
  // 读取失败时才在 catch 里置 err；初次进入时 result 本就为 null。
  useEffect(() => { load(); }, []);

  async function load() {
    try {
      const res = await S().apiFetch('/api/prefs');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const llm = data.llm || {};
      setForm({
        baseUrl: llm.baseUrl || '',
        model: llm.model || '',
        temperature: String(llm.temperature == null ? 0.3 : llm.temperature),
        thinking: llm.thinking === true,
        thinkingDepth: numToDepth(llm.thinkingDepth),
        apiKeySet: !!llm.apiKeySet,
        apiKeyHint: llm.apiKeyHint || '••••',
      });
      // Key 输入框每次回填都清空并回到掩码态：留空 = 不修改
      setApiKey('');
      setShowKey(false);
    } catch (err) {
      setResult({ ok: false, msg: '读取配置失败：' + String((err && err.message) || err) });
    }
  }

  const set = (k) => (ev) => setForm((f) => Object.assign({}, f, { [k]: ev.target.value }));

  const onTest = async () => {
    setBusy('test');
    setResult(null);
    try {
      const res = await S().apiFetch('/api/digest/test-llm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
      else setResult({ ok: false, msg: '调用失败：' + (data.error || '未知错误') });
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
      if (!res.ok) { setResult({ ok: false, msg: data.error || '保存失败' }); return; }
      const msg = typedKey ? '模型配置与 API Key 已保存' : '模型配置已保存';
      // 表单保存只用内联结果，不再叠一层 toast（列表级动作才用 toast）
      setResult({ ok: true, msg });
      await load();
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
      if (!res.ok) { setResult({ ok: false, msg: data.error || '清除失败' }); return; }
      setResult({ ok: true, msg: 'API Key 已清除' });
      await load();
    } catch (err) {
      setResult({ ok: false, msg: '清除失败：' + String((err && err.message) || err) });
    } finally {
      setBusy('');
    }
  };

  const saved = form.apiKeySet;

  return (
    <div className="tab-pane" data-pane="model">
      <div className="form">
        <div className="form-row">
          <label htmlFor="llmBaseUrl">模型地址（OpenAI 兼容）</label>
          <input
            id="llmBaseUrl"
            type="url"
            placeholder="https://api.siliconflow.cn/v1/chat/completions"
            spellCheck="false"
            value={form.baseUrl}
            onChange={set('baseUrl')}
          />
          <small className="form-tip">支持任意 OpenAI 兼容接口；填到 <code>/v1</code> 或完整的 <code>/chat/completions</code> 均可</small>
        </div>
        <div className="form-row">
          <label htmlFor="llmApiKey">API Key</label>
          <div className="input-with-btn">
            <input
              id="llmApiKey"
              type={showKey ? 'text' : 'password'}
              placeholder={saved ? '已保存，留空则不修改' : 'sk-...'}
              spellCheck="false"
              autoComplete="off"
              value={apiKey}
              onChange={(ev) => setApiKey(ev.target.value)}
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
            <input
              id="llmModel"
              type="text"
              placeholder="Qwen/Qwen3-8B"
              spellCheck="false"
              list="modelPresets"
              value={form.model}
              onChange={set('model')}
            />
            <datalist id="modelPresets">
              {MODEL_PRESETS.map((m) => <option key={m} value={m} />)}
            </datalist>
            <small className="form-tip">免费额度推荐 <strong>Qwen/Qwen3-8B</strong>；{form.thinking
              ? '已开启思考：系统提示改用 /think，并随请求下发思考预算'
              : '系统提示内置 /no_think 关闭思考模式，速度更快'}</small>
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
        <div className="form-row">
          <label className="form-row-head">
            <span>开启模型思考</span>
            <span className="switch">
              <input
                id="llmThinking"
                type="checkbox"
                checked={form.thinking}
                onChange={(ev) => setForm((f) => Object.assign({}, f, { thinking: ev.target.checked }))}
              />
              <span className="switch-slider" />
            </span>
          </label>
          <small className="form-tip">
            让模型先推理再产出简报，选材和点评通常更贴要求，代价是明显更慢、更耗额度。
            只对 Qwen3 / DeepSeek 这类支持思考的模型有效，不支持的上游会忽略这两项设置
          </small>
        </div>
        <div className="form-row" hidden={!form.thinking}>
          <label htmlFor="llmDepth">思考深度</label>
          <select id="llmDepth" className="select" value={form.thinkingDepth} onChange={set('thinkingDepth')}>
            <option value="low">轻 · 少量推理，接近不开思考</option>
            <option value="medium">中 · 默认，够它把选材想过一遍</option>
            <option value="high">深 · 充分推理，长清单时更明显</option>
          </select>
          <small className="form-tip">日报是每天一次的后台任务，「中」通常就够；只有条目很多、分类总跑偏时才值得上「深」</small>
        </div>
        {result && (
          <div className={'test-result show ' + (result.ok ? 'ok' : 'err')} id="llmResult" role="status">
            {result.msg}
          </div>
        )}
      </div>
      <div className="pane-foot">
        <span className="hint">模型配置完全跟随账号：这一份只对你自己生效，不会用上别人的地址或 Key，也没有站点默认值可回退——三项都填好才能生成日报</span>
        <div className="pane-foot-btns">
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
            disabled={busy === 'save'}
            onClick={onSave}
          >
            {busy === 'save' ? '保存中…' : '保存模型'}
          </button>
        </div>
      </div>
    </div>
  );
}
