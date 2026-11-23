/* 卡片视图（已 React 化）：渲染 + 控件留在本组件，状态 / 卡片 / 列表主体分到 hooks / parts。
 * 类名 / ID / data 属性与旧 DOM 一致，样式零改动。 */

import { core } from '@core';
import { memo, useEffect, useRef } from 'react';
import { EVENT, on } from '../kernel/events.ts';
import { useTopbarHeight } from '../shell/useTopbarHeight.ts';
import { ChannelTabs } from '../ui/ChannelTabs.tsx';
import { NO_AUTOFILL_PROPS } from '../ui/noAutofill.ts';
import { OverflowMenu } from '../ui/OverflowMenu.tsx';
import { ViewNav } from '../ui/ViewNav.tsx';
import { useCardsVm } from './CardsView.hooks.ts';
import { CardInner, CardsMain, CardsSidebar, RowInner, Skeletons } from './CardsView.parts.tsx';
import { ChannelList } from './ChannelList.tsx';
import { Dropdown } from './Dropdown.tsx';

const S = () => core;

/* 卡片与列表行都做成 memo：没变的卡面不必在每次 tick 重渲染。 */
const Card = memo(CardInner);
const Row = memo(RowInner);

/** 骨架张数与真实首屏批量一致（firstPageSize：窄屏 20 / 桌面 50）。 */
const skeletonCount = () => {
  const s = S();
  return s.firstPageSize ? s.firstPageSize() : 8;
};

