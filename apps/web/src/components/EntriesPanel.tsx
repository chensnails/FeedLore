import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { EntriesListQuery } from '@feedlore/client';
import type { ReadAllBody } from '@feedlore/contract';
import { api } from '../lib/api';
import { flattenEntries, qk } from '../lib/query';
import { useReadAll, useSaveLayout, useSetFavorite, useSetRead } from '../lib/mutations';
import { useAutoRefresh } from '../lib/useAutoRefresh';
import { useUi, type ListFilter, type ListSort, type ListView } from '../store/ui';
import { Thumb } from './Thumb';
import { Icon } from './Icon';

/**
 * 条目列表。筛选条件全部来自 store（频道 / 分组 / 筛选档 / 排序 / 标签 / 搜索词），
 * 不额外存派生数据：`queryKey` 带上这几个维度，换条件就是一次正常的缓存命中/重取。
 *
 * 写操作全部走 `lib/mutations`（乐观更新 + 失败回滚），组件只负责「点了要发生什么」。
 *
 * 工具栏 DOM 顺序是 v1 定下的铁律：**频道 → 标题 → [排序 → 视图 → 搜索]**。
 * v2 的频道切换在侧栏，所以这条在列表里表现为「范围标题 → 排序 → 视图 → 搜索」；
 * 搜索**永远在最右**，因为它是唯一会把结果集换成另一批东西的控件。
 */

const FILTERS: ReadonlyArray<readonly [ListFilter, string]> = [
  ['all', '全部'],
  ['unread', '未读'],
  ['favorite', '收藏'],
  ['watch', '关注'],
  ['block', '屏蔽'],
];

const SORTS: ReadonlyArray<readonly [ListSort, string]> = [
  ['new', '新→旧'],
  ['old', '旧→新'],
  ['name', '按名称'],
];

const PAGE_SIZE = 30;

