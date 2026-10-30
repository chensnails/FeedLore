import { useQuery } from '@tanstack/react-query';
import { useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { api } from '../lib/api';
import { qk } from '../lib/query';
import {
  useCreateFeed,
  useDeleteFeed,
  useExportOpml,
  useImportOpml,
  usePatchFeed,
  useRefreshFeed,
  useReorderFeeds,
  useSaveLayout,
  useSavePrefs,
} from '../lib/mutations';
import { useUi, type ListFilter } from '../store/ui';
import type { Feed } from '../lib/types';
import { Thumb } from './Thumb';

/**
 * 左侧频道栏。
 *
 * 结构（对齐 v1 的 ChannelList「全局视图」思路）：
 *   搜索框
 *   全局视图：全部频道 / 未读 / 收藏 / 关注   ← 系统级范围，跨所有订阅
 *   分隔线
 *   分组折叠列表（订阅源）
 *   分隔线
 *   屏蔽（置底，v1 也是这样与「关注」分开收纳）
 *   添加频道
 *
 * 三个纪律（与 v1 一致）：
 * 1. **分组是折叠的，不是筛选的**——折叠列表一次能扫完全部分组与未读。
 * 2. 折叠状态存服务端 `layout.collapsedGroups`（换设备还是收着的）。
 * 3. 频道多了要能搜：超过二三十个源就必须有，这是频道栏唯一随规模退化的能力。
 *
 * 「全局视图」四档（未读/收藏/关注/屏蔽）是从 v2 早期「列表工具条的筛选档」挪回来的：
 * 它们本质是**全局范围**，放在频道栏顶部（参照 v1 的 scope 行）比塞在列表里更说得通——
 * 用户点「未读」时想看的是「全站未读」，而不是「当前频道里的未读」的子集。
 * 选中的频道 / 分组要跨视图（列表/阅读）共享，才进 zustand；折叠、搜索、分组内筛选是
 * 纯显示状态，留组件里 / 服务端偏好里，不进 store。
 */
export function FeedsPanel() {
  const feedId = useUi((s) => s.feedId);
  const setFeedId = useUi((s) => s.setFeedId);
  const navOpen = useUi((s) => s.navOpen);
  const closeNav = useUi((s) => s.closeNav);
  const askConfirm = useUi((s) => s.askConfirm);
  /* 组件里已经有一个同名 state（新增频道时填的分组名），所以 store 的那个
   * 在本地叫 focusGroup，避免「同一个名字两个东西」这种最容易看错的写法。 */
  const focusGroup = useUi((s) => s.groupName);
  const setFocusGroup = useUi((s) => s.setGroupName);
  /* 全局视图的激活态也来自 store：点「未读」清掉频道/分组/标签并设 filter，
   * 与列表工具条里的筛选档共用同一份状态（route 同步、深链都不变）。 */
  const filter = useUi((s) => s.filter);
  const setFilter = useUi((s) => s.setFilter);
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState('');
  const [groupName, setGroupName] = useState('');
  const [ql, setQl] = useState('');

  const createFeed = useCreateFeed();
  const patchFeed = usePatchFeed();
  const deleteFeed = useDeleteFeed();
  const refreshFeed = useRefreshFeed();
  const importOpml = useImportOpml();
  const exportOpml = useExportOpml();
  const reorder = useReorderFeeds();
  const saveLayout = useSaveLayout();
  const savePrefs = useSavePrefs();
  const fileRef = useRef<HTMLInputElement>(null);

  /* ---------------- 排序 / 分组改名 / 分组排序 ----------------
   *
   * 这三件事在 v1 的「数据源」设置页里都有，迁到 v2 时端点搬了、界面没搬。
   *
   * ⚠️ 服务端 reorder 一次写两列（sort_order + group_name），所以拖拽与改名共用
   * 同一条提交路径。而它对 groupName 的处理是 `String(raw ?? '').trim() || null` ——
   * **少传一个字段等于把那个频道踢出分组**（undefined → null）。因此每次提交都必须
   * 把每个频道自己的分组名一起带上，不能只传被拖动的那一个。
   */
  const [dragId, setDragId] = useState<string | null>(null);
  const [localOrder, setLocalOrder] = useState<string[] | null>(null);
  const [renaming, setRenaming] = useState<{ from: string; to: string } | null>(null);
  /** 重排后要把焦点还给刚移动的那一行：拖拽/键盘都会触发整表重渲染，焦点会掉到 body */
  const focusAfter = useRef<string | null>(null);

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: qk.feeds,
    queryFn: () => api.feeds.list(),
  });

  /* 折叠集合以服务端 `layout.collapsedGroups` 为准，但**本地要能立刻响应**：
   * 点一下等一次请求回来才收起，手感会像卡了。所以先写本地、再异步写服务端。
   * 失败只提示不回滚 —— 视觉状态本来就能重新点回去，强行弹回更让人误会。 */
  const prefsQuery = useQuery({
    queryKey: qk.prefs,
    queryFn: () => api.prefs.get(),
    staleTime: 5 * 60_000,
  });
  const [collapsed, setCollapsed] = useState<Set<string> | null>(null);
  const collapsedSet = collapsed ?? new Set(prefsQuery.data?.layout.collapsedGroups ?? []);

  function toggleGroup(name: string): void {
    const next = new Set(collapsedSet);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setCollapsed(next);
    saveLayout.mutate({ collapsedGroups: [...next] });
  }

  /**
   * 读本地 OPML 并上传。
   *
   * 三个细节：
   * 1. **先把 `input.value` 清空**：不清的话「再选同一个文件」不会触发 change，
   *    用户会以为按钮坏了（这是 file input 的经典坑）。
   * 2. 前端只做大小护栏（2MB），XML 结构与 URL 合法性交给服务端 —— 那边本来就要过
   *    `assertFeedUrl`，前端再解析一遍等于两套规则。
   * 3. 失败不在这里报：mutation 的 onError 统一走 toast，避免两处提示打架。
   */
  async function onPickOpml(e: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      useUi.getState().notify('OPML 文件过大（上限 2MB）', 'error');
      return;
    }
    const text = await file.text();
    if (!text.trim()) {
      useUi.getState().notify('这个文件是空的', 'error');
      return;
    }
    importOpml.mutate(text);
  }

  /* 窄屏时侧栏是抽屉（position: fixed + translateX），靠这个 class 展开；
   * 桌面端 `.sidebar.open` 没有任何规则，等于无事发生 —— 不用判断视口宽度，
   * 也就不会出现「JS 认窄屏、CSS 认桌面」的错位。 */
  const sidebarClass = `sidebar${navOpen ? ' open' : ''}`;

  /** 分组 → 频道。未分组的排最后（v1 同序：分组按 groupOrder，未分组垫底）。 */
  const grouped = useMemo(() => {
    if (!data) return [];
    const kw = ql.trim().toLowerCase();
    const match = (f: Feed) => !kw || f.title.toLowerCase().includes(kw) || f.url.toLowerCase().includes(kw);
    const saved = data.groupOrder.length ? data.groupOrder : data.groups;
    // 本地刚调过分组顺序时以本地为准（等一次往返再变，手感会像卡了）
    const order = localOrder ?? saved;
    const out: Array<{ name: string; feeds: Feed[] }> = [];
    for (const g of order) {
      if (!g) continue; // '' 是未分组，单独处理
      const feeds = data.feeds.filter((f) => (f.groupName || '') === g && match(f));
      if (feeds.length) out.push({ name: g, feeds });
    }
    // 未分组（groupName 为空）与「groupOrder 里没登记的分组」都落这里
    const known = new Set(order);
    const rest = data.feeds.filter((f) => !f.groupName || !known.has(f.groupName)).filter(match);
    if (rest.length) out.push({ name: '', feeds: rest });
    return out;
  }, [data, ql, localOrder]);

  if (isPending) {
    return (
      <aside className={sidebarClass}>
        <p className="hint">加载频道…</p>
      </aside>
    );
  }
  if (isError) {
    return (
      <aside className={sidebarClass}>
        <p className="hint">频道加载失败：{error instanceof Error ? error.message : '未知错误'}</p>
        <button className="btn" onClick={() => void refetch()}>
          重试
        </button>
      </aside>
    );
  }

  function submit(e: FormEvent): void {
    e.preventDefault();
    const u = url.trim();
    if (!u) return;
    createFeed.mutate(
      { url: u, ...(groupName.trim() ? { groupName: groupName.trim() } : {}) },
      {
        onSuccess: () => {
          setUrl('');
          setGroupName('');
          setAdding(false);
        },
      },
    );
  }

  async function remove(f: Feed): Promise<void> {
    /* 破坏性操作，且服务端会级联删掉该频道的全部条目 —— 必须让用户明确确认。
     * 用应用内确认框而不是 window.confirm：后者同步阻塞主线程，删除期间按钮
     * 想进 pending 都进不去；移动端还会被浏览器接管成不可控样式。 */
    const ok = await askConfirm({
      title: `删除「${f.title}」？`,
      body: `该频道的 ${f.entryCount} 条记录会一起删除，不可恢复。`,
      okText: '删除',
      danger: true,
    });
    if (!ok) return;
    deleteFeed.mutate(f.id);
  }

  /* ---------------- 排序 / 分组 ----------------
   *
   * 三条纪律：
   * 1. **搜索态一律禁排**：此时 `grouped` 只含匹配项，照着它写回顺序会把没匹配到的
   *    频道挤到一起（用户搜了个「少数派」，回来发现别的频道顺序全变了）。
   * 2. **跨组拖拽不接**：改分组归属是另一件事，误拖一次就把频道搬走了。
   * 3. 每次提交都带全量顺序（服务端整批重写 sort_order），不做增量。
   */
  const canSort = !ql.trim();
  const groupOrder = localOrder ?? (data.groupOrder.length ? data.groupOrder : data.groups);

  function pushOrder(next: Array<{ name: string; feeds: Feed[] }>): void {
    const items: Array<{ id: number; sortOrder: number; groupName: string }> = [];
    for (const g of next) {
      for (const f of g.feeds) {
        // groupName 必须带：服务端把 undefined 归一成 null（= 未分组），漏传等于踢出分组
        items.push({ id: Number(f.id), sortOrder: items.length * 10, groupName: g.name });
      }
    }
    const keep = focusAfter.current;
    focusAfter.current = null;
    reorder.mutate(
      { feeds: items },
      {
        onSettled: () => {
          if (!keep) return;
          // 整表重渲染后焦点掉到 body，把焦点还回刚移动的那一行（键盘连续移动靠它）
          window.setTimeout(() => {
            document.querySelector<HTMLElement>(`[data-fid="${keep}"] .feed`)?.focus();
          }, 60);
        },
      },
    );
  }

  /** 组内上下移一格（键盘 Alt+↑/↓ 与拖拽共用这套重排逻辑）。 */
  function moveFeed(group: string, id: string, delta: number): void {
    if (!canSort) return;
    const next = grouped.map((g) => ({ name: g.name, feeds: [...g.feeds] }));
    const g = next.find((x) => x.name === group);
    if (!g) return;
    const i = g.feeds.findIndex((f) => f.id === id);
    const j = i + delta;
    const a = g.feeds[i];
    const b = g.feeds[j];
    if (!a || !b) return;
    g.feeds[i] = b;
    g.feeds[j] = a;
    focusAfter.current = id;
    pushOrder(next);
  }

  function dropOn(group: string, targetId: string): void {
    const id = dragId;
    setDragId(null);
    if (!id || id === targetId || !canSort) return;
    const next = grouped.map((g) => ({ name: g.name, feeds: [...g.feeds] }));
    const g = next.find((x) => x.name === group);
    if (!g) return;
    const from = g.feeds.findIndex((f) => f.id === id);
    const to = g.feeds.findIndex((f) => f.id === targetId);
    if (from < 0 || to < 0) return; // 跨组：忽略
    const [moved] = g.feeds.splice(from, 1);
    if (!moved) return;
    g.feeds.splice(to, 0, moved);
    focusAfter.current = id;
    pushOrder(next);
  }

  /** 分组上下移：只调 `layout.groupOrder`，不动频道本身。 */
  function moveGroup(name: string, delta: number): void {
    const names = grouped.map((g) => g.name).filter((n) => n !== '');
    const i = names.indexOf(name);
    const j = i + delta;
    const a = names[i];
    const b = names[j];
    if (!a || !b) return;
    names[i] = b;
    names[j] = a;
    setLocalOrder(names);
    savePrefs.mutate({ groupOrder: names });
  }

  /**
   * 分组改名 = 把这一组所有频道的 group_name 一起换掉（服务端一次 UPDATE 完成）。
   *
   * ⚠️ 同时要改 `layout.groupOrder` 里的旧名：不改的话顺序表里留着一个已不存在的分组名，
   * 而新名字没登记，下次渲染顺序看起来像随机的。
   */
  function commitRename(from: string, to: string): void {
    const name = to.trim().slice(0, 40);
    if (!name || name === from) {
      setRenaming(null);
      return;
    }
    if (grouped.some((g) => g.name === name)) {
      useUi.getState().notify(`已经有叫「${name}」的分组了`, 'error');
      return;
    }
    pushOrder(grouped.map((g) => ({ name: g.name === from ? name : g.name, feeds: g.feeds })));
    const order = groupOrder.map((n) => (n === from ? name : n));
    setLocalOrder(order);
    savePrefs.mutate({ groupOrder: order });
    setRenaming(null);
  }

  /* 全局视图：系统级范围，跨所有订阅。激活态 = 没选具体频道/分组 且 filter 命中。
   * 点一下清掉 feedId/group/tag（setFeedId(null) 顺手清了这两个），再设 filter——
   * 与 v1 的 onScope 语义一致：选「未读」看的是全站未读，不是当前频道的子集。 */
  const isGlobal = feedId === null && focusGroup === null;
  const scopeActive = (k: ListFilter): boolean => isGlobal && filter === k;
  function pickScope(k: ListFilter): void {
    setFeedId(null);
    setFilter(k);
  }

  const gviews: Array<{ key: ListFilter; name: string; n: number; icon: GIconName }> = [
    { key: 'all', name: '全部频道', n: data.flags.total, icon: 'all' },
    { key: 'unread', name: '未读', n: data.flags.unread, icon: 'unread' },
    { key: 'favorite', name: '收藏', n: data.flags.favorite, icon: 'favorite' },
    { key: 'watch', name: '关注', n: data.flags.watching, icon: 'watch' },
  ];

  return (
    <aside className={sidebarClass}>
      {/* 只在窄屏抽屉里出现（CSS 控制）：抽屉盖住列表时，给一个不用点遮罩的关闭路径 */}
      <div className="sidebar-head">
        <span>频道</span>
        <button className="btn ghost icon nav-close" aria-label="收起频道栏" onClick={closeNav}>
          ✕
        </button>
      </div>

      <div className="channel-search">
        <input
          className="input sm"
          type="search"
          value={ql}
          placeholder="筛选频道…"
          aria-label="筛选频道"
          onChange={(e) => setQl(e.target.value)}
        />
        {ql && (
          <button className="search-clear" aria-label="清空" title="清空" onClick={() => setQl('')}>
            ✕
          </button>
        )}
      </div>

      {/* 全局视图：系统级范围（未读/收藏/关注/全部）。参照 v1 ChannelList 的 scope 行，
          但用图标 chip + 计数徽标呈现，和下面的订阅源分组在视觉上明确分层。 */}
      <nav className="gviews" aria-label="全局视图">
        {gviews.map((g) => (
          <button
            key={g.key}
            className={`gview${scopeActive(g.key) ? ' on' : ''}`}
            aria-pressed={scopeActive(g.key)}
            onClick={() => pickScope(g.key)}
          >
            <span className="gview-ico">
              <GIcon name={g.icon} />
            </span>
            <span className="gview-name">{g.name}</span>
            {g.n > 0 && <span className="gview-n">{g.n}</span>}
          </button>
        ))}
      </nav>

      <div className="nav-sep" aria-hidden="true" />

      <ul className="feeds">
        {grouped.map((g) => {
          /* 未分组那一组不折叠：它没有名字，折叠起来就是一堆「▸ 未分组」，
           * 点开才知道里面有什么，还不如直接列出来。 */
          const foldable = g.name !== '';
          const isCollapsed = foldable && collapsedSet.has(g.name);
          const gUnread = g.feeds.reduce((n, f) => n + f.unreadCount, 0);
          return (
            <li key={g.name || '__ungrouped'} className="feed-group-wrap">
              {foldable &&
                (renaming?.from === g.name ? (
                  /* 内联改名而不是 window.prompt：prompt 在部分移动端浏览器被拦，
                   * 而且它会把整页的焦点偷走，回来时侧栏滚到哪儿都不一定。 */
                  <div className="feed-group-row editing">
                    <input
                      className="input sm"
                      autoFocus
                      maxLength={40}
                      value={renaming.to}
                      aria-label="分组名称"
                      onChange={(e) => setRenaming({ from: g.name, to: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename(g.name, renaming.to);
                        if (e.key === 'Escape') setRenaming(null);
                      }}
                      onBlur={() => commitRename(g.name, renaming.to)}
                    />
                  </div>
                ) : (
                  <div className={`feed-group-row${focusGroup === g.name ? ' on' : ''}`}>
                    <button
                      className={`feed-group${isCollapsed ? ' collapsed' : ''}`}
                      aria-expanded={!isCollapsed}
                      title={isCollapsed ? '展开分组' : '收起分组'}
                      onClick={() => toggleGroup(g.name)}
                    >
                      <span className="feed-group-caret" aria-hidden>▾</span>
                      <span className="feed-group-name">{g.name}</span>
                      {gUnread > 0 && <span className="feed-group-n">{gUnread}</span>}
                    </button>
                    <span className="feed-group-ops">
                      {/* 「只看这一组」。v1 是分组行上一个漏斗图标，和折叠共用一个语义 ——
                          用户分不清点下去是收起来还是筛出来。这里拆成两件事：
                          标题 = 折叠，◎ = 只看（按下态常显，再点一次取消）。 */}
                      <button
                        className={`icon-btn${focusGroup === g.name ? ' on' : ''}`}
                        title={focusGroup === g.name ? '取消只看这一组' : `只看「${g.name}」这一组`}
                        aria-label={focusGroup === g.name ? '取消只看这一组' : `只看「${g.name}」这一组`}
                        aria-pressed={focusGroup === g.name}
                        onClick={() => {
                          if (focusGroup === g.name) {
                            setFocusGroup(null);
                            return;
                          }
                          setFocusGroup(g.name);
                          // 收起状态下点了会「什么都没变」：先展开再筛
                          if (collapsedSet.has(g.name)) toggleGroup(g.name);
                        }}
                      >
                        ◎
                      </button>
                      <button
                        className="icon-btn"
                        title="重命名分组"
                        aria-label={`重命名分组 ${g.name}`}
                        onClick={() => setRenaming({ from: g.name, to: g.name })}
                      >
                        ✎
                      </button>
                      <button
                        className="icon-btn"
                        title="上移分组"
                        aria-label={`上移分组 ${g.name}`}
                        onClick={() => moveGroup(g.name, -1)}
                      >
                        ↑
                      </button>
                      <button
                        className="icon-btn"
                        title="下移分组"
                        aria-label={`下移分组 ${g.name}`}
                        onClick={() => moveGroup(g.name, 1)}
                      >
                        ↓
                      </button>
                    </span>
                  </div>
                ))}
              {!isCollapsed &&
                g.feeds.map((f) => (
                  <div
                    key={f.id}
                    className={`feed-row${dragId === f.id ? ' dragging' : ''}`}
                    data-fid={f.id}
                    /* 拖拽只在非搜索态开启：搜索时列表是筛选后的子集，照着它重排会打乱其余频道 */
                    draggable={canSort}
                    onDragStart={() => setDragId(f.id)}
                    onDragEnd={() => setDragId(null)}
                    onDragOver={(e) => {
                      if (dragId && canSort) e.preventDefault();
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      dropOn(g.name, f.id);
                    }}
                  >
                    <button
                      className={`feed${feedId === f.id ? ' on' : ''}${f.enabled ? '' : ' off'}`}
                      onClick={() => setFeedId(f.id)}
                      title={`${f.error ?? f.url}${canSort ? '\nAlt+↑/↓ 可调整顺序' : ''}`}
                      /* 键盘也能排：拖拽对只用键盘的人是死路，而这是纯视觉顺序的调整 */
                      onKeyDown={(e) => {
                        if (!e.altKey) return;
                        if (e.key === 'ArrowUp') {
                          e.preventDefault();
                          moveFeed(g.name, f.id, -1);
                        } else if (e.key === 'ArrowDown') {
                          e.preventDefault();
                          moveFeed(g.name, f.id, 1);
                        }
                      }}
                    >
                      <Thumb
                        src={f.icon}
                        className="feed-icon"
                        decorative
                        fallback={<LetterAvatar title={f.title} />}
                      />
                      <div className="feed-main">
                        <p className="feed-title">{f.title}</p>
                        <p className="feed-meta">
                          {f.cardEnabled ? '' : '卡片页隐藏 · '}
                          {f.error ? '抓取失败' : f.entryCount ? `${f.entryCount} 条` : '暂无条目'}
                        </p>
                      </div>
                      <span className="count">{f.unreadCount}</span>
                    </button>

                    <span className="feed-ops">
                      {/* 单频道刷新：看到「这个源没更新」时最先要按的按钮 */}
                      <button
                        className="icon-btn"
                        title="立即抓取这个频道"
                        aria-label="立即抓取这个频道"
                        disabled={refreshFeed.isPending}
                        onClick={() => refreshFeed.mutate(f.id)}
                      >
                        ⟳
                      </button>
                      {/* 采集开关：与「卡片页展示」是两件事——停采集不一定要隐藏卡片 */}
                      <button
                        className={`icon-btn${f.enabled ? '' : ' off'}`}
                        title={f.enabled ? '暂停采集' : '恢复采集'}
                        aria-label={f.enabled ? '暂停采集' : '恢复采集'}
                        disabled={patchFeed.isPending}
                        onClick={() => patchFeed.mutate({ id: f.id, patch: { enabled: !f.enabled } })}
                      >
                        {f.enabled ? '⏸' : '▶'}
                      </button>
                      <button
                        className={`icon-btn${f.cardEnabled ? '' : ' off'}`}
                        title={f.cardEnabled ? '在卡片页隐藏' : '在卡片页显示'}
                        aria-label={f.cardEnabled ? '在卡片页隐藏' : '在卡片页显示'}
                        disabled={patchFeed.isPending}
                        onClick={() => patchFeed.mutate({ id: f.id, patch: { cardEnabled: !f.cardEnabled } })}
                      >
                        {f.cardEnabled ? '▣' : '▢'}
                      </button>
                      <button
                        className="icon-btn danger"
                        title="删除频道"
                        aria-label="删除频道"
                        disabled={deleteFeed.isPending}
                        onClick={() => void remove(f)}
                      >
                        ✕
                      </button>
                    </span>
                  </div>
                ))}
            </li>
          );
        })}
      </ul>

      {grouped.length === 0 && (
        <p className="hint">{ql.trim() ? `没有匹配「${ql.trim()}」的频道。` : '还没有频道。'}</p>
      )}

      <div className="nav-sep" aria-hidden="true" />

      {/* 屏蔽：置底收纳，与「关注」分开是刻意的（v1 同款）—— 屏蔽是被规则挡住的内容，
          不该和正常入口混排。命中即已自动标为已读，这里只做「想看看挡了什么」的入口。 */}
      <nav className="gviews bottom" aria-label="系统视图">
        <button
          className={`gview${scopeActive('block') ? ' on' : ''}`}
          aria-pressed={scopeActive('block')}
          onClick={() => pickScope('block')}
        >
          <span className="gview-ico">
            <GIcon name="block" />
          </span>
          <span className="gview-name">屏蔽</span>
          {data.flags.blocked > 0 && <span className="gview-n">{data.flags.blocked}</span>}
        </button>
      </nav>

      <div className="add-feed">
        {adding ? (
          <form onSubmit={submit}>
            <input
              autoFocus
              className="input"
              type="url"
              placeholder="https://example.com/feed.xml"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
            />
            <input
              className="input"
              type="text"
              placeholder="分组（可选）"
              maxLength={40}
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
            />
            <div className="add-feed-actions">
              <button className="btn sm" type="submit" disabled={createFeed.isPending || !url.trim()}>
                {createFeed.isPending ? '添加中…' : '添加'}
              </button>
              <button
                className="btn ghost sm"
                type="button"
                onClick={() => {
                  setAdding(false);
                  setUrl('');
                  setGroupName('');
                }}
              >
                取消
              </button>
            </div>
            {/* 新增会立刻抓一次；源站报错时会把原因带回来，所以这里只需说明「会等一会儿」 */}
            <p className="hint tiny">添加后会立即抓取一次，源站较慢时可能需要几秒。</p>
          </form>
        ) : (
          <div className="add-feed-row">
            <button className="btn ghost sm add-toggle" onClick={() => setAdding(true)}>
              ＋ 添加频道
            </button>
            <button
              className="btn ghost sm"
              type="button"
              disabled={importOpml.isPending}
              onClick={() => fileRef.current?.click()}
            >
              {importOpml.isPending ? '导入中…' : '导入'}
            </button>
            {/* 导出是「换服务器 / 备份订阅」的出口。没有它，用户迁移时只能一条条抄地址 */}
            <button
              className="btn ghost sm"
              type="button"
              disabled={exportOpml.isPending || data.feeds.length === 0}
              title="把当前全部频道导出成 OPML 文件"
              onClick={() => exportOpml.mutate()}
            >
              {exportOpml.isPending ? '导出中…' : '导出'}
            </button>
            {/* 隐藏的文件选择器：OPML 是本地文件，浏览器只能通过 input[type=file] 拿内容 */}
            <input
              ref={fileRef}
              type="file"
              accept=".opml,.xml,text/xml,application/xml"
              hidden
              onChange={onPickOpml}
            />
          </div>
        )}
      </div>
    </aside>
  );
}

