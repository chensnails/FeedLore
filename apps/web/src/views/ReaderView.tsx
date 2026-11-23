/* 文章（reader）视图（已 React 化，原 index.html 的 #readerView 内联 DOM +
 * app.js 的阅读页渲染迁移至此，P3c）。
 *
 * 渲染与控件留在组件：列表项、吸顶头部、频道抽屉；状态 / 搜索 / 文案在 ReaderView.hooks.ts，
 * 正文分层渲染在 ReaderView.body.tsx，列表项 / 抽屉外壳 / 空态在 ReaderView.parts.tsx。
 * 类名 / ID / data 属性与旧 DOM 一致，样式零改动。 */

import { core } from '@core';
import { memo, type ReactNode, useCallback, useMemo, useRef } from 'react';
import type { EntityId, EntryDetail } from '../core/types.ts';
import { useTopbarHeight } from '../shell/useTopbarHeight.ts';
import { ChannelTabs } from '../ui/ChannelTabs.tsx';
import { ArtActions } from '../ui/EntryActions.tsx';
import { EntryAiBar } from '../ui/EntryAiBar.tsx';
import { NO_AUTOFILL_PROPS } from '../ui/noAutofill.ts';
import { OverflowMenu } from '../ui/OverflowMenu.tsx';
import { SavedSearches } from '../ui/SavedSearches.tsx';
import { ViewNav } from '../ui/ViewNav.tsx';
import type { ChannelGroup } from './ChannelList.tsx';
import { ChannelList } from './ChannelList.tsx';
import { parseBlocks, renderBodyContent } from './ReaderView.body.tsx';
import { useReaderVm } from './ReaderView.hooks.ts';
import {
  ArtItemInner,
  ReaderCountChip,
  ReaderEmpty,
  ReaderHeadActions,
  ReaderLoadMore,
  ReaderSidebar,
  ReaderSideResize,
} from './ReaderView.parts.tsx';

const S = () => core;

/** ArtBody 的 props：正文用 EntryDetail（列表 / 弹窗取到的是带 content 的详情）。 */
interface ArtBodyProps {
  e: EntryDetail;
  onTag?: (tag: string) => void;
  onAiTag?: (tag: string) => void;
  extraActions?: ReactNode;
}

/** 正文（对应旧 artBodyHtml）：图文按原顺序内联；老数据回退为图集 + 段落。
 *  导出给卡片详情弹窗（src/views/CardDetail.tsx）复用，两处正文渲染保持一套。
 *  extraActions：弹窗会把「收藏 / 在文章页查看」也塞进这条动作行，保证一个弹窗只有一排按钮。 */
export function ArtBody({ e, onTag, onAiTag, extraActions }: ArtBodyProps) {
  const s = S();
  const fmtFull = s.fmtFull || ((d: unknown) => (d ? String(d) : ''));
  const parts: ReactNode[] = [];
  /* 单条目 AI 动作条放在正文之前 —— 也就是标题行的正下方。
   * 文章页与卡片详情共用这个 ArtBody，一处生效两处；早先挂在正文末尾，
   * 要读完整篇才看得见入口（用户反馈后调整，别再挪回底部）。 */
  parts.push(<EntryAiBar key="ai" entryId={e.id} />);
  const blocks = parseBlocks(e.bodyJson);
  for (const p of renderBodyContent(e, blocks, fmtFull, onTag, onAiTag)) parts.push(p);
  parts.push(<ArtActions key="acts" e={e} extraActions={extraActions} />);
  return <div className="art-inner">{parts}</div>;
}

export { bodyShowsText } from './ReaderView.body.tsx';

/* 列表项做成 memo：每次 __readerTick 都会把整列 entries 重新 map 一遍，
 * 没变的那几百条不必跟着重新渲染。回调由本组件 useCallback 稳定化。 */
const ArtItem = memo(ArtItemInner);

