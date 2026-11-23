/* 文章视图的子组件：列表项、频道栏分隔条、频道抽屉外壳、计数 / 空态 / 加载态。
 * 结构与事件处理从 ReaderView.tsx 原样迁移，DOM 类名 / id / aria 全部保持不变。 */

import { core } from '@core';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  PointerEvent as ReactPointerEvent,
} from 'react';
import { useRef, useState } from 'react';
import type { Card, EntityId, EntryDetail } from '../core/types.ts';
import { isImgFailed, markImgFailed } from '../imgFail.ts';
import { widthSrcSet } from '../imgSrc.ts';
import { BrandLogo } from '../ui/BrandLogo.tsx';
import { HighlightText } from '../ui/HighlightText.tsx';
import { Icon } from '../ui/Icon.tsx';
import type { EmptyAction } from './ReaderView.hooks.ts';
// ArtBody 是 ReaderView.tsx 的函数声明（渲染期取值），此处回引不构成初始化期环。
import { ArtBody } from './ReaderView.tsx';

const S = () => core;

/** ArtItem 的 props。 */
export interface ArtItemProps {
  e: Card;
  /** 当前搜索词：只用来切文本节点做高亮，不进 aria-label（读屏读原文）。 */
  query?: string;
  expanded: boolean;
  full?: EntryDetail;
  bodyErr: boolean;
  flash: boolean;
  comfortable: boolean;
  onToggle: (id: EntityId) => void;
  onFav: (id: EntityId) => void;
  onTag: (tag: string) => void;
  onAiTag: (tag: string) => void;
  onUnread: (id: EntityId) => void;
  onRetryBody: (id: EntityId) => void;
}

/** 列表项（对应旧 artItemHtml + expandArt/collapseArt）。
 *  外层由 ReaderView 的 `const ArtItem = memo(...)` 包裹，props 引用稳定才不会无谓重渲染。 */
