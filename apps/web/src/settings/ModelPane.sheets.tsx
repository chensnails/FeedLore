/* 模型面板的两个详情层（模型 / 厂商）：从 ModelPane.tsx 抽出，JSX 与状态机逐字对齐。 */

import type { LlmModelView, LlmVendorInput, LlmVendorView } from '@feedlore/contract';
import { useState } from 'react';
import { NO_AUTOFILL_PROPS, useNoAutofillName } from '../ui/noAutofill.ts';
import { Dropdown } from '../views/Dropdown.tsx';
import { modelLabel } from './AiCapabilities.tsx';
import { DetailSheet } from './DetailSheet.tsx';
import {
  type Ai,
  type Depth,
  depthToNum,
  hostOf,
  numToDepth,
  S,
  tempText,
} from './ModelPane.utils.ts';
import { Result, useResult } from './primitives.tsx';

/* ============================ 模型详情层 ============================ */

export function ModelSheet({
  ai,
  model,
  initialVendorId,
  onClose,
  onNeedVendor,
}: {
  ai: Ai;
  model: LlmModelView | null;
  initialVendorId: string;
  onClose: () => void;
  onNeedVendor: () => void;
}) {
  const editing = !!model;
  const [vendorId, setVendorId] = useState<string>(
    model ? model.vendorId || ai.vendors[0]?.id || '' : initialVendorId || ai.vendors[0]?.id || '',
  );
  const [name, setName] = useState<string>(model ? model.name || '' : '');
  const [upstream, setUpstream] = useState<string>(model ? model.model || '' : '');
  const [temperature, setTemperature] = useState<string>(tempText(model ? model.temperature : 0.3));
  const [thinking, setThinking] = useState<boolean>(!!(model && model.thinking));
  const [depth, setDepth] = useState<Depth>(numToDepth(model ? model.thinkingDepth : 2));
  const [isDefault, setIsDefault] = useState<boolean>(!!(model && model.isDefault));
  const [list, setList] = useState<string[] | null>(null);
  const [listBusy, setListBusy] = useState(false);
  const [listErr, setListErr] = useState('');
  const [busy, setBusy] = useState('');
  const [result, showResult] = useResult();

  const vendorOptions = ai.vendors.map((v: LlmVendorView) => ({ value: v.id, label: v.name }));
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
    if (!model) return;
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
          onChange={/** @param {*} [e] */ (e) => setName(e.target.value)}
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
            onChange={/** @param {*} [e] */ (e) => setUpstream(e.target.value)}
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
              options={list.map((m) => ({ value: m, label: m }))}
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
          onChange={/** @param {*} [e] */ (e) => setTemperature(e.target.value)}
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
              onChange={/** @param {*} [e] */ (e) => setThinking(e.target.checked)}
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
              onChange={/** @param {*} [e] */ (e) => setIsDefault(e.target.checked)}
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

export function VendorSheet({
  ai,
  vendor,
  onClose,
  onSaved,
}: {
  ai: Ai;
  vendor: LlmVendorView | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = !!vendor;
  const keyName = useNoAutofillName('vendor-key');
  const urlName = useNoAutofillName('vendor-url');
  const [name, setName] = useState<string>(vendor ? vendor.name || '' : '');
  const [baseUrl, setBaseUrl] = useState<string>(vendor ? vendor.baseUrl || '' : '');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [clearKey, setClearKey] = useState(false);
  const [busy, setBusy] = useState('');
  const [result, showResult] = useResult();

  const saved = !!(vendor && vendor.apiKeySet);

  async function save() {
    if (!baseUrl.trim()) {
      showResult(false, '接口地址不能为空');
      return;
    }
    setBusy('save');
    try {
      const payload: LlmVendorInput = { name: name.trim(), baseUrl: baseUrl.trim() };
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
    if (!vendor) return;
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
          onChange={/** @param {*} [e] */ (e) => setName(e.target.value)}
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
          onChange={/** @param {*} [e] */ (e) => setBaseUrl(e.target.value)}
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
              /** @param {*} [e] */ (e) => {
                setApiKey(e.target.value);
                setClearKey(false);
              }
            }
            {...NO_AUTOFILL_PROPS}
          />
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setShowKey(/** @param {*} [v] */ (v) => !v)}
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
