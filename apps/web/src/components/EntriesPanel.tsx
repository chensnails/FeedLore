import { useQuery } from '@tanstack/react-query';
import type { EntriesListQuery } from '@feedlore/client';
import { api } from '../lib/api';
import { qk } from '../lib/query';
import { useUi } from '../store/ui';

/**
 * 条目列表。筛选条件全部来自「选中频道 + 只看未读」，不额外存派生数据：
 * `queryKey` 带上这两个维度，切频道就是一次正常的缓存命中/重取，不需要手工 relayout。
 */
export function EntriesPanel() {
  const feedId = useUi((s) => s.feedId);
  const onlyUnread = useUi((s) => s.onlyUnread);
  const openEntry = useUi((s) => s.openEntry);

  // hc 的 query 类型只接受字符串（URL 查询串的真实形态），数字要在服务端 coerce
  const query: EntriesListQuery = {
    limit: '30',
    ...(feedId ? { feeds: feedId } : {}),
    ...(onlyUnread ? { unread: '1' } : {}),
  };

  const { data, isPending, isError, error, refetch, isFetching } = useQuery({
    queryKey: [...qk.entries, feedId, onlyUnread],
    queryFn: () => api.entries.list(query),
  });

  if (isPending) return <main className="list"><p className="hint">加载条目…</p></main>;
  if (isError) {
    return (
      <main className="list">
        <div className="panel error">
          <p>条目加载失败：{error instanceof Error ? error.message : '未知错误'}</p>
          <button className="btn" onClick={() => void refetch()}>重试</button>
        </div>
      </main>
    );
  }

  return (
    <main className="list">
      <div className="list-head">
        <span>
          {data.total} 条{isFetching ? ' · 更新中…' : ''}
        </span>
        {data.tags.length > 0 && (
          <span className="tags-inline">
            {data.tags.slice(0, 6).map((t) => (
              <span key={t.tag} className="tag">
                {t.tag} <b>{t.n}</b>
              </span>
            ))}
          </span>
        )}
      </div>

      <ul className="cards">
        {data.entries.map((e) => (
          <li key={e.id}>
            <button className={`card${e.isRead ? ' read' : ''}`} onClick={() => openEntry(e.id)}>
              <p className="card-title">{e.name}</p>
              {e.desc && <p className="card-desc">{e.desc}</p>}
              <p className="card-meta">
                <span>{e.feedName}</span>
                {e.date && <span>{fmtDate(e.date)}</span>}
                {e.isFavorite && <span className="fav" title="已收藏">★</span>}
                {e.tags.slice(0, 3).map((t) => (
                  <span key={t} className="tag">{t}</span>
                ))}
              </p>
            </button>
          </li>
        ))}
      </ul>

      {data.entries.length === 0 && <p className="hint">这里还没有条目。</p>}
      {data.hasMore && <p className="hint">仅显示前 {data.limit} 条</p>}
    </main>
  );
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