export function ArtItemInner({
  e,
  query,
  expanded,
  full,
  bodyErr,
  flash,
  comfortable,
  onToggle,
  onFav,
  onTag,
  onAiTag,
  onUnread,
  onRetryBody,
}: ArtItemProps) {
  const s = S();
  const src = e.feedName ? (s.shortFeedName ? s.shortFeedName(e.feedName) : e.feedName) : '';
  const fmtFull = s.fmtFull || ((d: unknown) => (d ? String(d) : ''));
  const fmtDate = s.fmtDate || ((d: unknown) => (d ? String(d) : ''));
  const fav = !!e.isFavorite;
  const ariaLabel = [e.name, src, fmtDate(e.date), e.isRead ? '已读' : '未读', fav ? '已收藏' : '']
    .filter(Boolean)
    .join('，');
  const [imgFailed, setImgFailed] = useState(false);
  const thumb =
    !expanded && comfortable && e.image && !imgFailed && !isImgFailed(e.image) ? e.image : null;
  const desc = !expanded && comfortable && e.desc ? String(e.desc) : '';
  const lineMode = !comfortable && !expanded;
  const cls =
    'art-item' +
    (e.isRead ? ' is-read' : ' is-unread') +
    (fav ? ' is-fav' : '') +
    (expanded ? ' open' : '') +
    (thumb ? ' has-thumb' : '') +
    (desc ? ' has-sum' : '') +
    (lineMode ? ' is-line' : '') +
    (flash ? ' is-flash' : '');

  const toggle = () => {
    onToggle(e.id);
  };
  let inner = null;
  if (expanded) {
    if (full) inner = <ArtBody e={full} onTag={onTag} onAiTag={onAiTag} />;
    else if (bodyErr) {
      inner = (
        <div className="art-inner">
          <div className="hint">
            正文加载失败
            <button type="button" className="btn btn-sm" onClick={() => onRetryBody(e.id)}>
              重试
            </button>
          </div>
        </div>
      );
    } else
      inner = (
        <div className="art-inner">
          <div className="art-loading">
            <i />
            <i />
            <i />
          </div>
        </div>
      );
  }

  return (
    <article className={cls} data-id={e.id}>
      <div className="art-row">
        <button
          className="art-head"
          type="button"
          aria-expanded={expanded ? 'true' : 'false'}
          aria-label={ariaLabel}
          onClick={toggle}
        >
          <span className="art-dot" aria-hidden="true" />
          <svg className="art-caret" aria-hidden="true" focusable="false">
            <use href="#i-chevron-right" />
          </svg>
          <span className="art-text">
            <span className="art-title">
              <HighlightText text={e.name} query={query} />
            </span>
            {desc ? (
              <span className="art-sum">
                <HighlightText text={desc} query={query} />
              </span>
            ) : null}
            <span className="art-meta">
              {src ? <span className="src-pill">{src}</span> : null}
              {e.size ? <span className="art-size">{e.size}</span> : null}
              <span className="art-date" title={fmtFull(e.date)}>
                {fmtDate(e.date)}
              </span>
            </span>
          </span>
          {thumb ? (
            <span className="art-thumb">
              <img
                src={thumb}
                srcSet={widthSrcSet(thumb, [320, 640])}
                sizes="104px"
                alt=""
                loading="lazy"
                decoding="async"
                onError={() => {
                  markImgFailed(e.image);
                  setImgFailed(true);
                }}
              />
            </span>
          ) : null}
        </button>
        <span className="art-acts">
          {expanded ? (
            <button
              className="art-star art-collapse"
              type="button"
              aria-label="收起这篇"
              title="收起这篇"
              onClick={
                /** @param {*} [ev] */ (ev) => {
                  ev.stopPropagation();
                  toggle();
                }
              }
            >
              <Icon n="chevrons-up" />
            </button>
          ) : null}
          <button
            className="art-star"
            type="button"
            data-fav={e.id}
            aria-pressed={fav ? 'true' : 'false'}
            aria-label={fav ? '取消收藏' : '收藏'}
            title={fav ? '取消收藏' : '收藏这篇'}
            onClick={
              /** @param {*} [ev] */ (ev) => {
                ev.stopPropagation();
                onFav(e.id);
              }
            }
          >
            <Icon n={fav ? 'star' : 'star-o'} />
          </button>
          {e.isRead ? (
            <button
              className="art-star art-unread"
              type="button"
              data-unread={e.id}
              aria-label="标为未读"
              title="标为未读"
              onClick={
                /** @param {*} [ev] */ (ev) => {
                  ev.stopPropagation();
                  onUnread(e.id);
                }
              }
            >
              <Icon n="circle" />
            </button>
          ) : null}
        </span>
      </div>
      <div className="art-body" hidden={!expanded}>
        {inner}
      </div>
    </article>
  );
}

