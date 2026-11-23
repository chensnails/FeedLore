/* 卡片视图的子组件：懒加载图、卡片 / 行、抽屉外壳、列表主体与详情弹窗。
 * DOM 类名 / id / aria / 文案与 ReaderView 同口径，全部从 CardsView.tsx 原样迁移。 */

import { core } from '@core';
import type {
  ComponentType,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  SyntheticEvent as ReactSyntheticEvent,
} from 'react';
import { useRef, useState } from 'react';
import type { AppState, Card as CardData, ViewMode } from '../core/types.ts';
import { isImgFailed, markImgFailed } from '../imgFail.ts';
import { widthSrcSet, widthVariant } from '../imgSrc.ts';
import { BrandLogo } from '../ui/BrandLogo.tsx';
import { CopyButton, copyableLinks, OpenButton } from '../ui/EntryActions.tsx';
import { HighlightText } from '../ui/HighlightText.tsx';
import { Icon } from '../ui/Icon.tsx';
import { SavedSearches } from '../ui/SavedSearches.tsx';
import { CardDetail } from './CardDetail.tsx';
import type { EmptyAction } from './CardsView.hooks.ts';

const S = () => core;

export interface LazyImgProps {
  src?: string | null;
  srcSet?: string;
  sizes?: string;
  alt?: string;
  fallbackClass?: string;
  fbIcon?: string;
  priority?: boolean;
  onFail?: () => void;
}

/** 懒加载图片：首次失败带 ?r=1 重试一次，再失败走兜底。 */
export function LazyImg({
  src,
  srcSet,
  sizes,
  alt,
  fallbackClass,
  fbIcon,
  priority,
  onFail,
}: LazyImgProps) {
  const [state, setState] = useState('ok'); // ok | failed
  const triedRef = useRef(false);
  if (!src || state === 'failed' || isImgFailed(src)) {
    return fallbackClass === 'row-thumb-fb' ? (
      <span className="row-thumb-fb">
        <Icon n={fbIcon ?? 'image'} />
      </span>
    ) : (
      <div className={fallbackClass}>
        <Icon n={fbIcon ?? 'image'} />
      </div>
    );
  }
  return (
    <img
      loading={priority ? 'eager' : 'lazy'}
      decoding="async"
      {...(priority ? { fetchPriority: 'high' } : {})}
      src={src}
      srcSet={srcSet}
      sizes={srcSet ? sizes : undefined}
      alt={alt}
      onLoad={(ev: ReactSyntheticEvent<HTMLImageElement>) =>
        ev.currentTarget.classList.add('img-ready')
      }
      onError={(ev: ReactSyntheticEvent<HTMLImageElement>) => {
        const img = ev.currentTarget;
        if (img.complete && img.naturalWidth > 0) return;
        if (!triedRef.current) {
          triedRef.current = true;
          img.removeAttribute('srcset');
          const u = (src.split('#')[0] || '') + (src.includes('?') ? '&' : '?') + 'r=1';
          img.src = u;
          return;
        }
        markImgFailed(src);
        setState('failed');
        if (onFail) onFail();
      }}
    />
  );
}

export interface CardTileProps {
  e: CardData;
  onOpen: (e: CardData) => void;
  /** 搜索词只用于切文本高亮；卡片的 aria-label / title 保持原文。 */
  query?: string;
  priority?: boolean;
}

export interface RowProps {
  e: CardData;
  onOpen: (e: CardData) => void;
  query?: string;
}

/** 点卡片空白处打开详情；卡内的按钮 / 链接 / 标签有自己的动作，不劫持它们。 */
function openFromClick(
  ev: ReactMouseEvent<HTMLElement>,
  e: CardData,
  onOpen: (e: CardData) => void,
): void {
  const target = ev.target;
  if (target instanceof Element && target.closest('button, a, [data-tag]')) return;
  onOpen(e);
}

