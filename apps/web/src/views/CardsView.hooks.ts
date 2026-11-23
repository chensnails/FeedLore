/* 卡片视图的状态与逻辑：tick 订阅、搜索（防抖 / 外部同步 / 聚焦）、频道分组与选项、
 * 频道筛选回调、详情弹窗、稳定的 memo 回调。自动翻页闸门留在 CardsView.tsx 本体。 */

import { core } from '@core';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  SyntheticEvent as ReactSyntheticEvent,
} from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppState, Card as CardData, EntityId } from '../core/types.ts';
import { provide, revoke } from '../kernel/bridge.ts';
import { EVENT, on } from '../kernel/events.ts';
import { useNoAutofillName } from '../ui/noAutofill.ts';
import type { ChannelGroup } from './ChannelList.tsx';
import type { DropdownOption } from './Dropdown.tsx';

const S = () => core;

export interface EmptyAction {
  label: string;
  run: () => void;
}

/** 卡片视图的全部状态与回调；headRef 与自动翻页 effect 留在组件里。 */
export function useCardsVm() {
  const s = S();
  const [, bump] = useState(0);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const searchName = useNoAutofillName('cards-q');
  const st: AppState = (s && s.state) || ({} as AppState);
  const writable = !!(s && s.isWritable ? s.isWritable() : true);

  const [qDraft, setQDraft] = useState<string>(st.q || '');
  const [detailId, setDetailId] = useState<EntityId | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    const onTick = () => bump((x) => x + 1);
    return on(EVENT.CARDS, onTick);
  }, []);

  useEffect(() => {
    provide('cardsFocusSearch', () => {
      setSearchOpen(true);
      requestAnimationFrame(() => {
        const el = searchRef.current;
        if (el) {
          el.focus();
          if (typeof el.select === 'function') el.select();
        }
      });
    });
    return () => {
      revoke('cardsFocusSearch');
    };
  }, []);

  useEffect(() => {
    if (!searchOpen) return;
    const el = searchRef.current;
    if (el) {
      el.focus();
      if (typeof el.select === 'function') el.select();
    }
  }, [searchOpen]);

  useEffect(() => {
    if (st.q) setSearchOpen(true);
    if (searchRef.current && searchRef.current === document.activeElement) return;
    setQDraft(st.q || '');
  }, [st.q]);

  const feeds = st.feedList || [];
  const list = s && s.filterEntries ? s.filterEntries() : st.entries || [];
  const view = st.view || 'grid';
  const noEntries = (st.entries || []).length === 0;

  const cardFeeds = feeds.filter((f) => f.cardEnabled);
  const groups: ChannelGroup[] =
    s && s.groupFeeds ? s.groupFeeds(cardFeeds) : [{ name: '', feeds: cardFeeds }];
  const hasGroups = groups.length > 1 || !!(groups[0] && groups[0].name);
  const collapsedGroups =
    s && s.readerCollapsedGroups ? s.readerCollapsedGroups() : new Set<string>();
  const groupFilter = st.cardGroup != null;
  const curGroup = groupFilter ? groups.find((g) => g.name === st.cardGroup) || null : null;
  const groupLabel = groupFilter
    ? `分组 · ${st.cardGroup || '未分组'}${curGroup ? `（${(curGroup.feeds || []).reduce((n, f) => n + Number(f.unreadCount || 0), 0)}）` : ''}`
    : '';
  const feedValue = groupFilter
    ? 'g:' + st.cardGroup
    : st.feedFilter == null
      ? ''
      : String(st.feedFilter);

  const curCardFeed =
    st.feedFilter == null ? null : feeds.find((f) => String(f.id) === String(st.feedFilter));
  const headTitle =
    (curCardFeed
      ? s.shortFeedName
        ? s.shortFeedName(s.feedTitle ? s.feedTitle(curCardFeed) : curCardFeed.title)
        : curCardFeed.title
      : groupLabel || '全部频道') +
    (st.tag ? ` · #${st.tag}` : '') +
    (st.aiTag ? ` · AI #${st.aiTag}` : '');

  const noFeeds = !feeds.length;
  const noCards =
    !st.tag && !st.aiTag && !st.feedFilter && !groupFilter && !feeds.some((f) => f.cardEnabled);

  const hasMeta = !!st.feedMeta;
  const firstLoad = !!st.loading && noEntries;
  const showSkeleton = firstLoad;
  const showEmpty = !firstLoad && hasMeta && emptyMsgProbe(st, list, noFeeds, noCards, groupFilter);
  const showGrid = !showSkeleton && !showEmpty;
  const showLoadingMore = !!st.loading && !firstLoad;

  /* 搜索回调引用稳定：列表项已 memo，每次输入都换函数会让整列白重绘一遍。 */
  const onSearchInput = useCallback(
    (ev: ReactSyntheticEvent<HTMLInputElement>) => {
      const v = ev.currentTarget.value;
      setQDraft(v);
      clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        if (s.cardsSearch) s.cardsSearch(v.trim());
      }, 300);
    },
    [s],
  );
  const onSearchKey = useCallback(
    (ev: ReactKeyboardEvent<HTMLInputElement>) => {
      if (ev.key !== 'Enter') return;
      clearTimeout(debounceRef.current);
      if (s.cardsSearch) s.cardsSearch(String((ev.target as HTMLInputElement).value).trim());
    },
    [s],
  );
  const onSearchClear = useCallback(() => {
    clearTimeout(debounceRef.current);
    setQDraft('');
    if (s.cardsSearch) s.cardsSearch('');
    if (searchOpen && searchRef.current) searchRef.current.focus();
  }, [s, searchOpen]);
  /* 从保存的搜索 chip 回用：输入框和 st.q 一起对齐，避免框里是旧词、列表是新词。 */
  const onApplySearch = useCallback(
    (word: string) => {
      const v = String(word ?? '').trim();
      setQDraft(v);
      clearTimeout(debounceRef.current);
      if (s.cardsSearch) s.cardsSearch(v);
    },
    [s],
  );
  const toggleSearch = useCallback(() => {
    if (!searchOpen) {
      setSearchOpen(true);
      return;
    }
    if (qDraft || st.q) onSearchClear();
    setSearchOpen(false);
  }, [searchOpen, qDraft, st.q, onSearchClear]);

  const onOpenCard = useCallback((e: CardData) => setDetailId(e.id), []);
  const onTag = useCallback((t: string) => {
    const c = S();
    if (c.cardsTag) c.cardsTag(c.state.tag === t ? null : t);
  }, []);
  const onAiTag = useCallback((t: string) => {
    const c = S();
    if (c.cardsAiTag) c.cardsAiTag(c.state.aiTag === t ? null : t);
  }, []);
  const toggleGroupFold = useCallback((name: string) => {
    const c = S();
    if (c.readerToggleGroupCollapse) c.readerToggleGroupCollapse(name);
  }, []);

  const pickFeed = (id: EntityId | null) => {
    if (s.cardsFilterFeed) s.cardsFilterFeed(id == null ? '' : id);
    if (s.cardsCloseDrawer) s.cardsCloseDrawer();
  };
  const pickGroup = (g: string) => {
    if (s.cardsFilterGroup) s.cardsFilterGroup(g);
    if (s.cardsCloseDrawer) s.cardsCloseDrawer();
  };
  const addChannel = () => {
    if (s.cardsCloseDrawer) s.cardsCloseDrawer();
    if (s.readerOpenSource) s.readerOpenSource();
  };

  const detailEntry =
    detailId == null ? null : (st.entries || []).find((x) => String(x.id) === String(detailId));

  const closeDetail = () => {
    const id = detailId;
    setDetailId(null);
    const el = document.querySelector<HTMLElement>(
      '[data-id="' +
        (window.CSS && window.CSS.escape ? window.CSS.escape(String(id)) : id) +
        '"] .title-btn',
    );
    if (el && el.focus) el.focus({ preventScroll: true });
  };

  const feedLabel = (f: (typeof feeds)[number]) => {
    const title = s.feedTitle ? s.feedTitle(f) : f.title;
    const name = s.shortFeedName ? s.shortFeedName(title) : title;
    return `${name}（${s.fmtBadge(Number(f.unreadCount || 0))}）`;
  };
  const cardUnread = cardFeeds.reduce((n, f) => n + Number(f.unreadCount || 0), 0);
  const feedOpts: DropdownOption[] = [
    { value: '', label: `全部频道（${s.fmtBadge(cardUnread)}）` },
  ];
  for (const g of groups) {
    for (const f of g.feeds || [])
      feedOpts.push({ value: String(f.id), label: feedLabel(f), group: g.name || '' });
  }

  return {
    s,
    st,
    writable,
    feeds,
    cardFeeds,
    groups,
    hasGroups,
    collapsedGroups,
    feedValue,
    groupLabel,
    headTitle,
    noFeeds,
    noCards,
    groupFilter,
    list,
    view,
    firstLoad,
    showSkeleton,
    showEmpty,
    showGrid,
    showLoadingMore,
    feedOpts,
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
  };
}

/** 空态文案是否非空 —— CardsMain 内也用同一组分支算文案，这里只判「是否有分支命中」。 */
function emptyMsgProbe(
  st: AppState,
  list: CardData[],
  noFeeds: boolean,
  noCards: boolean,
  _groupFilter: boolean,
): boolean {
  if (st.loadError || noFeeds || noCards || !list.length) return true;
  return false;
}
