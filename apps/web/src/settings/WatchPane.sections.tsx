/* 关注 / 屏蔽面板的列表行组件：从 WatchPane.tsx 抽出，DOM 与事件逐字对齐。 */

import type { FilterDraft, RuleDraft } from './WatchPane.types.ts';
import { actText, filterActText, filterSummary, ruleName, ruleSummary } from './WatchPane.utils.ts';

export function RuleRow({
  r,
  busy,
  onOpen,
  onToggle,
}: {
  r: RuleDraft;
  busy: string;
  onOpen: (r: RuleDraft) => void;
  onToggle: (r: RuleDraft, on: boolean) => void;
}) {
  const on = r.on !== false;
  const blocked = r.act === 'block';
  return (
    <div
      className={'sl-row' + (on ? '' : ' is-off')}
      key={r.id}
      data-rule-id={r.id}
      role="button"
      tabIndex={0}
      aria-label={`编辑规则「${ruleName(r)}」`}
      onClick={() => onOpen(r)}
      onKeyDown={
        /** @param {*} [ev] */ (ev) => {
          if (ev.target !== ev.currentTarget) return;
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            onOpen(r);
          }
        }
      }
    >
      <span className={'sl-ava' + (blocked ? ' danger' : '')}>
        <svg className="ico" aria-hidden="true" focusable="false">
          <use href={blocked ? '#i-block' : '#i-eye'} />
        </svg>
      </span>
      <div className="sl-main">
        <div className="sl-name">{ruleName(r)}</div>
        <div className="sl-sub">{ruleSummary(r)}</div>
      </div>
      <span className="sl-side" onClick={/** @param {*} [ev] */ (ev) => ev.stopPropagation()}>
        <span className={'sl-badge' + (blocked ? ' block' : '')}>{actText(r.act)}</span>
        <span className="switch">
          <input
            type="checkbox"
            data-rule-on={r.id}
            aria-label={`启用规则「${ruleName(r)}」`}
            checked={on}
            disabled={busy === 'rules'}
            onChange={/** @param {*} [ev] */ (ev) => onToggle(r, ev.target.checked)}
          />
          <span className="switch-slider" />
        </span>
      </span>
      <svg className="ico feed-caret" aria-hidden="true" focusable="false">
        <use href="#i-chevron-right" />
      </svg>
    </div>
  );
}

export function FilterRow({
  f,
  busy,
  onOpen,
  onToggle,
}: {
  f: FilterDraft;
  busy: string;
  onOpen: (f: FilterDraft) => void;
  onToggle: (f: FilterDraft, on: boolean) => void;
}) {
  const on = f.on !== false;
  return (
    <div
      className={'sl-row' + (on ? '' : ' is-off')}
      key={f.id}
      data-fid={f.id}
      role="button"
      tabIndex={0}
      aria-label={`编辑过滤规则「${f.pattern || '未命名'}」`}
      onClick={() => onOpen(f)}
      onKeyDown={
        /** @param {*} [ev] */ (ev) => {
          if (ev.target !== ev.currentTarget) return;
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            onOpen(f);
          }
        }
      }
    >
      <span className="sl-ava">
        <svg className="ico" aria-hidden="true" focusable="false">
          <use href="#i-filter" />
        </svg>
      </span>
      <div className="sl-main">
        <div className="sl-name">{f.pattern || '未填写模式'}</div>
        <div className="sl-sub">{filterSummary(f)}</div>
      </div>
      <span className="sl-side" onClick={/** @param {*} [ev] */ (ev) => ev.stopPropagation()}>
        <span className={'sl-badge' + (f.act === 'allow' ? '' : ' block')}>
          {filterActText(f.act)}
        </span>
        <span className="switch">
          <input
            type="checkbox"
            data-filter-on={f.id}
            aria-label={`启用过滤规则「${f.pattern || '未命名'}」`}
            checked={on}
            disabled={busy === 'filters'}
            onChange={/** @param {*} [ev] */ (ev) => onToggle(f, ev.target.checked)}
          />
          <span className="switch-slider" />
        </span>
      </span>
      <svg className="ico feed-caret" aria-hidden="true" focusable="false">
        <use href="#i-chevron-right" />
      </svg>
    </div>
  );
}
