import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api } from '../lib/api';
import { qk } from '../lib/query';
import { useSaveLayout } from '../lib/mutations';
import { useUi, type ListFilter } from '../store/ui';
import type { Feed } from '../lib/types';
import { Thumb } from './Thumb';
import { Icon, type IconName } from './Icon';

/**
 * 左侧频道栏（**纯导航**）。
 *
 * 结构：
 *   搜索框
 *   全局视图：全部频道 / 未读 / 收藏 / 关注   ← 系统级范围，跨所有订阅
 *   分隔线
 *   分组折叠列表（订阅源）—— 点分组=折叠，点 ◎=只看这一组
 *   分隔线
 *   屏蔽（置底）
 *   ⚙ 频道管理（打开 设置 → 频道）
 *
 * 职责边界（本轮调整）：**分组与频道源的管理（增删改、导入导出、重排、启停、
 * 卡片开关）整体迁到设置面板的「频道」页签**。这里只保留「看什么、去哪儿」的导航，
 * 以及承载导航必须的折叠 / 只看一组。理由是频道栏被管理控件塞满后，既挤又容易误触，
 * 导航本身反而退居其次。
 *
 * 折叠状态仍存服务端 `layout.collapsedGroups`（换设备还是收着的）。
 */
export function FeedsPanel() {
  const feedId = useUi((s) => s.feedId);
  const setFeedId = useUi((s) => s.setFeedId);
  const navOpen = useUi((s) => s.navOpen);
  const closeNav = useUi((s) => s.closeNav);
  const focusGroup = useUi((s) => s.groupName);
  const setFocusGroup = useUi((s) => s.setGroupName);
  const filter = useUi((s) => s.filter);
  const setFilter = useUi((s) => s.setFilter);
  const openSettings = useUi((s) => s.openSettings);
  const [ql, setQl] = useState('');

  const saveLayout = useSaveLayout();

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: qk.feeds,
    queryFn: () => api.feeds.list(),
  });

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

  const sidebarClass = `sidebar${navOpen ? ' open' : ''}`;

  /** 分组 → 频道。未分组的排最后（分组按 groupOrder，未分组垫底）。 */
  const grouped = useMemo(() => {
    if (!data) return [];
    const kw = ql.trim().toLowerCase();
    const match = (f: Feed) => !kw || f.title.toLowerCase().includes(kw) || f.url.toLowerCase().includes(kw);
    const order = data.groupOrder.length ? data.groupOrder : data.groups;
    const out: Array<{ name: string; feeds: Feed[] }> = [];
    for (const g of order) {
      if (!g) continue;
      const feeds = data.feeds.filter((f) => (f.groupName || '') === g && match(f));
      if (feeds.length) out.push({ name: g, feeds });
    }
    const known = new Set(order);
    const rest = data.feeds.filter((f) => !f.groupName || !known.has(f.groupName)).filter(match);
    if (rest.length) out.push({ name: '', feeds: rest });
    return out;
  }, [data, ql]);

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

  /* 全局视图：系统级范围，跨所有订阅。激活态 = 没选具体频道/分组 且 filter 命中。
   * 点一下清掉 feedId/group/tag（setFeedId(null) 顺手清了这两个），再设 filter。 */
  const isGlobal = feedId === null && focusGroup === null;
  const scopeActive = (k: ListFilter): boolean => isGlobal && filter === k;
  function pickScope(k: ListFilter): void {
    setFeedId(null);
    setFilter(k);
  }

  const gviews: Array<{ key: ListFilter; name: string; n: number; icon: IconName }> = [
    { key: 'all', name: '全部频道', n: data.flags.total, icon: 'all' },
    { key: 'unread', name: '未读', n: data.flags.unread, icon: 'inbox' },
    { key: 'favorite', name: '收藏', n: data.flags.favorite, icon: 'star' },
    { key: 'watch', name: '关注', n: data.flags.watching, icon: 'eye' },
  ];

  return (
    <aside className={sidebarClass}>
      {/* 只在窄屏抽屉里出现（CSS 控制）：给一个不用点遮罩的关闭路径 */}
      <div className="sidebar-head">
        <span>频道</span>
        <button className="btn ghost icon nav-close" aria-label="收起频道栏" onClick={closeNav}>
          <Icon name="close" size={16} />
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
        <Icon name="search" size={14} className="search-ico" />
        {ql && (
          <button className="search-clear" aria-label="清空" title="清空" onClick={() => setQl('')}>
            <Icon name="close" size={12} />
          </button>
        )}
      </div>

      <nav className="gviews" aria-label="全局视图">
        {gviews.map((g) => (
          <button
            key={g.key}
            className={`gview${scopeActive(g.key) ? ' on' : ''}`}
            aria-pressed={scopeActive(g.key)}
            onClick={() => pickScope(g.key)}
          >
            <span className="gview-ico">
              <Icon name={g.icon} size={16} />
            </span>
            <span className="gview-name">{g.name}</span>
            {g.n > 0 && <span className="gview-n">{g.n}</span>}
          </button>
        ))}
      </nav>

      <div className="nav-sep" aria-hidden="true" />

      <ul className="feeds">
        {grouped.map((g) => {
          const foldable = g.name !== '';
          const isCollapsed = foldable && collapsedSet.has(g.name);
          const gUnread = g.feeds.reduce((n, f) => n + f.unreadCount, 0);
          return (
            <li key={g.name || '__ungrouped'} className="feed-group-wrap">
              {foldable && (
                <div className={`feed-group-row${focusGroup === g.name ? ' on' : ''}`}>
                  <button
                    className={`feed-group${isCollapsed ? ' collapsed' : ''}`}
                    aria-expanded={!isCollapsed}
                    title={isCollapsed ? '展开分组' : '收起分组'}
                    onClick={() => toggleGroup(g.name)}
                  >
                    <span className="feed-group-caret" aria-hidden>
                      <Icon name="chevron-down" size={12} />
                    </span>
                    <span className="feed-group-name">{g.name}</span>
                    {gUnread > 0 && <span className="feed-group-n">{gUnread}</span>}
                  </button>
                  <span className="feed-group-ops">
                    {/* 「只看这一组」：导航用的范围筛选，留在频道栏 */}
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
                        if (collapsedSet.has(g.name)) toggleGroup(g.name);
                      }}
                    >
                      <Icon name="target" size={14} />
                    </button>
                  </span>
                </div>
              )}
              {!isCollapsed &&
                g.feeds.map((f) => (
                  <div key={f.id} className="feed-row" data-fid={f.id}>
                    <button
                      className={`feed${feedId === f.id ? ' on' : ''}${f.enabled ? '' : ' off'}`}
                      onClick={() => setFeedId(f.id)}
                      title={`${f.error ?? f.url}`}
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

      <nav className="gviews bottom" aria-label="系统视图">
        <button
          className={`gview${scopeActive('block') ? ' on' : ''}`}
          aria-pressed={scopeActive('block')}
          onClick={() => pickScope('block')}
        >
          <span className="gview-ico">
            <Icon name="block" size={16} />
          </span>
          <span className="gview-name">屏蔽</span>
          {data.flags.blocked > 0 && <span className="gview-n">{data.flags.blocked}</span>}
        </button>
      </nav>

      <div className="add-feed">
        <div className="add-feed-row">
          <button
            className="btn ghost sm"
            title="添加 / 删除频道、管理分组、导入导出"
            onClick={() => openSettings('channels')}
          >
            <Icon name="settings" size={14} />
            频道管理
          </button>
        </div>
      </div>
    </aside>
  );
}

/**
 * 频道没图标时的字母头像。配色由标题哈希决定，同一频道每次都是同一个颜色。
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

