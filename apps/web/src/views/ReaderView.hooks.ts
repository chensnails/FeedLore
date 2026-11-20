/* 文章视图的状态与逻辑：tick 订阅、搜索（含防抖 / 外部同步 / 展开聚焦）、
 * 标题与空态文案、侧栏稳定回调、列表密度偏好。ReaderView 只保留渲染与守卫锚点。 */

import { core } from '@core';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  SyntheticEvent as ReactSyntheticEvent,
} from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EntityId, EntryDetail, ReaderScope, WatchFilter } from '../core/types.ts';
import { provide, revoke } from '../kernel/bridge.ts';
import { EVENT, on } from '../kernel/events.ts';
import { useNoAutofillName } from '../ui/noAutofill.ts';

const S = () => core;

export interface EmptyAction {
  label: string;
  run: () => void;
}

/** 外观里的「列表密度」会改变 DOM 结构（不是纯 CSS）：紧凑模式连 <img> 与摘要都不该下发。 */
export function useArticleListPrefs() {
  const read = () => {
    const a = (S().getAppearance && S().getAppearance()) || {};
    return a.listDensity !== 'compact';
  };
  const [comfortable, setComfortable] = useState<boolean>(read);
  useEffect(() => {
    const sync = () => setComfortable(read());
    return on(EVENT.APPEARANCE, sync);
  }, []);
  return comfortable;
}

