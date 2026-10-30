import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
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
import { PrefsPanel } from './PrefsPanel';
import { CommandPalette } from './CommandPalette';

/**
 * 登录后的主壳：顶部工具条 + 左频道栏 + 条目列表 + 阅读层覆盖。
 * 自己只负责「谁登录了 / 怎么登出 / 外观落到 DOM 上」，数据展示下放给子组件。
 */
export function Shell({ session }: { session: Session }) {
  const qc = useQueryClient();
  const toast = useUi((s) => s.toast);
  const dismissToast = useUi((s) => s.dismissToast);
  const [adminOpen, setAdminOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [digestOpen, setDigestOpen] = useState(false);
  const navOpen = useUi((s) => s.navOpen);
  const toggleNav = useUi((s) => s.toggleNav);
  const closeNav = useUi((s) => s.closeNav);
  const settingsOpen = useUi((s) => s.settingsOpen);
  const setSettingsOpen = useUi((s) => s.setSettingsOpen);

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

  /* 布局偏好（视图 / 排序）从服务端回填到本地 store。
   *
   * ⚠️ **只回填一次**。prefs 会被反复 invalidate，如果每次数据变化都覆盖本地值，
   * 那么「用户刚点了网格、请求还没回来」时到达的那份旧数据会把选择打回列表视图 ——
   * 表现是「点了视图按钮，闪一下又变回去」。用 ref 锁住首帧即可：
   * 之后本地就是唯一真相，改动本身会写回服务端。 */
  const layoutHydrated = useRef(false);
  const layout = prefsQuery.data?.layout;
  useEffect(() => {
    if (!layout || layoutHydrated.current) return;
    layoutHydrated.current = true;
    useUi.getState().setView(layout.view);
    useUi.getState().setSort(layout.sort === 'name' ? 'name' : layout.sort);
  }, [layout]);

  /* 溢出菜单点空白处收起：它没有遮罩（挡住半个屏幕反而更难用），
   * 所以只能靠全局点击兜底。判断用 contains，点菜单内部不关。 */
  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e: MouseEvent): void => {
      const t = e.target as HTMLElement | null;
      if (!t?.closest('.topbar-more')) setMoreOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [moreOpen]);

  /* 抽屉开着时按 Esc 收起。与阅读层的 Esc 不冲突：打开条目会先把抽屉关掉。 */
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeNav();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navOpen, closeNav]);

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
        {/* 仅窄屏出现：桌面侧栏常驻，这个按钮不该占位置 */}
        <button
          className="btn ghost icon nav-toggle"
          onClick={toggleNav}
          aria-label={navOpen ? '收起频道栏' : '展开频道栏'}
          aria-expanded={navOpen}
          title="频道"
        >
          ☰
        </button>

        <div className="brand">
          <span className="login-mark small" aria-hidden />
          <strong>笺川</strong>
        </div>

        <div className="topbar-mid">
          <span className="pill">{unread} 未读</span>
          {/* 「只看未读」已移到列表工具条：它是**列表筛选**，和搜索、全部已读是一类；
              放在顶栏既撑爆 390px 顶栏，也让人以为它是全局开关。 */}
          <button
            className="btn ghost icon"
            onClick={() => refreshAll.mutate()}
            disabled={refreshAll.isPending}
            title="刷新全部开启采集的频道"
            aria-label="刷新全部频道"
          >
            {refreshAll.isPending ? '⟳…' : '⟳'}
          </button>
          {/* 命令面板入口。快捷键是 ⌘K / Ctrl+K，但**必须有按钮**：
              纯快捷键的功能等于只有作者知道（v1 后期才有这个按钮）。 */}
          <button
            className="btn ghost icon cmdk-btn"
            title="命令面板（⌘K / Ctrl+K）"
            aria-label="打开命令面板"
            onClick={() => window.dispatchEvent(new Event('feedlore:cmdk'))}
          >
            ⌘K
          </button>
        </div>

        <div className="topbar-right">
          {/* 账号自己关掉了日报入口时不显示。
              藏入口只是顺手，真正的开关在服务端（generate 会 400）—— 两处都在才算真关掉。 */}
          {prefsQuery.data?.layout.digestEnabled !== false && (
            <button
              className="btn ghost icon topbar-digest"
              onClick={() => setDigestOpen(true)}
              title="AI 日报：把过去 24 小时的条目汇总成一份简报"
              aria-label="打开日报"
            >
              ▤
            </button>
          )}
          <button
            className="btn ghost icon"
            onClick={() => setSettingsOpen(true)}
            title="外观与阅读设置"
            aria-label="打开设置"
          >
            Aa
          </button>
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
              className="btn ghost icon topbar-admin"
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
          <button
            className="btn ghost topbar-logout"
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
          >
            退出
          </button>

          {/* 窄屏溢出菜单：390px 宽的顶栏放不下「日报 / 管理 / 退出」三个，
              硬挤会换行（v1 修过一次），所以窄屏收进 ⋯ 里。桌面端这套菜单不显示。 */}
          <span className="topbar-more">
            <button
              className="btn ghost icon"
              aria-label="更多操作"
              aria-expanded={moreOpen}
              title="更多"
              onClick={() => setMoreOpen((v) => !v)}
            >
              ⋯
            </button>
            {moreOpen && (
              <div className="more-menu" role="menu">
                {prefsQuery.data?.layout.digestEnabled !== false && (
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMoreOpen(false);
                      setDigestOpen(true);
                    }}
                  >
                    AI 日报
                  </button>
                )}
                {session.role === 'admin' && (
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMoreOpen(false);
                      setAdminOpen(true);
                    }}
                  >
                    管理面板
                  </button>
                )}
                <button
                  role="menuitem"
                  disabled={logout.isPending}
                  onClick={() => {
                    setMoreOpen(false);
                    logout.mutate();
                  }}
                >
                  退出登录{session.username ? `（${session.username}）` : ''}
                </button>
              </div>
            )}
          </span>
        </div>
      </header>

      <div className="layout">
        <FeedsPanel />
        <EntriesPanel />
      </div>

      {/* 抽屉遮罩：点空白处收起。桌面端不渲染（navOpen 只可能由 ☰ 触发，而它仅窄屏可见） */}
      {navOpen && <div className="nav-scrim" onClick={closeNav} role="presentation" />}

      <EntryReader />
      <PrefsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <CommandPalette
        role={session.role}
        onOpenDigest={() => setDigestOpen(true)}
        onOpenAdmin={() => setAdminOpen(true)}
      />
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
