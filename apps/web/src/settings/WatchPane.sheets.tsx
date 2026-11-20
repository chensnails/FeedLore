/* 关注 / 屏蔽面板的两个详情层（规则 / 过滤规则）：从 WatchPane.tsx 抽出，DOM 与事件逐字对齐。 */

import type { Feed, FilterRule, RuleScope } from '@feedlore/contract';
import { useState } from 'react';
import { NO_AUTOFILL_PROPS } from '../ui/noAutofill.ts';
import { Dropdown } from '../views/Dropdown.tsx';
import { DetailSheet } from './DetailSheet.tsx';
import { RuleScopePicker } from './RuleScopePicker.tsx';
import type { FilterDraft, RuleDraft } from './WatchPane.types.ts';
import {
  filterSummary,
  parseKeywords,
  ruleName,
  ruleSummary,
  S,
  sameFilter,
  sameRule,
} from './WatchPane.utils.ts';

/* ---------- 规则详情层 ---------- */
/**
 * @param {*} opts
 */
export function RuleSheet({
  rule,
  isNew,
  busy,
  feeds,
  groupOrder,
  onClose,
  onSave,
  onDelete,
}: {
  rule: RuleDraft;
  isNew: boolean;
  busy: boolean;
  feeds: Feed[];
  groupOrder: string[];
  onClose: () => void;
  onSave: (draft: RuleDraft) => void;
  onDelete: (draft: RuleDraft) => void;
}) {
  const s = S();
  const [draft, setDraft] = useState<RuleDraft>(rule);
  const patch = (p: Partial<RuleDraft>) => setDraft((d) => Object.assign({}, d, p));
  const kws = parseKeywords(draft.keywords);
  const dirty = !sameRule(draft, rule);
  const invalid = kws.length === 0;

  // 关层不丢编辑：已有规则改过且合法就顺手存掉；清空关键词的老规则放弃改动并说明
  const requestClose = () => {
    if (!isNew && dirty && !invalid) {
      onSave(draft);
      return;
    }
    if (!isNew && dirty && invalid) s.toast('关键词已清空，改动未保存', false);
    onClose();
  };

  return (
    <DetailSheet
      title={isNew ? '新建规则' : ruleName(rule)}
      subtitle={isNew ? '设好关键词与适用范围后保存' : ruleSummary(rule)}
      onClose={requestClose}
      saveHint="关闭本层会保存已有规则的改动；新建请点「保存」"
      foot={
        <>
          {isNew ? null : (
            <button
              className="btn btn-danger"
              type="button"
              id="delRuleBtn"
              disabled={busy}
              onClick={() => onDelete(draft)}
            >
              删除规则
            </button>
          )}
          <button
            className="btn btn-primary"
            type="button"
            id="saveRuleBtn"
            disabled={busy || invalid}
            title={invalid ? '至少填写一个关键词' : ''}
            onClick={() => onSave(draft)}
          >
            {busy ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      <div className="form-row">
        <label htmlFor="ruleName">名称</label>
        <input
          id="ruleName"
          type="text"
          maxLength={40}
          placeholder="可留空，默认用第一个关键词"
          value={draft.name}
          onChange={/** @param {*} [ev] */ (ev) => patch({ name: ev.target.value })}
          {...NO_AUTOFILL_PROPS}
        />
      </div>

      <div className="form-row">
        <label>动作</label>
        <div className="seg" role="radiogroup" aria-label="规则动作">
          <button
            type="button"
            className={'seg-btn' + (draft.act === 'watch' ? ' active' : '')}
            aria-pressed={draft.act === 'watch' ? 'true' : 'false'}
            onClick={() => patch({ act: 'watch' })}
          >
            <svg className="ico" aria-hidden="true" focusable="false">
              <use href="#i-eye" />
            </svg>
            关注
          </button>
          <button
            type="button"
            className={'seg-btn is-block' + (draft.act === 'block' ? ' active' : '')}
            aria-pressed={draft.act === 'block' ? 'true' : 'false'}
            onClick={() => patch({ act: 'block', notify: false })}
          >
            <svg className="ico" aria-hidden="true" focusable="false">
              <use href="#i-block" />
            </svg>
            屏蔽
          </button>
        </div>
        <small className="form-tip">
          {draft.act === 'watch'
            ? '命中后加入「关注」智能分组，不改变文章所在的频道。'
            : '命中后标为「屏蔽」并自动标为已读。'}
        </small>
      </div>

      <div className="form-row">
        <label htmlFor="ruleKeywords">关键词</label>
        <textarea
          id="ruleKeywords"
          className="watch-rule-kw"
          rows={5}
          spellCheck="false"
          placeholder={'一行一个，例如：\nOpenAI\nGPT-5'}
          value={draft.keywords}
          onChange={/** @param {*} [ev] */ (ev) => patch({ keywords: ev.target.value })}
        />
        <small className="form-tip">
          标题、摘要或正文中出现即命中（不区分大小写）
          {kws.length ? ` · 当前 ${kws.length} 个` : ' · 至少填一个'}
        </small>
      </div>

      <div className="form-row">
        <label>适用范围</label>
        <RuleScopePicker
          value={draft.scope}
          onChange={(scope: RuleScope) => patch({ scope })}
          feeds={feeds}
          groupOrder={groupOrder}
        />
        <small className="form-tip">
          勾分组会覆盖整组（含以后新加入的频道）；一个都不选时这条规则不生效。
        </small>
      </div>

      {draft.act === 'watch' ? (
        <label className="ds-sw-row">
          <span className="ds-sw-txt">
            <span className="ds-sw-name">推送 Webhook</span>
            <span className="ds-sw-desc">命中新文章时向已配置的 Webhook 地址推送</span>
          </span>
          <span className="switch">
            <input
              type="checkbox"
              checked={draft.notify}
              onChange={/** @param {*} [ev] */ (ev) => patch({ notify: ev.target.checked })}
            />
            <span className="switch-slider" />
          </span>
        </label>
      ) : null}
      <label className="ds-sw-row">
        <span className="ds-sw-txt">
          <span className="ds-sw-name">启用</span>
          <span className="ds-sw-desc">关闭后这条规则不参与判定</span>
        </span>
        <span className="switch">
          <input
            type="checkbox"
            checked={draft.on}
            onChange={/** @param {*} [ev] */ (ev) => patch({ on: ev.target.checked })}
          />
          <span className="switch-slider" />
        </span>
      </label>
    </DetailSheet>
  );
}

/* ---------- 过滤规则详情层 ---------- */
export function FilterSheet({
  filter,
  isNew,
  busy,
  feeds,
  groupOrder,
  onClose,
  onSave,
  onDelete,
}: {
  filter: FilterDraft;
  isNew: boolean;
  busy: boolean;
  feeds: Feed[];
  groupOrder: string[];
  onClose: () => void;
  onSave: (draft: FilterDraft) => void;
  onDelete: (draft: FilterDraft) => void;
}) {
  const s = S();
  const [draft, setDraft] = useState<FilterDraft>(filter);
  const patch = (p: Partial<FilterDraft>) => setDraft((d) => Object.assign({}, d, p));
  const dirty = !sameFilter(draft, filter);
  const invalid = !String(draft.pattern || '').trim();

  const requestClose = () => {
    if (!isNew && dirty && !invalid) {
      onSave(draft);
      return;
    }
    if (!isNew && dirty && invalid) s.toast('匹配模式已清空，改动未保存', false);
    onClose();
  };

  return (
    <DetailSheet
      title={isNew ? '新建过滤规则' : filter.pattern || '过滤规则'}
      subtitle={isNew ? '保存后对之后新抓取的文章生效' : filterSummary(filter)}
      onClose={requestClose}
      saveHint="关闭本层会保存已有规则的改动；新建请点「保存」"
      foot={
        <>
          {isNew ? null : (
            <button
              className="btn btn-danger"
              type="button"
              id="delFilterBtn"
              disabled={busy}
              onClick={() => onDelete(draft)}
            >
              删除规则
            </button>
          )}
          <button
            className="btn btn-primary"
            type="button"
            id="saveFilterBtn"
            disabled={busy || invalid}
            title={invalid ? '请填写匹配模式' : ''}
            onClick={() => onSave(draft)}
          >
            {busy ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      <div className="form-row">
        <label>动作</label>
        <Dropdown
          id="filterAct"
          wrapId="filterActDD"
          title="动作"
          ariaLabel="动作"
          value={draft.act}
          onChange={(v: FilterRule['act']) => patch({ act: v })}
          options={[
            { value: 'block', label: '丢弃（命中即不入库）' },
            { value: 'allow', label: '只收（只保留命中）' },
          ]}
        />
        <small className="form-tip">两者同时存在时，先丢弃、再只收。</small>
      </div>

      <div className="form-row">
        <label>匹配范围</label>
        <Dropdown
          id="filterField"
          wrapId="filterFieldDD"
          title="匹配范围"
          ariaLabel="匹配范围"
          value={draft.field}
          onChange={(v: FilterRule['field']) => patch({ field: v })}
          options={[
            { value: 'title', label: '标题' },
            { value: 'desc', label: '摘要' },
            { value: 'content', label: '正文' },
            { value: 'all', label: '全部（标题 + 摘要 + 正文）' },
          ]}
        />
      </div>

      <div className="form-row">
        <label>匹配方式</label>
        <Dropdown
          id="filterKind"
          wrapId="filterKindDD"
          title="匹配方式"
          ariaLabel="匹配方式"
          value={draft.kind}
          onChange={(v: FilterRule['kind']) => patch({ kind: v })}
          options={[
            { value: 'kw', label: '关键词' },
            { value: 're', label: '正则' },
          ]}
        />
      </div>

      <div className="form-row">
        <label htmlFor="filterPattern">匹配模式</label>
        <input
          id="filterPattern"
          className="filter-pattern"
          type="text"
          placeholder={draft.kind === 're' ? '如：vd+.d+' : '关键词，不区分大小写'}
          value={draft.pattern}
          onChange={/** @param {*} [ev] */ (ev) => patch({ pattern: ev.target.value })}
          {...NO_AUTOFILL_PROPS}
        />
        <small className="form-tip">
          {draft.kind === 're' ? '非法正则在保存时会被忽略。' : '子串匹配，不区分大小写。'}
        </small>
      </div>

      <div className="form-row">
        <label>适用范围</label>
        <RuleScopePicker
          value={draft.scope}
          onChange={(scope: RuleScope) => patch({ scope })}
          feeds={feeds}
          groupOrder={groupOrder}
        />
        <small className="form-tip">一个都不选时这条规则不生效；勾分组会覆盖整组。</small>
      </div>

      <label className="ds-sw-row">
        <span className="ds-sw-txt">
          <span className="ds-sw-name">启用</span>
          <span className="ds-sw-desc">关闭后这条规则不参与过滤</span>
        </span>
        <span className="switch">
          <input
            type="checkbox"
            checked={draft.on}
            onChange={/** @param {*} [ev] */ (ev) => patch({ on: ev.target.checked })}
          />
          <span className="switch-slider" />
        </span>
      </label>
    </DetailSheet>
  );
}
