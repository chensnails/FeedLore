import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { qk } from '../lib/query';
import { useUi } from '../store/ui';
import type { Feed, FeedsList } from '../lib/types';

/**
 * 频道列表。
 *
 * 注意「派生数据不要另存一份」：分组过滤、只看未读全部在渲染时从
 * `feedsQuery.data` + UI store 算出来。v1.x 把过滤结果写回全局 state，
 * 于是每加一个筛选条件都要手动重算，漏一处就出现「切换后列表不动」。
 */
export function FeedsPanel() {
  const group = useUi((s) => s.group);
  const setGroup = useUi((s) => s.setGroup);
  const onlyUnread = useUi((s) => s.onlyUnread);

  const { data, isPending, isError, error, refetch, isFetching } = useQuery({
    queryKey: qk.feeds,
    queryFn: () => api.feeds.list(),
  });

  if (isPending) return <p className="hint">加载频道…</p>;
  if (isError) {
    return (
      <div className="panel error">
        <p>频道加载失败：{error instanceof Error ? error.message : '未知错误'}</p>
        <button className="btn" onClick={() => void refetch()}>
          重试
        </button>
      </div>
    );
  }

  const feeds = visibleFeeds(data, group, onlyUnread);

  return (
    <section className="panel">
      <div className="chips">
        <button className={`chip${group === null ? ' on' : ''}`} onClick={() => setGroup(null)}>
          全部 <b>{data.total}</b>
        </button>
        {data.groups.map((g) => (
          <button key={g} className={`chip${group === g ? ' on' : ''}`} onClick={() => setGroup(g)}>
            {g}
          </button>
        ))}
        {isFetching && <span className="hint inline">刷新中…</span>}
      </div>

      <ul className="feeds">
        {feeds.map((f) => (
          <FeedRow key={f.id} feed={f} />
        ))}
      </ul>

      {feeds.length === 0 && <p className="hint">这个筛选下没有频道。</p>}

      <footer className="panel-foot">
        <span>
          共 {data.total} 个频道 · 启用 {data.enabled} · 卡片 {data.cardEnabled}
        </span>
        <span>
          未读 {data.flags.unread} / 收藏 {data.flags.favorite}
        </span>
      </footer>
    </section>
  );
}

function visibleFeeds(data: FeedsList, group: string | null, onlyUnread: boolean): Feed[] {
  return data.feeds.filter((f) => {
    if (group !== null && f.groupName !== group) return false;
    if (onlyUnread && f.unreadCount === 0) return false;
    return true;
  });
}

function FeedRow({ feed }: { feed: Feed }) {
  return (
    <li className={`feed${feed.enabled ? '' : ' off'}`}>
      <span className="dot" data-error={feed.error ? '1' : '0'} aria-hidden />
      <div className="feed-main">
        <p className="feed-title">{feed.customTitle ?? feed.title}</p>
        <p className="feed-meta">
          {feed.groupName || '未分组'}
          {feed.error ? ` · ${feed.error}` : ''}
        </p>
      </div>
      <span className="count">{feed.unreadCount}</span>
    </li>
  );
}
