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
  useSaveLayout,
} from '../lib/mutations';
import { useUi } from '../store/ui';
import type { Feed } from '../lib/types';
import { Thumb } from './Thumb';

/**
 * 左侧频道栏。
 *
 * 三件事都对齐 v1 的 ChannelList：
 * 1. **分组是折叠的，不是筛选的**。v2 早期用一行分组 chip 做筛选，等于每看一个分组要先点两下
 *    （点分组 → 再点频道），而且看不到别的分组还有多少未读。折叠列表一次能扫完全部。
 * 2. 折叠状态存服务端 `layout.collapsedGroups`（换设备还是收着的）。
 * 3. 频道多了要能搜：这是频道栏唯一随规模退化的能力，超过二三十个源就必须有。
 *
 * 选中的频道要跨视图（列表/阅读）共享，才进 zustand；折叠与搜索是纯显示状态，留组件里 /
 * 服务端偏好里，不进 store。
 */
export function FeedsPanel() {
  const feedId = useUi((s) => s.feedId);
  const setFeedId = useUi((s) => s.setFeedId);
  const navOpen = useUi((s) => s.navOpen);
  const closeNav = useUi((s) => s.closeNav);
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
  const saveLayout = useSaveLayout();
  const fileRef = useRef<HTMLInputElement>(null);

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
    const order = data.groupOrder.length ? data.groupOrder : data.groups;
    const out: Array<{ name: string; feeds: Feed[] }> = [];
    for (const g of order) {
      const feeds = data.feeds.filter((f) => (f.groupName || '') === g && match(f));
      if (feeds.length) out.push({ name: g, feeds });
    }
    // 未分组（groupName 为空）与「groupOrder 里没登记的分组」都落这里
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

  function remove(f: Feed): void {
    // 破坏性操作，且服务端会级联删掉该频道的全部条目 —— 必须让用户明确确认
    if (!window.confirm(`删除「${f.title}」？\n该频道的 ${f.entryCount} 条记录会一起删除，不可恢复。`)) return;
    deleteFeed.mutate(f.id);
  }

  const allMatch = !ql.trim() || '全部频道'.includes(ql.trim());

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

      <ul className="feeds">
        {allMatch && (
          <li>
            <button className={`feed${feedId === null ? ' on' : ''}`} onClick={() => setFeedId(null)}>
              <span className="dot" aria-hidden />
              <div className="feed-main">
                <p className="feed-title">全部频道</p>
                <p className="feed-meta">
                  {data.feeds.length} 个频道 · {data.flags.total} 条
                </p>
              </div>
              <span className="count">{data.flags.unread}</span>
            </button>
          </li>
        )}

        {grouped.map((g) => {
          /* 未分组那一组不折叠：它没有名字，折叠起来就是一堆「▸ 未分组」，
           * 点开才知道里面有什么，还不如直接列出来。 */
          const foldable = g.name !== '';
          const isCollapsed = foldable && collapsedSet.has(g.name);
          const gUnread = g.feeds.reduce((n, f) => n + f.unreadCount, 0);
          return (
            <li key={g.name || '__ungrouped'} className="feed-group-wrap">
              {foldable && (
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
              )}
              {!isCollapsed &&
                g.feeds.map((f) => (
                  <div key={f.id} className="feed-row">
                    <button
                      className={`feed${feedId === f.id ? ' on' : ''}${f.enabled ? '' : ' off'}`}
                      onClick={() => setFeedId(f.id)}
                      title={f.error ?? f.url}
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
                        onClick={() => remove(f)}
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
