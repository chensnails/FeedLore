/* 保存搜索的本机条：接在两页计数行之后。
 * 有当前词时给「保存此搜索」；有存货时给可点回用的词 chip + 逐条删除。
 * 出口都带 aria-label（有 Delete 图标的按钮没有可见文字）。 */

import { useSyncExternalStore } from 'react';
import {
  addSavedSearch,
  getSavedSearchesServerSnapshot,
  listSavedSearches,
  removeSavedSearch,
  subscribeSavedSearches,
} from '../core/savedSearches.ts';
import { Icon } from './Icon.tsx';

export interface SavedSearchesProps {
  /** 两页同时挂载（隐藏的那页也在 DOM 里），id 必须带视图前缀避免撞车。 */
  view: 'cards' | 'reader';
  q: string;
  onApply: (q: string) => void;
}

export function SavedSearches({ view, q, onApply }: SavedSearchesProps) {
  const saved = useSyncExternalStore(
    subscribeSavedSearches,
    listSavedSearches,
    getSavedSearchesServerSnapshot,
  );
  const word = String(q ?? '').trim();
  const canSave = !!word && !saved.some((s) => s.q === word);
  if (!canSave && !saved.length) return null;
  return (
    <div className="saved-searches" role="group" aria-label="保存的搜索">
      {canSave ? (
        <button
          className="saved-search-add"
          id={view + 'SavedSearchAdd'}
          type="button"
          aria-label={`保存搜索「${word}」`}
          onClick={() => addSavedSearch(word)}
        >
          <svg className="ico" aria-hidden="true" focusable="false">
            <use href="#i-plus" />
          </svg>
          保存此搜索
        </button>
      ) : null}
      {saved.map((s) => (
        <span className="saved-search-chip" key={s.q}>
          <button
            className="saved-search-apply"
            type="button"
            title={`按「${s.q}」重新搜索`}
            onClick={() => onApply(s.q)}
          >
            {s.q}
          </button>
          <button
            className="saved-search-remove"
            type="button"
            aria-label={`删除保存的搜索「${s.q}」`}
            title="删除这条保存的搜索"
            onClick={() => removeSavedSearch(s.q)}
          >
            <Icon n="x" />
          </button>
        </span>
      ))}
    </div>
  );
}
