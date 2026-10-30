import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { qk } from '../lib/query';
import { useCreateFeed, useDeleteFeed, usePatchFeed, useRefreshFeed } from '../lib/mutations';
import { useUi } from '../store/ui';
import type { Feed, FeedsList } from '../lib/types';

/**
 * 左侧频道栏。
 *
 * 分组筛选是**纯显示**的局部状态，放组件里（不需要跨视图共享）；
 * 选中的频道要跨视图（列表/阅读）共享，才进 zustand。
 * 这条边界划清楚，就不会再出现「同一个筛选条件两处各存一份、改一处不生效」。
 */
export function FeedsPanel() {
  const feedId = useUi((s) => s.feedId);
  const setFeedId = useUi((s) => s.setFeedId);
  const [group, setGroup] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState('');
  const [groupName, setGroupName] = useState('');

  const createFeed = useCreateFeed();
  const patchFeed = usePatchFeed();
  const deleteFeed = useDeleteFeed();
  const refreshFeed = useRefreshFeed();

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: qk.feeds,
    queryFn: () => api.feeds.list(),
  });

  if (isPending) {
    return (
      <aside className="sidebar">
        <p className="hint">加载频道…</p>
      </aside>
    );
  }
  if (isError) {
    return (
      <aside className="sidebar">
        <p className="hint">频道加载失败：{error instanceof Error ? error.message : '未知错误'}</p>
        <button className="btn" onClick={() => void refetch()}>
          重试
        </button>
      </aside>
    );
  }

  const feeds = visibleFeeds(data, group);

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

  return (
    <aside className="sidebar">
      <div className="chips">
        <button className={`chip${group === null ? ' on' : ''}`} onClick={() => setGroup(null)}>
          全部 <b>{data.total}</b>
        </button>
        {data.groups.map((g) => (
          <button key={g} className={`chip${group === g ? ' on' : ''}`} onClick={() => setGroup(g)}>
            {g}
          </button>
        ))}
      </div>

      <ul className="feeds">
        <li>
          <button className={`feed${feedId === null ? ' on' : ''}`} onClick={() => setFeedId(null)}>
            <span className="dot" aria-hidden />
            <div className="feed-main">
              <p className="feed-title">全部频道</p>
              <p className="feed-meta">所有频道的最新条目</p>
            </div>
            <span className="count">{data.flags.unread}</span>
          </button>
        </li>
        {feeds.map((f) => (
          <li key={f.id} className="feed-row">
            <button
              className={`feed${feedId === f.id ? ' on' : ''}${f.enabled ? '' : ' off'}`}
              onClick={() => setFeedId(f.id)}
              title={f.error ?? f.url}
            >
              <span className="dot" data-error={f.error ? '1' : '0'} aria-hidden />
              <div className="feed-main">
                <p className="feed-title">{f.title}</p>
                <p className="feed-meta">
                  {f.groupName || '未分组'}
                  {f.error ? ' · 抓取失败' : ''}
                  {f.cardEnabled ? '' : ' · 卡片页隐藏'}
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
          </li>
        ))}
      </ul>

      {feeds.length === 0 && <p className="hint">这个分组下没有频道。</p>}

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
          <button className="btn ghost sm add-toggle" onClick={() => setAdding(true)}>
            ＋ 添加频道
          </button>
        )}
      </div>
    </aside>
  );
}

function visibleFeeds(data: FeedsList, group: string | null): Feed[] {
  return group === null ? data.feeds : data.feeds.filter((f) => f.groupName === group);
}