export function CardInner({ e, onOpen, query, priority }: CardTileProps) {
  const s = S();
  const srcName = e.feedName ? (s.shortFeedName ? s.shortFeedName(e.feedName) : e.feedName) : '';
  const hasImg = !!e.image;
  const [imgFailed, setImgFailed] = useState(false);
  const showMedia = hasImg && !imgFailed && !isImgFailed(e.image);
  const fmtDate = s.fmtDate || ((d: unknown) => (d ? String(d) : ''));
  const unread = !e.isRead;
  const dot = <span className={'card-dot' + (unread ? '' : ' is-read')} aria-hidden="true" />;

  const copyBtn = <CopyButton e={e} />;
  const openBtn = <OpenButton e={e} />;
  const hasActions = copyableLinks(e).length > 0 || !!(e.sourceUrl || e.link);

  const media = showMedia ? (
    <div className="card-media">
      <LazyImg
        src={e.image}
        srcSet={widthSrcSet(e.image, [320, 640, 960])}
        sizes="(max-width: 720px) 46vw, 320px"
        alt={e.name}
        fallbackClass="media-fallback"
        fbIcon="image"
        priority={priority}
        onFail={() => setImgFailed(true)}
      />
      {dot}
      {srcName ? (
        <span className="badge-source" title={e.feedName}>
          {srcName}
        </span>
      ) : null}
      {e.size ? <span className="badge-size">{e.size}</span> : null}
      {e.date ? <span className="badge-idx">{fmtDate(e.date)}</span> : null}
      {hasActions ? (
        <div className="card-media-actions">
          {copyBtn}
          {openBtn}
        </div>
      ) : null}
    </div>
  ) : null;

  const metaRow = showMedia ? null : (
    <div className="card-meta">
      {dot}
      {srcName ? (
        <span className="src-pill" title={e.feedName}>
          {srcName}
        </span>
      ) : null}
      {e.size ? <span className="meta-size">{e.size}</span> : null}
      <span className="meta-date">{fmtDate(e.date)}</span>
    </div>
  );

  return (
    <article
      className={'card' + (showMedia ? ' card-has-media' : '') + (e.isFavorite ? ' is-fav' : '')}
      data-id={e.id}
      onClick={/** @param {*} [ev] */ (ev) => openFromClick(ev, e, onOpen)}
    >
      {media}
      <div className="card-body">
        {metaRow}
        <h3 className="card-title" title={e.name}>
          <button
            type="button"
            className="title-btn"
            aria-label={(unread ? '未读，' : '') + (e.name || '卡片')}
            onClick={() => onOpen(e)}
          >
            <HighlightText text={e.name} query={query} />
          </button>
        </h3>
        {e.desc ? (
          <p className="card-desc">
            <HighlightText text={e.desc} query={query} />
          </p>
        ) : null}
        {showMedia || !hasActions ? null : (
          <div className="card-foot">
            {copyBtn}
            {openBtn}
          </div>
        )}
      </div>
    </article>
  );
}

