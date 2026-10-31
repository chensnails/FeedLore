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
  useSavePrefs,
} from '../lib/mutations';
import { useUi } from '../store/ui';
import type { Feed } from '../lib/types';
import { Thumb } from './Thumb';
import { Icon } from './Icon';

/**
 * 设置的「频道」页签：频道分组 + 频道源的完整管理。
 *
 * 这些能力原本散在左侧频道栏里（添加 / 导入导出 / 刷新 / 暂停 / 卡片开关 / 删除 /
 * 分组改名与排序）。频道栏的本职是**导航**，管理动作混在里面既挤又容易误触，
 * 于是整体搬到设置里；频道栏只保留「搜索 / 全局视图 / 折叠 / 只看一组 / 屏蔽」。
 *
 * 类名与频道栏保持同一套（.feeds / .feed-row / .feed-ops / .add-feed …），
 * 样式与回归脚本选择器都能直接复用，不必再维护第二套。
 *
 * 三条纪律（从原实现原样继承）：
 * 1. **搜索态一律禁排**：结果只是子集，照它写回顺序会把没匹配到的频道挤到一起。
 * 2. **跨组拖拽不接**：改分组归属是另一件事。
 * 3. 每次重排都带全量顺序（服务端整批重写 sort_order）。
 */

/** 单频道采集间隔的档位（分钟）。服务端夹取区间是 5–1440；「跟随全局」发 'global'。 */
const INTERVALS = [10, 15, 30, 60, 120, 240, 360, 720, 1440] as const;
const intervalLabel = (m: number): string => (m >= 1440 ? '1 天' : m >= 60 ? `${m / 60} 时` : `${m} 分`);
export function ChannelsTab() {
  const askConfirm = useUi((s) => s.askConfirm);
  const createFeed = useCreateFeed();
  const patchFeed = usePatchFeed();
  const deleteFeed = useDeleteFeed();
  const refreshFeed = useRefreshFeed();
  const importOpml = useImportOpml();
  const exportOpml = useExportOpml();
  const reorder = useReorderFeeds();
  const savePrefs = useSavePrefs();
  const fileRef = useRef<HTMLInputElement>(null);

  const [url, setUrl] = useState('');
  const [groupName, setGroupName] = useState('');
  const [adding, setAdding] = useState(false);
  const [ql, setQl] = useState('');
  const [dragId, setDragId] = useState<string | null>(null);
  const [localOrder, setLocalOrder] = useState<string[] | null>(null);
  const [renaming, setRenaming] = useState<{ from: string; to: string } | null>(null);
  const focusAfter = useRef<string | null>(null);

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: qk.feeds,
    queryFn: () => api.feeds.list(),
  });

  const grouped = useMemo(() => {
    if (!data) return [];
    const kw = ql.trim().toLowerCase();
    const match = (f: Feed) => !kw || f.title.toLowerCase().includes(kw) || f.url.toLowerCase().includes(kw);
    const saved = data.groupOrder.length ? data.groupOrder : data.groups;
    const order = localOrder ?? saved;
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
  }, [data, ql, localOrder]);

  if (isPending) return <p className="hint">加载频道…</p>;
  if (isError) {
    return (
      <>
        <p className="hint">频道加载失败：{error instanceof Error ? error.message : '未知错误'}</p>
        <button className="btn" onClick={() => void refetch()}>
          重试
        </button>
      </>
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
    const ok = await askConfirm({
      title: `删除「${f.title}」？`,
      body: `该频道的 ${f.entryCount} 条记录会一起删除，不可恢复。`,
      okText: '删除',
      danger: true,
    });
    if (!ok) return;
    deleteFeed.mutate(f.id);
  }

  const canSort = !ql.trim();
  const groupOrder = localOrder ?? (data.groupOrder.length ? data.groupOrder : data.groups);

  function pushOrder(next: Array<{ name: string; feeds: Feed[] }>): void {
    const items: Array<{ id: number; sortOrder: number; groupName: string }> = [];
    for (const g of next) {
      for (const f of g.feeds) {
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
          window.setTimeout(() => {
            document.querySelector<HTMLElement>(`[data-fid="${keep}"] .feed`)?.focus();
          }, 60);
        },
      },
    );
  }

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
    if (from < 0 || to < 0) return;
    const [moved] = g.feeds.splice(from, 1);
    if (!moved) return;
    g.feeds.splice(to, 0, moved);
    focusAfter.current = id;
    pushOrder(next);
  }

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

  return (
    <>
      <p className="hint tiny">
        在这里管理频道分组与订阅源。左侧频道栏只负责导航；管理动作集中在此。
      </p>

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

      <ul className="feeds">
        {grouped.map((g) => {
          const foldable = g.name !== '';
          const gUnread = g.feeds.reduce((n, f) => n + f.unreadCount, 0);
          return (
            <li key={g.name || '__ungrouped'} className="feed-group-wrap">
              {foldable &&
                (renaming?.from === g.name ? (
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
                  <div className="feed-group-row">
                    <div className="feed-group">
                      <span className="feed-group-caret" aria-hidden>
                        <Icon name="chevron-down" size={12} />
                      </span>
                      <span className="feed-group-name">{g.name}</span>
                      {gUnread > 0 && <span className="feed-group-n">{gUnread}</span>}
                    </div>
                    <span className="feed-group-ops">
                      <button
                        className="icon-btn"
                        title="重命名分组"
                        aria-label={`重命名分组 ${g.name}`}
                        onClick={() => setRenaming({ from: g.name, to: g.name })}
                      >
                        <Icon name="pencil" size={14} />
                      </button>
                      <button
                        className="icon-btn"
                        title="上移分组"
                        aria-label={`上移分组 ${g.name}`}
                        onClick={() => moveGroup(g.name, -1)}
                      >
                        <Icon name="arrow-up" size={14} />
                      </button>
                      <button
                        className="icon-btn"
                        title="下移分组"
                        aria-label={`下移分组 ${g.name}`}
                        onClick={() => moveGroup(g.name, 1)}
                      >
                        <Icon name="arrow-down" size={14} />
                      </button>
                    </span>
                  </div>
                ))}
              {g.feeds.map((f) => (
                <div
                  key={f.id}
                  className={`feed-row${dragId === f.id ? ' dragging' : ''}`}
                  data-fid={f.id}
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
                  <div className={`feed${f.enabled ? '' : ' off'}`} title={`${f.error ?? f.url}`}>
                    <Thumb
                      src={f.icon}
                      className="feed-icon"
                      decorative
                      fallback={<LetterAvatar title={f.title} />}
                    />
                    <div className="feed-main">
                      <p className="feed-title">{f.title}</p>
                    </div>
                    {f.error && (
                      <span className="feed-flag danger" title={f.error}>
                        失败
                      </span>
                    )}
                    {!f.cardEnabled && (
                      <span className="feed-flag" title="卡片页隐藏">
                        隐藏
                      </span>
                    )}
                    <span className="count">{f.unreadCount}</span>
                  </div>

                  <span className="feed-ops">
                    {/* 单频道采集间隔：null = 跟随全局。选择即保存（patch 静默成功，
                        select 的值本身就是反馈）。非预设档（历史遗留值）动态补一项，别让它显示成空。 */}
                    <select
                      className="input sm feed-interval"
                      title="采集间隔（跟随全局或单独设置）"
                      aria-label={`采集间隔：${f.title}`}
                      value={f.refreshMinutes ?? ''}
                      disabled={patchFeed.isPending}
                      onChange={(e) => {
                        const v = e.target.value;
                        patchFeed.mutate({
                          id: f.id,
                          patch: { refreshMinutes: v === '' ? 'global' : Number(v) },
                        });
                      }}
                    >
                      <option value="">跟随全局</option>
                      {INTERVALS.map((m) => (
                        <option key={m} value={m}>
                          {intervalLabel(m)}
                        </option>
                      ))}
                      {f.refreshMinutes !== null &&
                        !INTERVALS.includes(f.refreshMinutes as (typeof INTERVALS)[number]) && (
                          <option value={f.refreshMinutes}>{intervalLabel(f.refreshMinutes)}</option>
                        )}
                    </select>
                    <button
                      className="icon-btn"
                      title="立即抓取这个频道"
                      aria-label="立即抓取这个频道"
                      disabled={refreshFeed.isPending}
                      onClick={() => refreshFeed.mutate(f.id)}
                    >
                      <Icon name="refresh" size={14} className={refreshFeed.isPending ? 'spin' : undefined} />
                    </button>
                    <button
                      className={`icon-btn${f.enabled ? '' : ' off'}`}
                      title={f.enabled ? '暂停采集' : '恢复采集'}
                      aria-label={f.enabled ? '暂停采集' : '恢复采集'}
                      disabled={patchFeed.isPending}
                      onClick={() => patchFeed.mutate({ id: f.id, patch: { enabled: !f.enabled } })}
                    >
                      <Icon name={f.enabled ? 'pause' : 'play'} size={14} />
                    </button>
                    <button
                      className={`icon-btn${f.cardEnabled ? '' : ' off'}`}
                      title={f.cardEnabled ? '在卡片页隐藏' : '在卡片页显示'}
                      aria-label={f.cardEnabled ? '在卡片页隐藏' : '在卡片页显示'}
                      disabled={patchFeed.isPending}
                      onClick={() => patchFeed.mutate({ id: f.id, patch: { cardEnabled: !f.cardEnabled } })}
                    >
                      <Icon name={f.cardEnabled ? 'grid' : 'list'} size={14} />
                    </button>
                    <button
                      className="icon-btn danger"
                      title="删除频道"
                      aria-label="删除频道"
                      disabled={deleteFeed.isPending}
                      onClick={() => void remove(f)}
                    >
                      <Icon name="close" size={14} />
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
            <p className="hint tiny">添加后会立即抓取一次，源站较慢时可能需要几秒。</p>
          </form>
        ) : (
          <div className="add-feed-row">
            <button className="btn ghost sm add-toggle" onClick={() => setAdding(true)}>
              <Icon name="plus" size={14} />
              添加频道
            </button>
            <button
              className="btn ghost sm"
              type="button"
              disabled={importOpml.isPending}
              onClick={() => fileRef.current?.click()}
            >
              {importOpml.isPending ? '导入中…' : '导入'}
            </button>
            <button
              className="btn ghost sm"
              type="button"
              disabled={exportOpml.isPending || data.feeds.length === 0}
              title="把当前全部频道导出成 OPML 文件"
              onClick={() => exportOpml.mutate()}
            >
              {exportOpml.isPending ? '导出中…' : '导出'}
            </button>
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
    </>
  );
}

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