export function EntriesPanel() {
  const feedId = useUi((s) => s.feedId);
  const groupName = useUi((s) => s.groupName);
  const setGroupName = useUi((s) => s.setGroupName);
  const filter = useUi((s) => s.filter);
  const setFilter = useUi((s) => s.setFilter);
  const sort = useUi((s) => s.sort);
  const setSort = useUi((s) => s.setSort);
  const view = useUi((s) => s.view);
  const setView = useUi((s) => s.setView);
  const tag = useUi((s) => s.tag);
  const setTag = useUi((s) => s.setTag);
  const openEntry = useUi((s) => s.openEntry);
  const search = useUi((s) => s.search);
  const setSearch = useUi((s) => s.setSearch);

  const setRead = useSetRead();
  const setFavorite = useSetFavorite();
  const readAll = useReadAll();
  const saveLayout = useSaveLayout();

  /* 搜索框是**受控 + 本地 state**，不是直接绑 store：
   * 每敲一个字都写 store 会让列表请求跟着抖 5 次（还每次都是一个完整的 ilike 查询）。
   * 300ms 防抖后再写，顺带把「敲了空格但没输内容」的空搜索挡掉。 */
  const [kw, setKw] = useState(search);
  useEffect(() => {
    const t = setTimeout(() => setSearch(kw.trim()), 300);
    return () => clearTimeout(t);
  }, [kw, setSearch]);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // 频道列表已在缓存里（侧栏取过），这里只读不额外请求：算作用范围 + 显示当前频道名
  const feedsQuery = useQuery({
    queryKey: qk.feeds,
    queryFn: () => api.feeds.list(),
    staleTime: 60_000,
  });

  /* 「只看这一组」不走新接口：把组内频道的 id 拼成 `feeds` 参数即可，
   * 服务端早就支持多 id（parseFeedIds 逗号分隔）。少一个接口就少一处两边口径不一致。
   *
   * ⚠️ 组内 0 个频道时**不能**退回「全部频道」：接口把空串当成「没有范围」，
   * 用户会看到「组：技术」配着全站列表，而这种错误看起来完全像功能正常。 */
  const groupFeedIds = useMemo(() => {
    if (!groupName) return null;
    return (feedsQuery.data?.feeds ?? [])
      .filter((f) => (f.groupName || '') === groupName)
      .map((f) => Number(f.id));
  }, [groupName, feedsQuery.data]);

  const groupReady = !groupName || (groupFeedIds !== null && groupFeedIds.length > 0);

  // hc 的 query 类型只接受字符串（URL 查询串的真实形态），数字要在服务端 coerce
  const query: EntriesListQuery = {
    limit: String(PAGE_SIZE),
    ...(feedId ? { feeds: feedId } : groupFeedIds && groupFeedIds.length ? { feeds: groupFeedIds.join(',') } : {}),
    ...(filter === 'unread' ? { unread: '1' as const } : {}),
    ...(filter === 'favorite' ? { fav: '1' as const } : {}),
    ...(filter === 'watch' ? { watch: 'watch' as const } : {}),
    ...(filter === 'block' ? { watch: 'block' as const } : {}),
    ...(tag ? { tag } : {}),
    ...(sort !== 'new' ? { sort } : {}),
    ...(search ? { q: search } : {}),
  };

  /* 查询键单独抽出来：自动刷新要靠它判断「浮标属于哪一批结果」，
   * 换条件后不清掉就会留着一个指向旧范围的「N 条新内容」。 */
  const entriesKey = [...qk.entries, feedId, groupName, filter, sort, tag, search] as const;

  /* 无限滚动。`hasMore` 由服务端「多取一条」判断，这里只管「还能不能再要一页」。 */
  const {
    data,
    isError,
    error,
    refetch,
    isFetching,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
  } = useInfiniteQuery({
    queryKey: entriesKey,
    queryFn: ({ pageParam }) => api.entries.list({ ...query, offset: String(pageParam) }),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.hasMore ? last.offset + last.limit : undefined),
    /* ⚠️ 必须保留上一批结果。没有它，每换一次 queryKey（敲搜索词、切频道、切排序）
     * 都会进入 isPending，而下面的 early return 会把**整个 main 连同搜索框**
     * 换成「加载条目…」—— 输入框被卸载，用户敲第二个字就丢焦点，
     * 这是只有真机连着打字才会发现的塌法。 */
    placeholderData: keepPreviousData,
    /* 分组还没解析出频道 id 时不发请求：否则会先按「全部频道」取一页，
     * 再把「组」的筛选结果顶上来，闪一下而且多半是错的那一屏。 */
    enabled: groupReady,
  });

  const entries = useMemo(() => flattenEntries(data), [data]);
  // 分页信封上的元信息（总数/标签/limit）以第一页为准，后面几页都是同一批的切片
  const head = data?.pages[0];

  /* 页面自动刷新。间隔来自 `settings.source.autoRefreshMinutes`（管理员在采集参数里改），
   * 0 = 关闭。收藏视图、搜索态与分组未就绪时跳过（见 useAutoRefresh 的注释）。 */
  const auto = useAutoRefresh({
    query,
    queryKey: entriesKey,
    minutes: feedsQuery.data?.autoRefreshMinutes ?? 0,
    headIds: entries.slice(0, PAGE_SIZE).map((e) => e.id),
    skip: filter === 'favorite' || Boolean(search) || !groupReady,
  });

  /* 滚动到底自动加载。
   *
   * ⚠️ `root` **必须显式指向 .list**：滚动发生在 .list 内部（`overflow:auto`），
   * 不传 root 时 IO 拿 viewport 判定，而 .list 里的元素从视口看从来没离开过，
   * 于是「到底了」永远判不出来 —— v1 就是踩这个坑才有一版加载更多完全失效。
   *
   * 依赖里带 `entries.length` 与 `isFetchingNextPage` 是必须的：内容不满一屏时
   * sentinel 一开始就在视口里，IO 只会在 observe 的当下回调一次；加载完一页后
   * 它仍在视口里、状态没变化，不会再有回调。重跑 effect = 重新 observe = 再回调一次，
   * 这样「一屏还没填满」才可能连续翻几页直到填满或没有更多。 */
  const fetchingRef = useRef(false);
  fetchingRef.current = isFetchingNextPage;
  useEffect(() => {
    const root = listRef.current;
    const el = sentinelRef.current;
    if (!root || !el || !hasNextPage) return undefined;
    const io = new IntersectionObserver(
      (rows) => {
        if (!rows.some((r) => r.isIntersecting)) return;
        if (fetchingRef.current) return;
        void fetchNextPage();
      },
      { root, rootMargin: '480px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, fetchNextPage, entries.length, isFetchingNextPage]);

  /* 判据是「有没有数据」而不是 isPending：留着上一次结果时 isPending 也是 true，
   * 那时不该把界面掀掉重画。 */
  if (!data) {
    if (!groupReady) {
      /* 两种「没数据」不能混：频道列表还没回来时只是等待，回来后组里真的没频道才是空。
       * 混成一句「这个分组里还没有频道」，会在每次刷新时先闪一句假的空态。 */
      if (feedsQuery.isPending) {
        return (
          <main className="list" ref={listRef as React.RefObject<HTMLElement>}>
            <p className="hint">加载条目…</p>
          </main>
        );
      }
      return (
        <main className="list" ref={listRef as React.RefObject<HTMLElement>}>
          <div className="panel">
            <p>分组「{groupName}」里还没有频道。</p>
            <button className="btn" onClick={() => setGroupName(null)}>看全部频道</button>
          </div>
        </main>
      );
    }
    if (isError) {
      return (
        <main className="list" ref={listRef as React.RefObject<HTMLElement>}>
          <div className="panel error">
            <p>条目加载失败：{error instanceof Error ? error.message : '未知错误'}</p>
            <button className="btn" onClick={() => void refetch()}>重试</button>
          </div>
        </main>
      );
    }
    return (
      <main className="list" ref={listRef as React.RefObject<HTMLElement>}>
        <p className="hint">加载条目…</p>
      </main>
    );
  }

  /** 点开即已读：先打开阅读层（不等请求），已读标记并行发出。 */
  function open(e: { id: string; isRead: boolean }): void {
    openEntry(e.id);
    if (!e.isRead) setRead.mutate({ id: e.id, isRead: true });
  }

  /* 「全部已读」的作用范围必须与「屏幕上看到的」一致：
   * - 选中某频道 → 只标这个频道；选中某分组 → 只标这个分组；
   *   全部频道 → 只标卡片开关打开的频道（列表默认 scope=cards 的同批）。
   * - 筛选档、标签、搜索词一并带上。少带任何一个，都会把用户没看见的条目一起标掉 ——
   *   这是最容易让人恼火的误操作。 */
  const targetFeeds = feedId
    ? [Number(feedId)]
    : groupFeedIds && groupFeedIds.length
      ? groupFeedIds
      : (feedsQuery.data?.feeds.filter((f) => f.cardEnabled).map((f) => Number(f.id)) ?? []);

  const unreadVisible = entries.filter((e) => !e.isRead).length;

  const feedName = feedId
    ? (feedsQuery.data?.feeds.find((f) => f.id === feedId)?.title ?? '频道')
    : '全部频道';
  const filterName = FILTERS.find(([v]) => v === filter)?.[1] ?? '全部';

  /** 改视图/排序：本地立刻生效，异步写服务端（换设备还是这个样子）。 */
  function pickView(v: ListView): void {
    if (v === view) return;
    setView(v);
    saveLayout.mutate({ view: v });
  }
  function pickSort(v: ListSort): void {
    if (v === sort) return;
    setSort(v);
    saveLayout.mutate({ sort: v });
  }

  return (
    <main className="list" ref={listRef as React.RefObject<HTMLElement>}>
      {/* 「N 条新内容」浮标。只在**已经滚下去**时才出现（在顶部时探测会直接套用，
          不打扰）。点一下才把新内容换上来 —— 列表在眼皮底下自己位移是最难受的交互。 */}
      {auto.fresh && (
        <div className="fresh-pill" role="status">
          <button className="fresh-go" onClick={auto.apply} title="加载新内容并回到顶部">
            <Icon name="arrow-up" size={13} />
            {auto.fresh.n} 条新内容
          </button>
          <button className="fresh-x" aria-label="忽略这批新内容" title="忽略" onClick={auto.dismiss}>
            <Icon name="close" size={12} />
          </button>
        </div>
      )}

      <div className="list-head">
        <div className="list-scope">
          <h1 className="list-title" title={`${groupName ? `组：${groupName}` : feedName} · ${filterName}`}>
            {/* 文字单独一层做省略号：✕ 挂在 h1 里，如果省略号写在 h1 上，
                标题一长会把按钮一起裁掉（用户就看不出自己在筛选分组了）。 */}
            <span className="list-title-text">
              {groupName ? `组：${groupName}` : feedName}
              {filter !== 'all' && <em>{filterName}</em>}
              {tag && <em>#{tag}</em>}
            </span>
            {/* 分组范围要能一键退出：它没有「全部」那一行可以点回去 */}
            {groupName && (
              <button
                className="scope-x"
                title="取消分组筛选，看全部频道"
                aria-label="取消分组筛选"
                onClick={() => setGroupName(null)}
              >
                <Icon name="close" size={12} />
              </button>
            )}
          </h1>
          <span className="list-count">
            {head?.total ?? 0} 条{isFetching && !isFetchingNextPage ? ' · 更新中…' : ''}
            {unreadVisible > 0 && (
              <em className="inline-unread">已加载 {unreadVisible} 条未读</em>
            )}
          </span>
        </div>

        <div className="list-actions">
          {/* 排序 → 视图 → 搜索：这个顺序在 v1 就固定了，改顺序会让用惯的人每次都点错 */}
          <select
            className="input sm sort-select"
            aria-label="排序"
            value={sort}
            onChange={(e) => pickSort(e.target.value as ListSort)}
          >
            {SORTS.map(([v, label]) => (
              <option key={v} value={v}>{label}</option>
            ))}
          </select>

          <span className="seg" role="group" aria-label="视图">
            <button
              className={`seg-btn${view === 'grid' ? ' on' : ''}`}
              aria-pressed={view === 'grid'}
              title="网格视图"
              onClick={() => pickView('grid')}
            >
              <Icon name="grid" size={15} />
            </button>
            <button
              className={`seg-btn${view === 'list' ? ' on' : ''}`}
              aria-pressed={view === 'list'}
              title="列表视图"
              onClick={() => pickView('list')}
            >
              <Icon name="list" size={15} />
            </button>
          </span>

          <span className="search-box">
            <Icon name="search" size={14} className="search-ico" />
            <input
              ref={inputRef}
              className="input sm search-input"
              type="search"
              value={kw}
              placeholder="搜索标题、正文、标签…"
              aria-label="搜索条目"
              onChange={(e) => setKw(e.target.value)}
              onKeyDown={(e) => {
                // 回车立即生效，不用等防抖（搜完就走的场景很常见）
                if (e.key === 'Enter') setSearch(kw.trim());
                if (e.key === 'Escape') {
                  setKw('');
                  setSearch('');
                }
              }}
            />
            {kw && (
              <button
                className="search-clear"
                aria-label="清空搜索"
                title="清空搜索"
                onClick={() => {
                  setKw('');
                  setSearch('');
                  inputRef.current?.focus();
                }}
              >
                <Icon name="close" size={12} />
              </button>
            )}
          </span>
        </div>
      </div>

      {/* 「全部已读」：作用范围 = 当前可见列表（频道/分组/筛选/标签/搜索），
          和排序/视图不是一类，单独一行右对齐。筛选档已挪到左侧频道栏的「全局视图」。 */}
      <div className="filter-row">
        <button
          className="btn ghost sm"
          disabled={readAll.isPending || (head?.total ?? 0) === 0}
          /* 搜索态必须把 q 一起带上：不带就变成「把范围内所有未读都标掉」，
           * 而用户看到的只是搜索结果那几条。筛选档与标签同理。 */
          onClick={() => {
            const body: ReadAllBody = {
              feeds: targetFeeds,
              ...(search ? { q: search } : {}),
              ...(tag ? { tag } : {}),
              ...(filter === 'favorite' ? { fav: '1' as const } : {}),
              ...(filter === 'watch' || filter === 'block' ? { watch: filter } : {}),
            };
            readAll.mutate(body);
          }}
          title="把当前范围内的未读全部标为已读"
        >
          {readAll.isPending ? (
            '处理中…'
          ) : (
            <>
              <Icon name="check-all" size={14} />
              全部已读
            </>
          )}
        </button>
      </div>

      {/* 标签云：点一下就是按标签筛。标签是「条目自带的分类」，比关键词搜索更准确 */}
      {(head?.tags.length ?? 0) > 0 && (
        <div className="tag-bar">
          {head?.tags.slice(0, 14).map((t) => (
            <button
              key={t.tag}
              className={`tag tag-btn${tag === t.tag ? ' on' : ''}`}
              aria-pressed={tag === t.tag}
              title={tag === t.tag ? '取消标签筛选' : `只看 #${t.tag}`}
              onClick={() => setTag(tag === t.tag ? null : t.tag)}
            >
              {t.tag} <b>{t.n}</b>
            </button>
          ))}
          {tag && (
            <button className="tag tag-btn clear" onClick={() => setTag(null)}>
              清除标签
              <Icon name="close" size={11} />
            </button>
          )}
        </div>
      )}

      <ul className={`cards ${view === 'list' ? 'list-mode' : 'grid-mode'}`}>
        {entries.map((e) => (
          <li key={e.id} className={`card-row${e.isRead ? ' read' : ''}`}>
            <button className="card" onClick={() => open(e)}>
              {/* 封面：服务端已把外链改写成本站代理，这里只负责展示与失败降级 */}
              <Thumb src={e.image} className="card-thumb" decorative />
              <div className="card-body">
                <p className="card-title">{e.name}</p>
                {e.desc && <p className="card-desc">{e.desc}</p>}
                <p className="card-meta">
                  <span>{e.feedName}</span>
                  {e.date && <span>{fmtDate(e.date)}</span>}
                  {e.isFavorite && (
                    <span className="fav" title="已收藏">
                      <Icon name="star-filled" size={12} />
                    </span>
                  )}
                  {e.tags.slice(0, 3).map((t) => (
                    <span key={t} className="tag">{t}</span>
                  ))}
                </p>
              </div>
            </button>
            <button
              className={`fav-btn${e.isFavorite ? ' on' : ''}`}
              aria-label={e.isFavorite ? '取消收藏' : '收藏'}
              title={e.isFavorite ? '取消收藏' : '收藏'}
              onClick={() => setFavorite.mutate({ id: e.id, isFavorite: !e.isFavorite })}
            >
              <Icon name={e.isFavorite ? 'star-filled' : 'star'} size={15} />
            </button>
          </li>
        ))}
      </ul>

      {entries.length === 0 && <p className="hint">{emptyText(search, tag, filter, groupName)}</p>}

      {/* 滚动哨兵与加载状态。有更多时放哨兵（IO 靠它触发），没有更多时说清
          「到底了」—— 无限滚动最怕的是用户不知道是真的没有还是卡住了。 */}
      {hasNextPage ? (
        <div ref={sentinelRef} className="list-sentinel">
          {isFetchingNextPage ? <span className="hint">加载更多…</span> : null}
        </div>
      ) : (
        entries.length > 0 && <p className="hint list-end">共 {head?.total ?? entries.length} 条，已全部加载</p>
      )}
    </main>
  );
}

/**
 * 空态文案必须说清「为什么空」。
 * 统一一句「这里还没有条目」会把「搜错了词」和「这个频道真的没内容」混成同一件事，
 * 前者用户会以为抓取坏了，后者用户会以为搜索坏了。
 */
function emptyText(search: string, tag: string | null, filter: ListFilter, groupName: string | null): string {
  if (search) return `没有匹配「${search}」的条目。`;
  if (tag) return `没有带 #${tag} 的条目。`;
  if (filter === 'unread') return '这个范围内没有未读条目。';
  if (filter === 'favorite') return '还没有收藏过条目。';
  if (filter === 'watch') return '没有命中关注规则的条目。';
  if (filter === 'block') return '没有命中屏蔽规则的条目。';
  if (groupName) return `分组「${groupName}」里还没有条目。`;
  return '这里还没有条目。';
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