export function RowInner({ e, onOpen, query }: RowProps) {
  const s = S();
  const srcName = e.feedName ? (s.shortFeedName ? s.shortFeedName(e.feedName) : e.feedName) : '';
  const fmtDate = s.fmtDate || ((d: unknown) => (d ? String(d) : ''));
  const metaHas = !!srcName;
  const unread = !e.isRead;
  return (
    <article
      className={'row-item' + (e.isFavorite ? ' is-fav' : '')}
      data-id={e.id}
      onClick={/** @param {*} [ev] */ (ev) => openFromClick(ev, e, onOpen)}
    >
      <div className="row-thumb">
        <span className={'card-dot row-dot' + (unread ? '' : ' is-read')} aria-hidden="true" />
        {e.image ? (
          <LazyImg
            src={widthVariant(e.image, 320) || e.image}
            alt={e.name}
            fallbackClass="row-thumb-fb"
            fbIcon="image"
          />
        ) : (
          <span className="row-thumb-fb">
            <Icon n="image" />
          </span>
        )}
      </div>
      <div className="row-main">
        <div className="row-head">
          <h3 className="row-title" title={e.name}>
            <button
              type="button"
              className="title-btn"
              aria-label={(unread ? '未读，' : '') + (e.name || '卡片')}
              onClick={() => onOpen(e)}
            >
              <HighlightText text={e.name} query={query} />
            </button>
          </h3>
          <span className="row-facts">
            {e.size ? <span className="meta-size">{e.size}</span> : null}
            <span className="row-date">{fmtDate(e.date)}</span>
          </span>
        </div>
        {e.desc ? (
          <p className="row-desc">
            <HighlightText text={e.desc} query={query} />
          </p>
        ) : null}
        {metaHas ? (
          <div className="row-tags">
            <span className="src-pill" title={e.feedName}>
              {srcName}
            </span>
          </div>
        ) : null}
      </div>
      <div className="row-actions">
        <CopyButton e={e} />
        <OpenButton e={e} />
      </div>
    </article>
  );
}

/* ---------- 骨架（张数由调用方按 firstPageSize 决定，与原实现同源） ---------- */
export function Skeletons({ view, count }: { view: ViewMode; count: number }) {
  const n = Array.from({ length: count }, /** @param {*} [_] @param {*} [i] */ (_, i) => i);
  if (view === 'list') {
    return n.map(
      /** @param {*} [i] */ (i) => (
        <div className="sk-row" key={i}>
          <div className="sk-row-thumb" />
          <div className="sk-row-lines">
            <div className="sk-row-line w70" />
            <div className="sk-row-line w90" />
            <div className="sk-row-line w40" />
          </div>
        </div>
      ),
    );
  }
  return n.map(
    /** @param {*} [i] */ (i) => (
      <div className="sk-card" key={i}>
        <div className="sk-media" />
        <div className="sk-line w85" />
        <div className="sk-line" />
        <div className="sk-line w60" />
      </div>
    ),
  );
}

/* ---------- 窄屏频道抽屉外壳（频道树由调用方作为 children 传入） ---------- */
export function CardsSidebar({
  cardFeedsCount,
  badge,
  onClose,
  children,
}: {
  cardFeedsCount: number;
  badge: (n: number) => string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <>
      <div
        className="cards-mask"
        id="cardsMask"
        onClick={() => {
          onClose();
        }}
      />
      <aside className="cards-side" id="cardsSide" aria-label="频道列表">
        <div className="side-brand">
          <BrandLogo />
          <span className="side-brand-name">笺川</span>
        </div>
        <div className="cards-side-head">
          <span>频道</span>
          <span className="reader-side-n" id="cardsSideN">
            {cardFeedsCount ? `${badge(cardFeedsCount)} 个` : ''}
          </span>
          <button
            className="reader-side-close"
            id="cardsSideClose"
            type="button"
            aria-label="收起频道列表"
            onClick={() => {
              onClose();
            }}
          >
            <svg className="ico" aria-hidden="true" focusable="false">
              <use href="#i-x" />
            </svg>
          </button>
        </div>
        <nav className="cards-channels" id="cardsChannels">
          {children}
        </nav>
      </aside>
    </>
  );
}

