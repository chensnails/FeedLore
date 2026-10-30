import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { qk } from '../lib/query';
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
          <li key={f.id}>
            <button
              className={`feed${feedId === f.id ? ' on' : ''}${f.enabled ? '' : ' off'}`}
              onClick={() => setFeedId(f.id)}
              title={f.error ?? f.url}
            >
              <span className="dot" data-error={f.error ? '1' : '0'} aria-hidden />
              <div className="feed-main">
                <p className="feed-title">{f.customTitle ?? f.title}</p>
                <p className="feed-meta">
                  {f.groupName || '未分组'}
                  {f.error ? ' · 抓取失败' : ''}
                </p>
              </div>
              <span className="count">{f.unreadCount}</span>
            </button>
          </li>
        ))}
      </ul>

      {feeds.length === 0 && <p className="hint">这个分组下没有频道。</p>}
    </aside>
  );
}

function visibleFeeds(data: FeedsList, group: string | null): Feed[] {
  return group === null ? data.feeds : data.feeds.filter((f) => f.groupName === group);
}
