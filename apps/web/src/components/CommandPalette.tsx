import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { cjkPinyin } from '../lib/pinyin';
import { qk } from '../lib/query';
import { useRefreshAll, useSaveAppearance, useSaveLayout } from '../lib/mutations';
import { useUi, type ListFilter, type ListSort, type ListView } from '../store/ui';

/**
 * 命令面板（⌘K / Ctrl+K）。
 *
 * 为什么值得从 v1 搬过来：这个应用里「改视图 / 换排序 / 切筛选 / 跳频道 / 开设置」
 * 全都是低频但分散的操作，散在三个工具条和两个面板里。熟练用户真正想要的是
 * 敲两个字就到位 —— 这也是 v1 后期用户最常用的入口。
 *
 * 三条与 v1 一致的口径：
 * 1. **拼音可搜**：`cd gl` 能找到「切换网格」，「shxx」能找到「外观设置」；
 * 2. **子序列匹配兜底**：`qwg` 也能命中，因为拼音是全拼+首字母拼在一起的串；
 * 3. 命令集合是**按当前状态现算**的（日报关掉就不出现日报命令），不是一份写死的清单。
 *
 * 面板本身刻意不依赖 Radix 之类的弹层库：它只有「一个输入框 + 一个列表」，
 * 自己管焦点反而更可靠（打开即聚焦、Esc 关闭、上下键走列表）。
 */

interface Command {
  id: string;
  group: string;
  label: string;
  hint?: string;
  keywords: string;
  run: () => void;
}

const THEMES = [
  ['auto', '跟随系统'],
  ['light', '浅色'],
  ['dark', '深色'],
  ['github', 'GitHub 暗黑'],
] as const;

const VIEWS: ReadonlyArray<readonly [ListView, string]> = [
  ['grid', '网格'],
  ['list', '列表'],
];
const SORTS: ReadonlyArray<readonly [ListSort, string]> = [
  ['new', '新→旧'],
  ['old', '旧→新'],
  ['name', '按名称'],
];
const FILTERS: ReadonlyArray<readonly [ListFilter, string]> = [
  ['all', '全部'],
  ['unread', '未读'],
  ['favorite', '收藏'],
  ['watch', '关注'],
  ['block', '屏蔽'],
];