/* ---------- 列表主体：计数 / 骨架 / 网格 / 空态 / 加载更多 ---------- */
export function CardsMain({
  s,
  st,
  writable,
  view,
  list,
  skeletons,
  CardComp,
  RowComp,
  showSkeleton,
  showEmpty,
  showGrid,
  showLoadingMore,
  noFeeds,
  noCards,
  groupFilter,
  detailEntry,
  closeDetail,
  onTag,
  onAiTag,
  onOpenCard,
  onSearchClear,
  onApplySearch,
}: {
  s: ReturnType<typeof S>;
  st: AppState;
  writable: boolean;
  view: ViewMode;
  list: CardData[];
  skeletons: ReactNode;
  CardComp: ComponentType<CardTileProps>;
  RowComp: ComponentType<RowProps>;
  showSkeleton: boolean;
  showEmpty: boolean;
  showGrid: boolean;
  showLoadingMore: boolean;
  noFeeds: boolean;
  noCards: boolean;
  groupFilter: boolean;
  detailEntry: CardData | null | undefined;
  closeDetail: () => void;
  onTag: (t: string) => void;
  onAiTag: (t: string) => void;
  onOpenCard: (e: CardData) => void;
  onSearchClear: () => void;
  onApplySearch: (q: string) => void;
}) {
  let emptyMsg: string | null = null;
  let emptyAction: EmptyAction | null = null;
  if (st.loadError) {
    emptyMsg = st.loadMoreErrMsg
      ? `数据加载失败：${st.loadMoreErrMsg}`
      : '数据加载失败，请稍后重试';
    emptyAction = { label: '重试', run: () => s.loadPage(true) };
  } else if (noFeeds) {
    emptyMsg = writable
      ? '还没有订阅源，去「设置 → 数据源」添加 RSS 地址'
      : '还没有订阅源；只读账户不能自行添加';
    emptyAction = writable ? { label: '添加订阅源', run: () => s.readerOpenSource() } : null;
  } else if (noCards) {
    emptyMsg = writable
      ? '所有频道的「卡片」开关都关掉了，去「设置 → 数据源」打开即可在卡片页阅读'
      : '所有频道的「卡片」开关都关掉了，可切到「文章」页阅读';
    emptyAction = writable
      ? { label: '去数据源设置', run: () => s.readerOpenSource() }
      : {
          label: '切到文章页',
          run: () => {
            if (s.switchView) s.switchView('reader');
          },
        };
  } else if (!list.length) {
    if (st.q) {
      emptyMsg = `没有找到匹配「${st.q}」的资源`;
      emptyAction = { label: '清除搜索', run: () => onSearchClear() };
    } else if (st.tag || st.aiTag) {
      emptyMsg = st.aiTag ? '该 AI 标签下暂无内容' : '该标签下暂无内容';
      emptyAction = {
        label: '清除标签',
        run: () => (st.aiTag ? s.cardsAiTag(null) : s.cardsTag(null)),
      };
    } else {
      emptyMsg = groupFilter
        ? '该分组暂无内容'
        : st.feedFilter == null
          ? '还没有内容'
          : '这个频道还没有内容';
      emptyAction = groupFilter
        ? { label: '查看全部频道', run: () => s.cardsFilterFeed('') }
        : st.feedFilter == null
          ? writable
            ? { label: '重新抓取', run: () => s.refresh() }
            : null
          : { label: '查看全部频道', run: () => s.cardsFilterFeed('') };
    }
  }

  return (
    <>
      {(st.q || st.tag || st.aiTag) && !showSkeleton && !showEmpty ? (
        <div className="list-count" role="status">
          {st.q ? (
            <span>
              「{st.q}」找到 {st.total} 条结果
            </span>
          ) : null}
          {st.q && st.sort === 'relevance' ? (
            <span className="count-chip">按相关度排序</span>
          ) : null}
          {st.tag ? (
            <span className="count-chip">
              标签：{st.tag}
              {!st.q ? <span className="count-chip-n">{st.total} 条</span> : null}
              <button
                type="button"
                className="count-clear"
                aria-label="清除标签筛选"
                title="清除标签筛选"
                onClick={() => s.cardsTag(null)}
              >
                <svg className="ico" aria-hidden="true" focusable="false">
                  <use href="#i-x" />
                </svg>
              </button>
            </span>
          ) : null}
          {st.aiTag ? (
            <span className="count-chip count-chip-ai">
              AI 标签：{st.aiTag}
              {!st.q ? <span className="count-chip-n">{st.total} 条</span> : null}
              <button
                type="button"
                className="count-clear"
                aria-label="清除 AI 标签筛选"
                title="清除 AI 标签筛选"
                onClick={() => s.cardsAiTag(null)}
              >
                <svg className="ico" aria-hidden="true" focusable="false">
                  <use href="#i-x" />
                </svg>
              </button>
            </span>
          ) : null}
        </div>
      ) : null}
      <SavedSearches view="cards" q={st.q || ''} onApply={onApplySearch} />
      {showSkeleton ? (
        <div id="skeleton" className={'grid' + (view === 'list' ? ' list-mode' : '')}>
          {skeletons}
        </div>
      ) : null}

      {showGrid ? (
        <div id="grid" className={'grid' + (view === 'list' ? ' list-mode' : '')}>
          {list.map(
            /** @param {*} [e] @param {*} [i] */ (e, i) =>
              view === 'list' ? (
                <RowComp e={e} onOpen={onOpenCard} query={st.q || ''} key={e.id} />
              ) : (
                <CardComp
                  e={e}
                  onOpen={onOpenCard}
                  query={st.q || ''}
                  priority={i < 6}
                  key={e.id}
                />
              ),
          )}
        </div>
      ) : (
        <div id="grid" className="grid" hidden />
      )}

      {showEmpty ? (
        <div id="empty" className="empty">
          <div className="empty-ico">
            <svg className="ico" aria-hidden="true" focusable="false">
              <use href="#i-inbox" />
            </svg>
          </div>
          <p>{emptyMsg}</p>
          {emptyAction ? (
            <button
              type="button"
              className="btn btn-primary empty-action"
              onClick={emptyAction.run}
            >
              {emptyAction.label}
            </button>
          ) : null}
        </div>
      ) : (
        <div id="empty" className="empty" hidden>
          <div className="empty-ico">
            <svg className="ico" aria-hidden="true" focusable="false">
              <use href="#i-inbox" />
            </svg>
          </div>
          <p />
        </div>
      )}

      <div className="loadmore-wrap">
        {st.loadMoreErr ? (
          <div className="load-retry" role="alert">
            <span>加载失败{st.loadMoreErrMsg ? `：${st.loadMoreErrMsg}` : ''}</span>
            <button type="button" className="btn" onClick={() => s.cardsRetryMore()}>
              重试
            </button>
          </div>
        ) : null}
        <div className="loading-dots" id="loadingMore" hidden={!showLoadingMore}>
          <i />
          <i />
          <i />
        </div>
        <div className="cards-sentinel" id="cardsSentinel" aria-hidden="true" />
      </div>
      {!showSkeleton && !showEmpty && list.length > 0 && !st.hasMore && !showLoadingMore ? (
        <div className="list-end">已经到底了</div>
      ) : null}
      <CardDetailModal
        entry={detailEntry}
        onClose={closeDetail}
        onTag={
          /** @param {*} [t] */ (t) => {
            closeDetail();
            onTag(t);
          }
        }
        onAiTag={
          /** @param {*} [t] */ (t) => {
            closeDetail();
            onAiTag(t);
          }
        }
      />
    </>
  );
}

/* ---------- 卡片详情弹窗 ---------- */
export function CardDetailModal({
  entry,
  onClose,
  onTag,
  onAiTag,
}: {
  entry: CardData | null | undefined;
  onClose: () => void;
  onTag: (t: string) => void;
  onAiTag: (t: string) => void;
}) {
  if (!entry) return null;
  return (
    <CardDetail
      e={entry}
      onClose={onClose}
      onTag={
        /** @param {*} [t] */ (t) => {
          onClose();
          onTag(t);
        }
      }
      onAiTag={
        /** @param {*} [t] */ (t) => {
          onClose();
          onAiTag(t);
        }
      }
    />
  );
}