export function CardsView() {
  const vm = useCardsVm();
  const {
    s,
    st,
    writable,
    feedValue,
    groupLabel,
    headTitle,
    groups,
    hasGroups,
    collapsedGroups,
    feedOpts,
    noFeeds,
    noCards,
    groupFilter,
    list,
    view,
    showSkeleton,
    showEmpty,
    showGrid,
    showLoadingMore,
    searchRef,
    searchName,
    qDraft,
    searchOpen,
    onSearchInput,
    onSearchKey,
    onSearchClear,
    onApplySearch,
    toggleSearch,
    onOpenCard,
    onTag,
    onAiTag,
    toggleGroupFold,
    pickFeed,
    pickGroup,
    addChannel,
    detailEntry,
    closeDetail,
  } = vm;

  // 合并头部：本视图第一行即吸顶条，实测高度写入 --topbar-h（隐藏视图测得 0 高不写）
  const headRef = useRef<HTMLDivElement | null>(null);

  /* 自动翻页的手势闸门（方案二）：列表被重置后，必须出现过一次真实滚动输入
     才允许续拉。真实输入（触摸 / 滚轮 / 键盘 / 按下指针）才重新开闸；
     首屏不满一屏仍走 350ms 兜底。 */
  const autoLoadArmed = useRef(false);
  useEffect(() => {
    const arm = () => {
      autoLoadArmed.current = true;
    };
    const onKey = (ev: KeyboardEvent) => {
      const t = ev.target;
      if (
        t instanceof HTMLElement &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      )
        return;
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(ev.key))
        arm();
    };
    document.addEventListener('pointerdown', arm, { capture: true, passive: true });
    document.addEventListener('touchmove', arm, { capture: true, passive: true });
    document.addEventListener('wheel', arm, { capture: true, passive: true });
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', arm, { capture: true });
      document.removeEventListener('touchmove', arm, { capture: true });
      document.removeEventListener('wheel', arm, { capture: true });
      document.removeEventListener('keydown', onKey, true);
    };
  }, []);
  useEffect(() => {
    autoLoadArmed.current = false;
  }, [st.listEpoch]);

  // 滚动到底部自动加载：#cardsSentinel 的视口坐标判定，document 捕获收齐所有容器；
  // 视图隐藏时不拉（几何归零会误判到底）；切回视图补一次判定。
  useEffect(() => {
    if (!st.hasMore) return undefined;
    const check = () => {
      if (st.loading || !st.hasMore || st.loadMoreErr || st.loadError || !(st.entries || []).length)
        return;
      const host = document.getElementById('cardsView');
      if (host && host.hidden) return;
      const el = document.getElementById('cardsSentinel');
      if (el && el.getBoundingClientRect().top < window.innerHeight + 480) {
        const scroller = document.querySelector('#cardsRoot > main.wrap');
        const shortList = !!scroller && scroller.scrollHeight - scroller.clientHeight <= 480;
        if (!autoLoadArmed.current && !shortList) return;
        if (s.cardsLoadMore) s.cardsLoadMore();
      }
    };
    document.addEventListener('scroll', check, { capture: true, passive: true });
    const onView = () => {
      setTimeout(check, 0);
    };
    const stopView = on(EVENT.VIEW, onView);
    const t = setTimeout(check, 350);
    return () => {
      document.removeEventListener('scroll', check, { capture: true });
      stopView();
      clearTimeout(t);
    };
  }, [st.hasMore, st.loading, st.loadMoreErr]);

  useTopbarHeight(headRef);

  return (
    <>
      <CardsSidebar
        cardFeedsCount={vm.cardFeeds.length}
        badge={s.fmtBadge}
        onClose={() => {
          if (s.cardsCloseDrawer) s.cardsCloseDrawer();
        }}
      >
        <ChannelList
          variant="cards"
          groups={groups}
          hasGroups={hasGroups}
          collapsed={collapsedGroups}
          activeFeedId={st.feedFilter}
          activeGroup={st.cardGroup}
          onFeed={pickFeed}
          onGroup={pickGroup}
          onFold={toggleGroupFold}
          onAdd={addChannel}
        />
      </CardsSidebar>

      <div className="cards-sticky" ref={headRef}>
        <div className="wrap cards-head page-head view-toolbar">
          <button
            className="btn btn-ghost btn-sm cards-menu-btn vt-channel"
            id="cardsMenuBtn"
            type="button"
            aria-label="打开频道列表"
            aria-controls="cardsSide"
            onClick={() => {
              if (s.cardsToggleDrawer) s.cardsToggleDrawer();
            }}
          >
            <svg className="ico" aria-hidden="true" focusable="false">
              <use href="#i-menu" />
            </svg>
            <span className="cards-menu-label">频道</span>
          </button>
          {/* 桌面 ≥721px 下拉即标题；≤720px 下拉退场、抽屉接管，文字标题回来。 */}
          <h2 className="cards-title page-title vt-title" title={headTitle}>
            {headTitle}
          </h2>
          <Dropdown
            wrapId="feedDD"
            id="feedSelect"
            title="频道筛选"
            ariaLabel={'频道筛选，当前：' + headTitle}
            value={feedValue}
            valueLabel={groupLabel}
            options={feedOpts}
            onChange={
              /** @param {*} [v] */ (v) => {
                if (s.cardsFilterFeed) s.cardsFilterFeed(v);
              }
            }
            collapsible
            collapsedGroups={collapsedGroups}
            onToggleGroup={toggleGroupFold}
            activeGroup={st.cardGroup}
            onGroupFilter={pickGroup}
          />
          <div className="head-right vt-tools">
            <div className={'search-box page-search vt-search' + (searchOpen ? ' is-open' : '')}>
              <svg className="search-ico" aria-hidden="true" focusable="false">
                <use href="#i-search" />
              </svg>
              <input
                id="searchInput"
                name={searchName}
                type="search"
                ref={searchRef}
                placeholder="搜索资源名称、描述、正文或标签…"
                title="搜索当前列表 · ⌘K / Ctrl K 打开命令面板"
                enterKeyHint="search"
                aria-label="搜索"
                value={qDraft}
                onChange={onSearchInput}
                {...NO_AUTOFILL_PROPS}
                onKeyDown={
                  /** @param {*} [ev] */ (ev) => {
                    if (ev.key === 'Escape') {
                      ev.stopPropagation();
                      toggleSearch();
                      const toggle = document.querySelector<HTMLElement>('.cards-search-toggle');
                      if (toggle && toggle.focus) toggle.focus();
                      return;
                    }
                    onSearchKey(ev);
                  }
                }
              />
              <button
                className="search-clear"
                id="searchClear"
                type="button"
                hidden={!qDraft}
                aria-label="清除搜索"
                onClick={onSearchClear}
              >
                <svg className="ico" aria-hidden="true" focusable="false">
                  <use href="#i-x" />
                </svg>
              </button>
            </div>
            <button
              className={'btn btn-ghost btn-sm cards-search-toggle' + (searchOpen ? ' is-on' : '')}
              id="cardsSearchToggle"
              type="button"
              aria-expanded={searchOpen ? 'true' : 'false'}
              aria-controls="searchInput"
              title={searchOpen ? '收起搜索' : '搜索'}
              onClick={toggleSearch}
            >
              <svg className="ico" aria-hidden="true" focusable="false">
                <use href={searchOpen ? '#i-x' : '#i-search'} />
              </svg>
            </button>
            <ViewNav />
            <OverflowMenu view="cards" cardControls sortValue={st.sort} viewMode={view} />
          </div>
          <ChannelTabs
            variant="cards"
            groups={groups}
            activeFeedId={st.feedFilter}
            activeGroup={st.cardGroup}
            onFeed={pickFeed}
            onManage={() => {
              if (s.cardsToggleDrawer) s.cardsToggleDrawer();
            }}
          />
        </div>
      </div>

      <main className="wrap">
        <CardsMain
          s={s}
          st={st}
          writable={writable}
          view={view}
          list={list}
          skeletons={<Skeletons view={view} count={skeletonCount()} />}
          CardComp={Card}
          RowComp={Row}
          showSkeleton={showSkeleton}
          showEmpty={showEmpty}
          showGrid={showGrid}
          showLoadingMore={showLoadingMore}
          noFeeds={noFeeds}
          noCards={noCards}
          groupFilter={groupFilter}
          detailEntry={detailEntry}
          closeDetail={closeDetail}
          onTag={onTag}
          onAiTag={onAiTag}
          onOpenCard={onOpenCard}
          onSearchClear={onSearchClear}
          onApplySearch={onApplySearch}
        />
        <footer className="foot">笺川 · FeedLore</footer>
      </main>
    </>
  );
}