export function CommandPalette({
  role,
  onOpenDigest,
  onOpenAdmin,
}: {
  /** 会话角色可能是 null（未登录/未知），只有 'admin' 才挂管理命令 */
  role: string | null;
  onOpenDigest: () => void;
  onOpenAdmin: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const saveAppearance = useSaveAppearance();
  const saveLayout = useSaveLayout();
  const refreshAll = useRefreshAll();

  const feedsQuery = useQuery({ queryKey: qk.feeds, queryFn: () => api.feeds.list(), staleTime: 60_000 });
  /* 全局快捷键：⌘K / Ctrl+K 开合，Esc 关闭。
   * 用 `e.key.toLowerCase()` 而不是 keyCode —— 后者在非 QWERTY 布局与输入法激活时会失准。 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === 'Escape') setOpen(false);
    };
    /* 顶栏按钮走自定义事件而不是伪造一次 KeyboardEvent：
     * 伪造键盘事件既难读，也会被别的监听者当成「用户真的按了 ⌘K」。 */
    const onOpen = (): void => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('feedlore:cmdk', onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('feedlore:cmdk', onOpen);
    };
  }, []);

  // 打开后聚焦输入框并清空：上次的命令不该留在框里让人误按回车
  useEffect(() => {
    if (!open) return;
    setQ('');
    setIdx(0);
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const cmds: Command[] = [];
    const close = (fn: () => void) => () => {
      fn();
      setOpen(false);
    };

    for (const [v, label] of VIEWS) {
      cmds.push({
        id: `view-${v}`,
        group: '视图',
        label: `视图：${label}`,
        keywords: `view ${v} 视图 网格 列表 布局`,
        run: close(() => {
          useUi.getState().setView(v);
          saveLayout.mutate({ view: v });
        }),
      });
    }
    for (const [v, label] of SORTS) {
      cmds.push({
        id: `sort-${v}`,
        group: '排序',
        label: `排序：${label}`,
        keywords: `sort ${v} 排序 时间 名称`,
        run: close(() => {
          useUi.getState().setSort(v);
          saveLayout.mutate({ sort: v });
        }),
      });
    }
    for (const [v, label] of FILTERS) {
      cmds.push({
        id: `filter-${v}`,
        group: '筛选',
        label: `筛选：${label}`,
        keywords: `filter ${v} 筛选 范围 未读 收藏 关注 屏蔽`,
        run: close(() => useUi.getState().setFilter(v)),
      });
    }
    for (const [v, label] of THEMES) {
      cmds.push({
        id: `theme-${v}`,
        group: '主题',
        label: `主题：${label}`,
        keywords: `theme ${v} 主题 外观 暗色 浅色`,
        run: close(() => saveAppearance.mutate({ theme: v })),
      });
    }
    cmds.push(
      {
        id: 'open-prefs',
        group: '设置',
        label: '打开设置',
        hint: 'Aa',
        keywords: 'settings prefs 设置 外观 阅读 账号 关注规则',
        run: close(() => useUi.getState().setSettingsOpen(true)),
      },
      {
        id: 'open-digest',
        group: '设置',
        label: '打开 AI 日报',
        keywords: 'digest ai 日报 摘要 简报',
        run: close(onOpenDigest),
      },
      {
        id: 'refresh',
        group: '操作',
        label: '刷新全部频道',
        keywords: 'refresh 刷新 同步 拉取',
        run: close(() => refreshAll.mutate()),
      },
      {
        id: 'top',
        group: '操作',
        label: '回到顶部',
        keywords: 'top 顶部 最上面',
        run: close(() => {
          document.querySelector('.list')?.scrollTo({ top: 0, behavior: 'smooth' });
        }),
      },
    );
    if (role === 'admin') {
      cmds.push({
        id: 'open-admin',
        group: '设置',
        label: '打开管理面板',
        keywords: 'admin 管理 状态 采集 用户',
        run: close(onOpenAdmin),
      });
    }
    // 频道跳转：频道多的时候这是最省事的一条路（不用在侧栏里翻折叠组）
    cmds.push({
      id: 'feed-all',
      group: '跳转到频道',
      label: '全部频道',
      keywords: 'all feeds 全部频道',
      run: close(() => useUi.getState().setFeedId(null)),
    });
    for (const f of feedsQuery.data?.feeds ?? []) {
      cmds.push({
        id: `feed-${f.id}`,
        group: '跳转到频道',
        label: f.title || f.url,
        hint: f.groupName || '未分组',
        keywords: `feed channel 频道 ${f.title} ${f.groupName ?? ''} ${f.url}`,
        run: close(() => useUi.getState().setFeedId(f.id)),
      });
    }
    return cmds;
    /* store 一律走 getState()：命令集合只依赖 role / 频道列表，不该随
     * 「搜索词、是否打开抽屉」这些无关状态重算（每敲一个字就重建几十条命令纯属浪费）。 */
  }, [role, feedsQuery.data, onOpenDigest, onOpenAdmin]);

  /** 过滤：先算好拼音串，再做「整串包含 / 子序列」两级匹配（与 v1 同一套）。 */
  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase();
    if (!kw) return commands;
    return commands.filter((c) => {
      const hay = `${c.label} ${c.keywords} ${c.hint ?? ''} ${cjkPinyin(c.label + ' ' + c.keywords)}`.toLowerCase();
      if (hay.includes(kw)) return true;
      let i = 0;
      for (const ch of kw) {
        i = hay.indexOf(ch, i);
        if (i < 0) return false;
        i += 1;
      }
      return true;
    });
  }, [commands, q]);

  // 过滤结果变了要把选中项拉回第一条，否则会出现「按回车执行了不在列表里的命令」
  useEffect(() => setIdx(0), [q]);

  // 选中项滚进视野：列表可能比面板高
  useEffect(() => {
    const el = listRef.current?.children[idx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [idx]);

  if (!open) return null;

  const active = filtered[idx];

  return (
    <div className="cmdk-backdrop" onClick={() => setOpen(false)} role="presentation">
      <div
        className="cmdk"
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="cmdk-input"
          value={q}
          placeholder="输入命令或频道名（可打拼音，如 gl / sz / qh）"
          aria-label="搜索命令"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setIdx((i) => Math.min(filtered.length - 1, i + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setIdx((i) => Math.max(0, i - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              active?.run();
            }
          }}
        />
        <ul className="cmdk-list" ref={listRef}>
          {filtered.map((c, i) => (
            <li key={c.id}>
              <button
                className={`cmdk-item${i === idx ? ' on' : ''}`}
                onMouseEnter={() => setIdx(i)}
                onClick={() => c.run()}
              >
                <span className="cmdk-group">{c.group}</span>
                <span className="cmdk-label">{c.label}</span>
                {c.hint && <span className="cmdk-hint">{c.hint}</span>}
              </button>
            </li>
          ))}
        </ul>
        {filtered.length === 0 && <p className="cmdk-empty">没有匹配的命令。</p>}
        <p className="cmdk-foot">
          <kbd>↑</kbd>
          <kbd>↓</kbd> 选择 · <kbd>Enter</kbd> 执行 · <kbd>Esc</kbd> 关闭
          <span className="cmdk-count">{filtered.length} 条</span>
        </p>
      </div>
    </div>
  );
}
