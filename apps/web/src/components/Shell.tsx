import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { applyAppearance } from '../lib/appearance';
import { qk } from '../lib/query';
import { useRefreshAll, useSaveAppearance } from '../lib/mutations';
import { useUi } from '../store/ui';
import type { Session } from '../lib/types';
import { FeedsPanel } from './FeedsPanel';
import { EntriesPanel } from './EntriesPanel';
import { EntryReader } from './EntryReader';
import { AdminPanel } from './AdminPanel';
import { DigestPanel } from './DigestPanel';

/**
 * 登录后的主壳：顶部工具条 + 左频道栏 + 条目列表 + 阅读层覆盖。
 * 自己只负责「谁登录了 / 怎么登出 / 外观落到 DOM 上」，数据展示下放给子组件。
 */
export function Shell({ session }: { session: Session }) {
  const qc = useQueryClient();
  const onlyUnread = useUi((s) => s.onlyUnread);
  const toggleOnlyUnread = useUi((s) => s.toggleOnlyUnread);
  const toast = useUi((s) => s.toast);
  const dismissToast = useUi((s) => s.dismissToast);
  const [adminOpen, setAdminOpen] = useState(false);
  const [digestOpen, setDigestOpen] = useState(false);

  const feedsQuery = useQuery({ queryKey: qk.feeds, queryFn: () => api.feeds.list() });

  /**
   * 偏好是**服务端状态**（按账号存库），但它的作用是驱动 DOM 外观，
   * 拿到后写进 data-theme / CSS 变量即可，不必再往组件树里一层层传 props。
   */
  const prefsQuery = useQuery({
    queryKey: qk.prefs,
    queryFn: () => api.prefs.get(),
    staleTime: 5 * 60_000,
  });
  useEffect(() => {
    if (prefsQuery.data) applyAppearance(prefsQuery.data.appearance);
  }, [prefsQuery.data]);

  const saveAppearance = useSaveAppearance();
  const refreshAll = useRefreshAll();

  const logout = useMutation({
    mutationFn: () => api.logout(),
    onSettled: () => qc.clear(),
  });

  const unread = feedsQuery.data?.flags.unread ?? 0;

  /* 主题三态循环：auto → light → dark → auto。
   * 'github' 是 v1.x 遗留值，按深色展示，点一次就切到 auto（等价于「用户开始用新主题」）。 */
  const theme = prefsQuery.data?.appearance.theme ?? 'auto';
  const THEMES = [
    { value: 'auto', icon: '◐', label: '跟随系统' },
    { value: 'light', icon: '☀', label: '浅色' },
    { value: 'dark', icon: '☾', label: '深色' },
  ] as const;
  const themeIdx = THEMES.findIndex((t) => t.value === theme);
  const nextTheme = THEMES[(themeIdx + 1) % THEMES.length] ?? THEMES[0];
  const themeIcon = theme === 'light' ? '☀' : theme === 'dark' ? '☾' : '◐';

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="login-mark small" aria-hidden />
          <strong>笺川</strong>
        </div>

        <div className="topbar-mid">
          <span className="pill">{unread} 未读</span>
          <button
            className={`chip${onlyUnread ? ' on' : ''}`}
            onClick={toggleOnlyUnread}
            title="只看未读"
          >
            只看未读
          </button>
          <button
            className="btn ghost icon"
            onClick={() => refreshAll.mutate()}
            disabled={refreshAll.isPending}
            title="刷新全部开启采集的频道"
            aria-label="刷新全部频道"
          >
            {refreshAll.isPending ? '⟳…' : '⟳'}
          </button>
        </div>

        <div className="topbar-right">
          {/* 账号自己关掉了日报入口时不显示。
              藏入口只是顺手，真正的开关在服务端（generate 会 400）—— 两处都在才算真关掉。 */}
          {prefsQuery.data?.layout.digestEnabled !== false && (
            <button
              className="btn ghost icon"
              onClick={() => setDigestOpen(true)}
              title="AI 日报：把过去 24 小时的条目汇总成一份简报"
              aria-label="打开日报"
            >
              ▤
            </button>
          )}
          <button
            className="btn ghost icon"
            onClick={() => saveAppearance.mutate({ theme: nextTheme.value })}
            disabled={saveAppearance.isPending || prefsQuery.isPending}
            title={`主题：${theme}（点击切换到 ${nextTheme.label}）`}
            aria-label="切换主题"
          >
            {themeIcon}
          </button>
          {session.role === 'admin' && (
            <button
              className="btn ghost icon"
              onClick={() => setAdminOpen(true)}
              title="管理：状态 / 采集参数 / 用户"
              aria-label="打开管理面板"
            >
              ⚙
            </button>
          )}
          <span className="who">
            {session.username}
            {session.role === 'admin' && <em>管理员</em>}
          </span>
          <button className="btn ghost" onClick={() => logout.mutate()} disabled={logout.isPending}>
            退出
          </button>
        </div>
      </header>

      <div className="layout">
        <FeedsPanel />
        <EntriesPanel />
      </div>

      <EntryReader />
      <AdminPanel open={adminOpen} onClose={() => setAdminOpen(false)} />
      <DigestPanel open={digestOpen} onClose={() => setDigestOpen(false)} />

      {toast && (
        <div className={`toast ${toast.tone}`} role="status" onClick={dismissToast}>
          {toast.text}
        </div>
      )}
    </div>
  );
}