/* ---------- 频道栏宽度分隔条 ---------- */
export function ReaderSideResize() {
  const dragRef = useRef<number | null>(null);
  const [width, setWidth] = useState<number>(() => S().getReaderSideWidth());

  const onPointerDown = (ev: ReactPointerEvent<HTMLDivElement>) => {
    if (window.innerWidth <= 720) return;
    const s = S();
    ev.preventDefault();
    const side = document.getElementById('readerSide');
    const measured = side ? side.getBoundingClientRect().width : 0;
    const startX = ev.clientX;
    const startW = measured > 0 ? measured : s.getReaderSideWidth();
    dragRef.current = startW;
    const move = (e: PointerEvent) => {
      const w = Math.min(
        s.readerSideCap(),
        Math.max(s.READER_SIDE_MIN, startW + (e.clientX - startX)),
      );
      dragRef.current = w;
      s.applyReaderSideWidth(w);
      setWidth(w);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (dragRef.current != null) S().setReaderSideWidth(dragRef.current);
      dragRef.current = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const onDoubleClick = () => {
    const s = S();
    s.setReaderSideWidth(s.READER_SIDE_DEFAULT);
    setWidth(s.READER_SIDE_DEFAULT);
    s.toast('频道栏宽度已恢复默认');
  };

  const onKeyDown = (ev: ReactKeyboardEvent<HTMLDivElement>) => {
    const s = S();
    const step = 16;
    const cur = s.getReaderSideWidth();
    if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
      ev.preventDefault();
      const next = Math.min(
        s.readerSideCap(),
        Math.max(s.READER_SIDE_MIN, cur + (ev.key === 'ArrowRight' ? step : -step)),
      );
      s.setReaderSideWidth(next);
      setWidth(next);
    } else if (ev.key === 'Home') {
      ev.preventDefault();
      s.setReaderSideWidth(s.READER_SIDE_DEFAULT);
      setWidth(s.READER_SIDE_DEFAULT);
    }
  };

  return (
    <div
      className="reader-resize"
      id="readerResize"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整频道栏宽度"
      aria-valuenow={Math.round(width)}
      aria-valuemin={S().READER_SIDE_MIN}
      aria-valuemax={S().readerSideCap()}
      tabIndex={0}
      title="拖动调整频道栏宽度，双击恢复默认"
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
    />
  );
}

/* ---------- 窄屏频道抽屉外壳（频道树由调用方作为 children 传入） ---------- */
export function ReaderSidebar({
  feedsCount,
  badge,
  hasGroups,
  allCollapsed,
  onClose,
  onToggleAll,
  children,
}: {
  feedsCount: number;
  badge: (n: number) => string;
  hasGroups: boolean;
  allCollapsed: boolean;
  onClose: () => void;
  onToggleAll: () => void;
  children: ReactNode;
}) {
  return (
    <>
      <div className="reader-mask" id="readerMask" onClick={onClose} />
      <aside className="reader-side" id="readerSide">
        <div className="side-brand">
          <BrandLogo />
          <span className="side-brand-name">笺川</span>
        </div>
        <div className="reader-side-head">
          <span>频道</span>
          <span className="reader-side-n" id="readerSideN">
            {feedsCount ? `${badge(feedsCount)} 个` : ''}
          </span>
          <button
            className="reader-side-fold"
            id="readerFoldAll"
            type="button"
            hidden={!hasGroups}
            title={allCollapsed ? '展开全部分组' : '收起全部分组'}
            aria-label={allCollapsed ? '展开全部分组' : '收起全部分组'}
            onClick={onToggleAll}
          >
            <svg className="ico" aria-hidden="true" focusable="false">
              <use href={allCollapsed ? '#i-chevrons-down' : '#i-chevrons-up'} />
            </svg>
          </button>
          <button
            className="reader-side-close"
            id="readerSideClose"
            type="button"
            aria-label="收起频道列表"
            onClick={onClose}
          >
            <svg className="ico" aria-hidden="true" focusable="false">
              <use href="#i-x" />
            </svg>
          </button>
        </div>
        <nav className="reader-channels" id="readerChannels">
          {children}
        </nav>
      </aside>
    </>
  );
}

/* ---------- 头部左簇三枚动作按钮（搜索 / ⋮ 留在 ReaderView 的右簇里） ---------- */
export function ReaderHeadActions({
  s,
  accordionOn,
  hasUnread,
  anyExpanded,
}: {
  s: ReturnType<typeof S>;
  accordionOn: boolean;
  hasUnread: boolean;
  anyExpanded: boolean;
}) {
  return (
    <>
      <button
        className="btn btn-ghost btn-sm vt-action"
        id="readerAccBtn"
        type="button"
        aria-pressed={accordionOn ? 'true' : 'false'}
        title={
          accordionOn
            ? '单篇展开：展开一篇时自动收起上一篇（点这里改成多篇）'
            : '多篇展开：可以同时展开多篇（点这里改成单篇）'
        }
        onClick={() => s.readerToggleAccordion && s.readerToggleAccordion()}
      >
        <svg className="ico" aria-hidden="true" focusable="false">
          <use href="#i-accordion" />
        </svg>
        <span className="btn-label" id="readerAccLabel">
          {accordionOn ? '单篇' : '多篇'}
        </span>
      </button>
      <button
        className="btn btn-ghost btn-sm vt-action"
        id="readerReadAllBtn"
        type="button"
        hidden={!hasUnread}
        title="把当前列表全部标为已读"
        onClick={() => s.readerReadAll && s.readerReadAll()}
      >
        <svg className="ico" aria-hidden="true" focusable="false">
          <use href="#i-check-circle" />
        </svg>
        <span className="btn-label">全部已读</span>
      </button>
      <button
        className="btn btn-ghost btn-sm vt-action"
        id="readerCollapseAll"
        type="button"
        hidden={!anyExpanded}
        title="收起所有展开的文章"
        onClick={() => s.readerCollapseAll && s.readerCollapseAll()}
      >
        <svg className="ico" aria-hidden="true" focusable="false">
          <use href="#i-chevrons-up" />
        </svg>
        <span className="btn-label">全部收起</span>
      </button>
    </>
  );
}

/* ---------- 筛选计数行 ---------- */
export function ReaderCountChip({
  q,
  tag,
  aiTag,
  total,
  onClearTag,
  onClearAiTag,
}: {
  q: string;
  tag?: string | null;
  aiTag?: string | null;
  total: number;
  onClearTag: () => void;
  onClearAiTag: () => void;
}) {
  return (
    <div className="list-count" role="status">
      {q ? (
        <span>
          「{q}」找到 {total} 篇文章
        </span>
      ) : null}
      {q ? <span className="count-chip">按相关度排序</span> : null}
      {tag ? (
        <span className="count-chip">
          标签：{tag}
          {!q ? <span className="count-chip-n">{total} 条</span> : null}
          <button
            type="button"
            className="count-clear"
            aria-label="清除标签筛选"
            title="清除标签筛选"
            onClick={onClearTag}
          >
            <svg className="ico" aria-hidden="true" focusable="false">
              <use href="#i-x" />
            </svg>
          </button>
        </span>
      ) : null}
      {aiTag ? (
        <span className="count-chip count-chip-ai">
          AI 标签：{aiTag}
          {!q ? <span className="count-chip-n">{total} 条</span> : null}
          <button
            type="button"
            className="count-clear"
            aria-label="清除 AI 标签筛选"
            title="清除 AI 标签筛选"
            onClick={onClearAiTag}
          >
            <svg className="ico" aria-hidden="true" focusable="false">
              <use href="#i-x" />
            </svg>
          </button>
        </span>
      ) : null}
    </div>
  );
}

/* ---------- 空态 ---------- */
export function ReaderEmpty({
  msg,
  action,
  hidden,
}: {
  msg: string;
  action: EmptyAction | null;
  hidden: boolean;
}) {
  return (
    <div className="empty" id="readerEmpty" hidden={hidden}>
      <div className="empty-ico">
        <svg className="ico" aria-hidden="true" focusable="false">
          <use href="#i-inbox" />
        </svg>
      </div>
      <p>{msg}</p>
      {action ? (
        <button type="button" className="btn btn-primary empty-action" onClick={action.run}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

/* ---------- 加载更多（圆点 + 失败重试 + 哨兵） ---------- */
export function ReaderLoadMore({
  err,
  loading,
  onRetry,
}: {
  err: boolean;
  loading: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="loadmore-wrap">
      {err ? (
        <div className="load-retry" role="alert">
          <span>加载失败</span>
          <button type="button" className="btn" onClick={onRetry}>
            重试
          </button>
        </div>
      ) : null}
      <div className="loading-dots" id="readerMore" hidden={!loading}>
        <i />
        <i />
        <i />
      </div>
      <div className="reader-sentinel" id="readerSentinel" aria-hidden="true" />
    </div>
  );
}