/** ReaderView 的全部状态与回调。refs / headRef 等吸顶相关留在组件里。 */
export function useReaderVm() {
  const s = S();
  const [, bump] = useState(0);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const searchName = useNoAutofillName('reader-q');
  const [searchOpen, setSearchOpen] = useState(false);
  const comfortable = useArticleListPrefs();

  useEffect(() => {
    const onTick = () => bump((x) => x + 1);
    return on(EVENT.READER, onTick);
  }, []);

  useEffect(() => {
    provide('readerFocusSearch', () => {
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
      revoke('readerFocusSearch');
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

  const st = (s && s.state) || {};
  const writable = !!(s && s.isWritable ? s.isWritable() : true);
  const feeds = st.feedList || [];
  const entries = st.rdEntries || [];
  const rawFlags = st.rdFlags || { total: 0, unread: 0, favorite: 0 };
  const flagsKey = `${rawFlags.total}|${rawFlags.unread}|${rawFlags.favorite}|${rawFlags.watching ?? ''}|${rawFlags.blocked ?? ''}`;
  const flags = useMemo(() => rawFlags, [flagsKey]);
  const expanded = st.rdExpanded || new Set<number | string>();
  const bodyMap = st.rdBody || new Map<number | string, EntryDetail>();
  const bodyErrSet = st.rdBodyErr || new Set<number | string>();
  const accordionOn = !!(s && s.readerAccordionOn && s.readerAccordionOn());
  const flashId = st.rdFlashId == null ? null : String(st.rdFlashId);

  // 标题
  const cur = st.rdFeedId == null ? null : feeds.find((f) => String(f.id) === String(st.rdFeedId));
  let title = '全部文章';
  if (cur)
    title = s.shortFeedName
      ? s.shortFeedName(s.feedTitle ? s.feedTitle(cur) : cur.title)
      : cur.title;
  else if (st.rdWatch === 'watch') title = '关注';
  else if (st.rdWatch === 'block') title = '屏蔽';
  else if (st.rdGroup != null) title = `分组 · ${st.rdGroup || '未分组'}`;
  else if (st.rdScope === 'unread') title = '未读';
  else if (st.rdScope === 'favorite') title = '收藏';
  if (st.rdTag) title += ` · ${st.rdTag}`;
  else if (st.rdAiTag) title += ` · AI ${st.rdAiTag}`;

  const hasUnread = entries.some((e) => !e.isRead);
  const anyExpanded = expanded.size > 0;
  const q = st.rdQ || '';
  const [qDraft, setQDraft] = useState<string>(q);

  useEffect(() => {
    if (q) setSearchOpen(true);
  }, [q]);

  // 搜索框非受控；外部改 rdQ 时（卡片页跳转清空）必须把手动的框刷回去
  useEffect(() => {
    const el = searchRef.current;
    if (!el) return;
    if (q && el === document.activeElement) return;
    if (el.value === q && qDraft === q) return;
    el.value = q;
    el.dataset.hasval = q ? '1' : '';
    setQDraft(q);
  }, [q]);

  const firstLoad = !!st.rdLoading && !entries.length;

  let emptyMsg = '';
  let emptyAction: EmptyAction | null = null;
  if (!entries.length && !firstLoad) {
    if (st.rdReadError) {
      emptyMsg = st.rdReadErrorMsg || '加载失败';
      emptyAction = { label: '重试', run: () => s.readerReload() };
    } else if (q) {
      emptyMsg = `没有找到匹配「${q}」的文章`;
      emptyAction = { label: '清除搜索', run: () => onSearchClear() };
    } else if (st.rdTag || st.rdAiTag) {
      const t = st.rdAiTag || st.rdTag;
      emptyMsg = `「${t}」标签下暂无文章`;
      emptyAction = { label: '清除标签筛选', run: () => s.readerSetTag('', !!st.rdAiTag) };
    } else if (st.rdWatch === 'watch') {
      emptyMsg = writable
        ? '还没有命中的文章；在「设置 → 规则」里配置关键词，保存后点「应用到已有文章」'
        : '还没有命中的文章';
      emptyAction = writable ? { label: '打开规则设置', run: () => s.openSettings('watch') } : null;
    } else if (st.rdWatch === 'block') {
      emptyMsg = '没有被屏蔽的文章';
      emptyAction = writable ? { label: '管理屏蔽规则', run: () => s.openSettings('watch') } : null;
    } else if (st.rdScope === 'unread') {
      emptyMsg = '没有未读文章了';
      emptyAction = { label: '查看全部文章', run: () => s.readerSetScope('all') };
    } else if (st.rdScope === 'favorite') {
      emptyMsg = '还没有收藏，点文章右侧的星标收藏';
      emptyAction = { label: '查看全部文章', run: () => s.readerSetScope('all') };
    } else if (!feeds.length) {
      emptyMsg = writable
        ? '还没有订阅源，去「设置 → 数据源」添加 RSS 地址'
        : '还没有订阅源；只读账户不能自行添加';
      emptyAction = writable ? { label: '添加订阅源', run: () => s.readerOpenSource() } : null;
    } else {
      emptyMsg = '这个频道还没有内容';
      emptyAction = writable ? { label: '重新抓取', run: () => s.refresh() } : null;
    }
  }

  const onSearchInput = (ev: ReactSyntheticEvent<HTMLInputElement>) => {
    const v = ev.currentTarget.value;
    const box = searchRef.current;
    if (box) box.dataset.hasval = v ? '1' : '';
    setQDraft(v);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (s.readerSearch) s.readerSearch(v.trim());
    }, 300);
  };
  const onSearchClear = () => {
    if (searchRef.current) {
      searchRef.current.value = '';
      searchRef.current.dataset.hasval = '';
    }
    setQDraft('');
    if (s.readerSearch) s.readerSearch('');
    bump((x) => x + 1);
  };
  const onSearchKey = (ev: ReactKeyboardEvent<HTMLInputElement>) => {
    if (ev.key === 'Enter') {
      clearTimeout(debounceRef.current);
      if (s.readerSearch) s.readerSearch(String((ev.target as HTMLInputElement).value).trim());
    }
    if (ev.key === 'Escape') {
      ev.stopPropagation();
      if (qDraft) onSearchClear();
      setSearchOpen(false);
      const toggle = document.querySelector<HTMLElement>('.reader-search-toggle');
      if (toggle && toggle.focus) toggle.focus();
    }
  };
  const toggleSearch = () => {
    if (!searchOpen) {
      setSearchOpen(true);
      return;
    }
    if (qDraft || q) onSearchClear();
    setSearchOpen(false);
  };

  // 侧栏回调稳定化（memo 的前提是 props 引用稳定）
  const cbScope = useCallback((k: ReaderScope) => S().readerSetScope(k), []);
  const cbFeed = useCallback((id: EntityId | null) => S().readerSetFeed(id), []);
  const cbGroup = useCallback((g: string) => S().readerSetGroup(g), []);
  const cbFold = useCallback((g: string) => S().readerToggleGroupCollapse(g), []);
  const cbWatch = useCallback((k: WatchFilter) => S().readerSetWatch(k), []);
  const cbAdd = useCallback(() => S().readerOpenSource(), []);

  // 列表项回调稳定化（memo 的前提是 props 引用稳定）
  const onUnreadArt = useCallback((id: EntityId) => {
    const c = S();
    if (c.readerMarkUnread) c.readerMarkUnread(id);
  }, []);
  const onRetryBodyArt = useCallback((id: EntityId) => {
    const c = S();
    if (c.readerRetryBody) c.readerRetryBody(id);
  }, []);
  const onTagArt = useCallback((t: string) => {
    const c = S();
    if (c.readerSetTag) c.readerSetTag(t, false);
  }, []);
  const onAiTagArt = useCallback((t: string) => {
    const c = S();
    if (c.readerSetTag) c.readerSetTag(t, true);
  }, []);

  return {
    s,
    st,
    feeds,
    entries,
    flags,
    expanded,
    bodyMap,
    bodyErrSet,
    accordionOn,
    flashId,
    searchOpen,
    title,
    hasUnread,
    anyExpanded,
    q,
    qDraft,
    firstLoad,
    emptyMsg,
    emptyAction,
    searchRef,
    searchName,
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
    onUnreadArt,
    onRetryBodyArt,
    onTagArt,
    onAiTagArt,
    comfortable,
  };
}