/**
 * 频道没图标时的字母头像。
 *
 * 为什么不用 `.dot`：一列灰点等于没有信息量 —— 12 个频道时还能靠位置记，30 个就完全没法扫。
 * 首字取自标题（中文取第一个字，英文取首字母），配色由标题哈希决定：
 * 同一个频道每台设备、每次刷新都是同一个颜色。
 */
const AVATAR_HUES = [212, 268, 168, 96, 32, 340] as const;

function LetterAvatar({ title }: { title: string }) {
  const t = (title || '?').trim();
  const ch = t ? [...t][0] ?? '?' : '?';
  let h = 0;
  for (let i = 0; i < t.length; i += 1) h = (h * 31 + t.charCodeAt(i)) % 9973;
  const hue = AVATAR_HUES[h % AVATAR_HUES.length] ?? 212;
  return (
    <span
      className="feed-avatar"
      style={{ background: `hsl(${hue} 46% 34%)`, color: '#fff' }}
      aria-hidden
    >
      {ch.toUpperCase()}
    </span>
  );
}

type GIconName = 'all' | 'unread' | 'favorite' | 'watch' | 'block';

/**
 * 全局视图的线性图标。统一描边 currentColor，随主题/激活态变色；
 * 比 emoji 更克制，也不会在深浅主题下出现色差。
 */
function GIcon({ name }: { name: GIconName }) {
  const c = {
    width: 16,
    height: 16,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  switch (name) {
    case 'all':
      return (
        <svg {...c}>
          <rect x="3" y="3" width="7" height="7" rx="1.6" />
          <rect x="14" y="3" width="7" height="7" rx="1.6" />
          <rect x="3" y="14" width="7" height="7" rx="1.6" />
          <rect x="14" y="14" width="7" height="7" rx="1.6" />
        </svg>
      );
    case 'unread':
      return (
        <svg {...c}>
          <circle cx="12" cy="12" r="5.5" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'favorite':
      return (
        <svg {...c}>
          <path
            d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9 6.8 19.6l1-5.8L3.6 9.7l5.8-.8z"
            fill="currentColor"
            stroke="none"
          />
        </svg>
      );
    case 'watch':
      return (
        <svg {...c}>
          <path d="M2 12s3.6-6.6 10-6.6S22 12 22 12s-3.6 6.6-10 6.6S2 12 2 12z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      );
    case 'block':
      return (
        <svg {...c}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M5.5 5.5l13 13" />
        </svg>
      );
  }
}
