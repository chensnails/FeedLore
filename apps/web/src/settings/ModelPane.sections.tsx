/* 模型面板的两大 JSX 区块（模型接入列表 / 运行状态）：从 ModelPane.tsx 抽出，DOM 逐字对齐。 */

import type {
  AiRequestItem,
  AiUsageResponse,
  LlmModelView,
  LlmVendorView,
} from '@feedlore/contract';
import type * as React from 'react';
import { Dropdown } from '../views/Dropdown.tsx';
import { modelLabel } from './AiCapabilities.tsx';
import {
  type Ai,
  DEPTH_LABEL,
  fmtDur,
  fmtNum,
  fmtReqTime,
  fmtTokens,
  hostOf,
  numToDepth,
  S,
  tempText,
  USAGE_KINDS,
  USAGE_SPANS,
  vendorLabel,
} from './ModelPane.utils.ts';
import { Result, type ResultData } from './primitives.tsx';

/* ============================ 模型行 ============================ */

const rowKeyDown = (fn: () => void) => (ev: React.KeyboardEvent) => {
  if (ev.target !== ev.currentTarget) return;
  if (ev.key === 'Enter' || ev.key === ' ') {
    ev.preventDefault();
    fn();
  }
};

function ModelRow({
  m,
  loose,
  busy,
  onOpen,
  makeDefault,
}: {
  m: LlmModelView;
  loose: boolean;
  busy: string;
  onOpen: () => void;
  makeDefault: (m: LlmModelView) => void;
}) {
  const depth = numToDepth(m.thinkingDepth);
  return (
    <div
      className="sl-row is-nested"
      key={m.id}
      data-model-id={m.id}
      role="button"
      tabIndex={0}
      aria-label={`编辑模型「${modelLabel(m)}」`}
      onClick={onOpen}
      onKeyDown={rowKeyDown(onOpen)}
    >
      <div className="sl-main">
        <div className="sl-name">{modelLabel(m)}</div>
        <div className="sl-sub">
          {loose ? `${m.vendorName || '未绑定厂商'} · ` : ''}
          温度 {tempText(m.temperature)} · {m.thinking ? `思考${DEPTH_LABEL[depth]}` : '不思考'}
        </div>
      </div>
      <span className="sl-side" onClick={/** @param {*} [ev] */ (ev) => ev.stopPropagation()}>
        {m.isDefault ? (
          <span className="sl-badge">默认</span>
        ) : m.vendorId ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={!!busy}
            onClick={() => makeDefault(m)}
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
}

/* ============================ 模型接入列表 ============================ */

export interface ModelAccessListProps {
  ai: Ai;
  loaded: boolean;
  openGroups: Record<string, boolean>;
  setOpenGroups: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  autoOpenVendorId: string;
  onOpenRow: (kind: 'model' | 'vendor', id: string | null) => void;
  onAddModelToVendor: (vendorId: string) => void;
}

export function ModelAccessList({
  ai,
  loaded,
  openGroups,
  setOpenGroups,
  autoOpenVendorId,
  onOpenRow,
  onAddModelToVendor,
}: ModelAccessListProps) {
  const { vendors, models, busy } = ai;
  const looseModels = models.filter((m: LlmModelView) => !m.vendorId);
  const renderModelRow = (m: LlmModelView, loose: boolean) =>
    ModelRow({
      m,
      loose,
      busy,
      onOpen: () => onOpenRow('model', m.id),
      makeDefault: (m: LlmModelView) => ai.makeDefault(m),
    });

  return (
    <>
      <div className="sl-toolbar">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          id="addVendorBtn"
          onClick={() => onOpenRow('vendor', null)}
        >
          + 添加厂商
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          id="addModelBtn"
          disabled={!vendors.length}
          onClick={() => onOpenRow('model', null)}
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
          {vendors.map((v: LlmVendorView) => {
            const own = models.filter((m: LlmModelView) => m.vendorId === v.id);
            const label = vendorLabel(v);
            const open = v.id in openGroups ? openGroups[v.id] : v.id === autoOpenVendorId;
            return (
              <details
                className="sl-group"
                key={v.id}
                data-vendor-id={v.id}
                open={open}
                onToggle={
                  /** @param {*} [ev] */ (ev) => {
                    const isOpen = ev.currentTarget.open;
                    setOpenGroups(
                      /** @param {*} [prev] */ (prev) =>
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
                        /** @param {*} [ev] */ (ev) => {
                          ev.preventDefault();
                          ev.stopPropagation();
                          onOpenRow('vendor', v.id);
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
                    own.map((m: LlmModelView) => renderModelRow(m, false))
                  ) : (
                    <div className="sl-empty is-inline">这个厂商下还没有模型。</div>
                  )}
                  <div className="sl-group-foot">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      data-vendor-add={v.id}
                      onClick={() => onAddModelToVendor(v.id)}
                    >
                      + 添加模型
                    </button>
                  </div>
                </div>
              </details>
            );
          })}
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
                <svg className="ico feed-caret sl-group-caret" aria-hidden="true" focusable="false">
                  <use href="#i-chevron-right" />
                </svg>
              </summary>
              <div className="sl-models">
                {looseModels.map((m: LlmModelView) => renderModelRow(m, true))}
              </div>
            </details>
          ) : null}
        </div>
      )}
    </>
  );
}

/* ============================ 运行状态 ============================ */

export interface ModelStatusSectionProps {
  status: { cls: string; label: string; detail: string };
  defaultModel: LlmModelView | null;
  busy: string;
  testDefault: () => void;
  statusResult: ResultData | null;
  avgMs: number;
  todayCalls: number;
  todayFails: number;
  keepInfo: { keep: number; days: number };
  reqLimit: number;
  setReqLimit: (n: number) => void;
  reqBusy: boolean;
  usageBusy: boolean;
  refreshAll: () => void;
  requests: AiRequestItem[] | null;
  reqError: string;
  reqLoading: boolean;
  usage: AiUsageResponse | null;
  loadRequests: (_limit?: number) => Promise<void>;
}

export function ModelStatusSection({
  status,
  defaultModel,
  busy,
  testDefault,
  statusResult,
  avgMs,
  todayCalls,
  todayFails,
  keepInfo,
  reqLimit,
  setReqLimit,
  reqBusy,
  usageBusy,
  refreshAll,
  requests,
  reqError,
  reqLoading,
  usage,
  loadRequests,
}: ModelStatusSectionProps) {
  const recent = Array.isArray(requests) ? requests : [];
  return (
    <>
      <div className="ms-head">
        <span className={'ms-badge ' + status.cls}>{status.label}</span>
        <span className="ms-model" title={defaultModel ? modelLabel(defaultModel) : '未设置模型'}>
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
          onChange={(v: string | number) => {
            // setReqLimit 改变 queryKey，requestsQuery 自动重拉对应条数。
            setReqLimit(Number(v) || 20);
          }}
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
            /** @param {*} [r] */ (r) => (
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
          {(['today', 'days7', 'days30'] as const).map((k) => (
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
          ))}
        </div>
        {usage && usage.byKind && usage.byKind.length ? (
          <ul className="usage-list" id="aiUsageKinds">
            {usage.byKind.map(
              /** @param {*} [r] */ (r) => (
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
    </>
  );
}
