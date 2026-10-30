import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { EntriesListQuery } from '@feedlore/client';
import { api } from '../lib/api';
import { qk } from '../lib/query';
import { useReadAll, useSetFavorite, useSetRead } from '../lib/mutations';
import { useUi } from '../store/ui';
import type { EntryCard } from '../lib/types';
import { Thumb } from './Thumb';

/**
 * 条目列表。筛选条件全部来自「选中频道 + 只看未读」，不额外存派生数据：
 * `queryKey` 带上这两个维度，切频道就是一次正常的缓存命中/重取，不需要手工 relayout。
 *
 * 写操作全部走 `lib/mutations`（乐观更新 + 失败回滚），组件只负责「点了要发生什么」。
 */
export function EntriesPanel() {
  const feedId = useUi((s) => s.feedId);
  const onlyUnread = useUi((s) => s.onlyUnread);
  const toggleOnlyUnread = useUi((s) => s.toggleOnlyUnread);
  const openEntry = useUi((s) => s.openEntry);
  const search = useUi((s) => s.search);
  const setSearch = useUi((s) => s.setSearch);

  const setRead = useSetRead();
  const setFavorite = useSetFavorite();
  const readAll = useReadAll();

  /* 搜索框是**受控 + 本地 state**，不是直接绑 store：
   * 每敲一个字都写 store 会让列表请求跟着抖 5 次（还每次都是一个完整的 ilike 查询）。
   * 300ms 防抖后再写，顺带把「敲了空格但没输内容」的空搜索挡掉。 */
  const [kw, setKw] = useState(search);
  useEffect(() => {
    const t = setTimeout(() => setSearch(kw.trim()), 300);
    return () => clearTimeout(t);
  }, [kw, setSearch]);

  const inputRef = useRef<HTMLInputElement>(null);

  // hc 的 query 类型只接受字符串（URL 查询串的真实形态），数字要在服务端 coerce
  const query: EntriesListQuery = {
    limit: '30',
    ...(feedId ? { feeds: feedId } : {}),
    ...(onlyUnread ? { unread: '1' } : {}),
    ...(search ? { q: search } : {}),
  };

  const { data, isPending, isError, error, refetch, isFetching } = useQuery({
    queryKey: [...qk.entries, feedId, onlyUnread, search],
    queryFn: () => api.entries.list(query),
  });

  // 频道列表已在缓存里（侧栏取过），这里只读不额外请求，用来算「全部已读」的作用范围
  const feedsQuery = useQuery({
    queryKey: qk.feeds,
    queryFn: () => api.feeds.list(),
    staleTime: 60_000,
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

  /** 点开即已读：先打开阅读层（不等请求），已读标记并行发出。 */
  function open(e: EntryCard): void {
    openEntry(e.id);
    if (!e.isRead) setRead.mutate({ id: e.id, isRead: true });
  }

  /* 「全部已读」的作用范围必须与「屏幕上看到的」一致：
   * - 选中某频道 → 只标这个频道；
   * - 全部频道 → 只标卡片开关打开的频道（列表默认 scope=cards 的同一批）。
   * 不传 feeds 服务端会标「全部频道」，会把卡片页看不到的频道一起标掉。 */
  const targetFeeds = feedId
    ? [Number(feedId)]
    : (feedsQuery.data?.feeds.filter((f) => f.cardEnabled).map((f) => Number(f.id)) ?? []);

  const unreadVisible = data.entries.filter((e) => !e.isRead).length;

  return (
    <main className="list">
      <div className="list-head">
        <span>
          {data.total} 条{isFetching ? ' · 更新中…' : ''}
          {unreadVisible > 0 && (
            <em className="inline-unread">
              · 本页 {unreadVisible}/{data.entries.length} 未读
            </em>
          )}
        </span>
        <span className="list-actions">
          <button
            className={`chip sm${onlyUnread ? ' on' : ''}`}
            onClick={toggleOnlyUnread}
            aria-pressed={onlyUnread}
            title="只看未读"
          >
            只看未读
          </button>
          <span className="search-box">
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
                ✕
              </button>
            )}
          </span>
          {data.tags.length > 0 && (
            <span className="tags-inline">
              {data.tags.slice(0, 4).map((t) => (
                <span key={t.tag} className="tag">
                  {t.tag} <b>{t.n}</b>
                </span>
              ))}
            </span>
          )}
          <button
            className="btn ghost sm"
            disabled={readAll.isPending || data.total === 0}
            /* 搜索态必须把 q 一起带上：不带就变成「把范围内所有未读都标掉」，
             * 而用户看到的只是搜索结果那几条 —— 这是最容易让人恼火的误操作。 */
            onClick={() => readAll.mutate({ feeds: targetFeeds, ...(search ? { q: search } : {}) })}
            title="把当前范围内的未读全部标为已读"
          >
            {readAll.isPending ? '处理中…' : '全部已读'}
          </button>
        </span>
      </div>

      <ul className="cards">
        {data.entries.map((e) => (
          <li key={e.id} className={`card-row${e.isRead ? ' read' : ''}`}>
            <button className="card" onClick={() => open(e)}>
              <div className="card-body">
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
              </div>
              {/* 封面：服务端已把外链改写成本站代理，这里只负责展示与失败降级 */}
              <Thumb src={e.image} className="card-thumb" decorative />
            </button>
            <button
              className={`fav-btn${e.isFavorite ? ' on' : ''}`}
              aria-label={e.isFavorite ? '取消收藏' : '收藏'}
              title={e.isFavorite ? '取消收藏' : '收藏'}
              onClick={() => setFavorite.mutate({ id: e.id, isFavorite: !e.isFavorite })}
            >
              {e.isFavorite ? '★' : '☆'}
            </button>
          </li>
        ))}
      </ul>

      {data.entries.length === 0 && (
        <p className="hint">
          {search ? `没有匹配「${search}」的条目。` : '这里还没有条目。'}
        </p>
      )}
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
