/* 标签栏（Row2）：卡片页与文章页共用的横向滑动标签筛选条。
 * 全部 / 剧情 / 爱情 / +N 一排，移动端折叠成首排 +「+N」。
 * 漫游焦点（roving tabindex）：整组只占 1 个 Tab 停靠点，组内 ← → / Home / End 移动。
 * 组件自行管理 chip 焦点与折叠状态，调用方只传 tags / activeTag / onTag。 */
import React, { useRef, useState } from 'react';

export function TagBar({ tags = [], activeTag, onTag, id = 'tagBar', className = '' }) {
  const [chipIdx, setChipIdx] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const chipRefs = useRef([]);

  const list = (tags || []).slice(0, 16); // 「全部」另算，最多再列 16 个

  const onChipKey = (ev) => {
    const n = list.length + 1;
    let next = null;
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') next = (chipIdx + 1) % n;
    else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') next = (chipIdx - 1 + n) % n;
    else if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = n - 1;
    if (next == null) return;
    ev.preventDefault();
    setChipIdx(next);
    const el = chipRefs.current[next];
    if (el) el.focus();
  };

  if (!(tags && tags.length)) return null;

  return (
    <div className={'wrap tagbar' + (className ? ' ' + className : '')} id={id}>
      <div className={'tag-list' + (expanded ? ' is-open' : '')} role="toolbar" aria-label="标签筛选" onKeyDown={onChipKey}>
        <button type="button" className={'tag-chip' + (activeTag ? '' : ' active')} data-tag=""
          ref={(el) => { chipRefs.current[0] = el; }}
          tabIndex={chipIdx === 0 ? 0 : -1} aria-pressed={activeTag ? 'false' : 'true'}
          onClick={() => { setChipIdx(0); onTag(null); }}>全部</button>
        {list.map(({ tag, n }, i) => (
          <button type="button" className={'tag-chip' + (activeTag === tag ? ' active' : '')} data-tag={tag} key={tag}
            ref={(el) => { chipRefs.current[i + 1] = el; }}
            tabIndex={chipIdx === i + 1 ? 0 : -1}
            aria-pressed={activeTag === tag ? 'true' : 'false'}
            onClick={() => { setChipIdx(i + 1); onTag(tag); }}>
            {tag}<span className="cnt">{n}</span>
          </button>
        ))}
      </div>
      {list.length > 3 ? (
        <button type="button" className={'tag-more' + (expanded ? ' is-open' : '')}
          aria-expanded={expanded ? 'true' : 'false'} aria-controls={id}
          title={expanded ? '收起标签' : '展开全部标签'}
          onClick={() => setExpanded((v) => !v)}>
          {expanded ? '收起' : `+${list.length - 2}`}
        </button>
      ) : null}
    </div>
  );
}