export function ReaderView() {
  const vm = useReaderVm();
  const {
    s,
    st,
    title,
    accordionOn,
    hasUnread,
    anyExpanded,
    searchOpen,
    searchName,
    searchRef,
    q,
    qDraft,
    firstLoad,
    emptyMsg,
    emptyAction,
    onSearchInput,
    onSearchKey,
    onSearchClear,
    toggleSearch,
    cbScope,
    cbFeed,
    cbGroup,
    cbFold,
    cbWatch,
    cbAdd,
    comfortable,
    entries,
    expanded,
    bodyMap,
    bodyErrSet,
    flashId,
    onUnreadArt,
    onRetryBodyArt,
    onTagArt,
    onAiTagArt,
  } = vm;

  // 合并后第一行（≡频道 / 标题 / 文章动作 / 搜索 / ⋮）即吸顶条，由其写入 --topbar-h
  const headRef = useRef<HTMLDivElement | null>(null);
  useTopbarHeight(headRef);

  // 频道栏：分组与折叠状态一次算好，头部「全部折叠」按钮与列表必须同源
  const grouped: ChannelGroup[] = useMemo(
    () => (s.groupFeeds ? s.groupFeeds(vm.feeds) : [{ name: '', feeds: vm.feeds }]),
    [st.feedList],
  );
  const collapseKey = JSON.stringify(st.rdCollapsedGroups || []);
  const collapsed = useMemo(
    () => (s.readerCollapsedGroups ? s.readerCollapsedGroups() : new Set<string>()),
    [collapseKey],
  );
  const hasGroups = grouped.some((g) => g.name);
  const allCollapsed = hasGroups && grouped.every((g) => collapsed.has(g.name || ''));

  // memo 的前提是回调稳定：core 是单例，回调里现取即可。
  const onToggleArt = useCallback((id: EntityId) => {
    const c = S();
    if (c.readerToggleArt) c.readerToggleArt(id);
  }, []);
  const onFavArt = useCallback((id: EntityId) => {
    const c = S();
    if (c.readerToggleFav) c.readerToggleFav(id);
  }, []);

  return (
    <>
      <ReaderSidebar
        feedsCount={vm.feeds.length}
        badge={s.fmtBadge}
        hasGroups={hasGroups}
        allCollapsed={allCollapsed}
        onClose={() => s.readerCloseDrawer && s.readerCloseDrawer()}
        onToggleAll={() => s.readerToggleAllGroups && s.readerToggleAllGroups()}
      >
        <ChannelList
          variant="reader"
          groups={grouped}
          collapsed={collapsed}
          hasGroups={hasGroups}
          flags={vm.flags}
          activeScope={st.rdScope}
          activeFeedId={st.rdFeedId}
          activeGroup={st.rdGroup}
          activeWatch={st.rdWatch}
          onScope={cbScope}
          onFeed={cbFeed}
          onGroup={cbGroup}
          onFold={cbFold}
          onWatch={cbWatch}
          onAdd={cbAdd}
        />
      </ReaderSidebar>
      <ReaderSideResize />

      <section className="reader-main">
        <div className="reader-head page-head view-toolbar" ref={headRef}>
          <button
            className="btn btn-ghost btn-sm reader-menu-btn vt-channel"
            id="readerMenuBtn"
            type="button"
            aria-label="打开频道列表"
            onClick={() => s.readerToggleDrawer && s.readerToggleDrawer()}
          >
            <svg className="ico" aria-hidden="true" focusable="false">
              <use href="#i-menu" />
            </svg>
            <span className="reader-menu-label">频道</span>
          </button>
          <div className="reader-head-text">
            <h2 className="page-title vt-title" id="readerTitle">
              {title}
            </h2>
          </div>
          {/* 右侧簇：文章动作（单篇/多篇、全部已读、全部收起）+ 搜索 + ⋮ 菜单。 */}
          <div className="reader-head-tools page-tools vt-tools">
            <ReaderHeadActions
              s={s}
              accordionOn={accordionOn}
              hasUnread={hasUnread}
              anyExpanded={anyExpanded}
            />
            {/* 搜索：桌面常驻胶囊、窄屏收进放大镜，展开时独占第二行 */}
            <div className={'reader-search page-search vt-search' + (searchOpen ? ' is-open' : '')}>
              <svg className="search-ico" aria-hidden="true" focusable="false">
                <use href="#i-search" />
              </svg>
              <input
                id="readerSearch"
                name={searchName}
                type="search"
                ref={searchRef}
                defaultValue={q}
                placeholder="搜索标题、描述、正文或标签…"
                title="搜索当前列表 · ⌘K / Ctrl K 打开命令面板"
                enterKeyHint="search"
                aria-label="搜索文章"
                onInput={onSearchInput}
                onKeyDown={onSearchKey}
                {...NO_AUTOFILL_PROPS}
              />
              <button
                className="reader-search-clear"
                id="readerSearchClear"
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
              className={'btn btn-ghost btn-sm reader-search-toggle' + (searchOpen ? ' is-on' : '')}
              id="readerSearchToggle"
              type="button"
              aria-expanded={searchOpen ? 'true' : 'false'}
              aria-controls="readerSearch"
              title={searchOpen ? '收起搜索' : '搜索文章'}
              onClick={toggleSearch}
            >
              <svg className="ico" aria-hidden="true" focusable="false">
                <use href={searchOpen ? '#i-x' : '#i-search'} />
              </svg>
            </button>
            <ViewNav />
            <OverflowMenu
              view="reader"
              readerControls
              readerState={{ accordionOn, hasUnread, anyExpanded }}
            />
          </div>
          {/* 窄屏第二行：横滑频道条（桌面 display:none，仍走常驻侧栏）。 */}
          <ChannelTabs
            variant="reader"
            groups={grouped}
            activeScope={st.rdScope}
            activeFeedId={st.rdFeedId}
            activeGroup={st.rdGroup}
            activeWatch={st.rdWatch}
            onScope={cbScope}
            onFeed={cbFeed}
            onWatch={cbWatch}
            onManage={() => s.readerToggleDrawer && s.readerToggleDrawer()}
          />
        </div>

        {(q || st.rdTag || st.rdAiTag) && entries.length > 0 ? (
          <ReaderCountChip
            q={q}
            tag={st.rdTag}
            aiTag={st.rdAiTag}
            total={st.rdTotal}
            onClearTag={() => s.readerSetTag('', false)}
            onClearAiTag={() => s.readerSetTag('', true)}
          />
        ) : null}
        <SavedSearches
          view="reader"
          q={q}
          onApply={(word) => {
            const c = S();
            if (c.readerSearch) c.readerSearch(word);
          }}
        />
        <div className="reader-list" id="readerList">
          {entries.map(
            /** @param {*} [e] */ (e) => (
              <ArtItem
                key={e.id}
                e={e}
                query={q}
                expanded={expanded.has(e.id)}
                full={bodyMap.get(e.id)}
                bodyErr={bodyErrSet.has(e.id)}
                flash={flashId != null && flashId === String(e.id)}
                comfortable={comfortable}
                onToggle={onToggleArt}
                onFav={onFavArt}
                onUnread={onUnreadArt}
                onRetryBody={onRetryBodyArt}
                onTag={onTagArt}
                onAiTag={onAiTagArt}
              />
            ),
          )}
        </div>

        <ReaderEmpty msg={emptyMsg} action={emptyAction} hidden={entries.length > 0 || firstLoad} />
        <ReaderLoadMore
          err={!!st.rdLoadMoreErr}
          loading={!!st.rdLoading}
          onRetry={() => s.readerRetryMore()}
        />
        {entries.length > 0 && !st.rdHasMore && !st.rdLoading ? (
          <div className="list-end">已经到底了</div>
        ) : null}

        <footer className="foot">点标题阅读全文，再点一次收起</footer>
      </section>
    </>
  );
}
