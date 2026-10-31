import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { applyAppearance } from '../lib/appearance';
import { qk } from '../lib/query';
import { useRefreshAll, useSaveLayout } from '../lib/mutations';
import { useRouteSync } from '../lib/route';
import { useUi } from '../store/ui';
import { Icon } from './Icon';
import type { Session } from '../lib/types';
import { FeedsPanel } from './FeedsPanel';
import { EntriesPanel } from './EntriesPanel';
import { EntryReader } from './EntryReader';
import { AdminPanel } from './AdminPanel';
import { DigestPanel } from './DigestPanel';
import { PrefsPanel } from './PrefsPanel';
import { CommandPalette } from './CommandPalette';
import { ConfirmDialog } from './ConfirmDialog';
import { SideResize, applySideWidth, SIDE_W_DEFAULT } from './SideResize';

/**
 * 登录后的主壳：顶部工具条 + 左频道栏 + 条目列表 + 阅读层覆盖。
 * 自己只负责「谁登录了 / 怎么登出 / 外观落到 DOM 上」，数据展示下放给子组件。
 */
export function Shell({ session }: { session: Session }) {
  const qc = useQueryClient();
  const toast = useUi((s) => s.toast);
  const dismissToast = useUi((s) => s.dismissToast);
  const [moreOpen, setMoreOpen] = useState(false);
  const navOpen = useUi((s) => s.navOpen);
  const toggleNav = useUi((s) => s.toggleNav);
  const closeNav = useUi((s) => s.closeNav);
  const panel = useUi((s) => s.panel);
  const setPanel = useUi((s) => s.setPanel);

  /* 地址栏 ↔ 状态 的接线（深链 + 后退）。放在壳里而不是 App：
   * 登录态才有「看的是哪个频道」这回事，登录页不该往地址栏写东西。 */
  useRouteSync();

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

  /* 抽屉开着时按 Esc 收起。与阅读层的 Esc 不冲突：打开条目会先把抽屉关掉。
   * 确认框在上层时让路 —— 那一层要吃掉 Esc，两层同时响应会「关了对话框也关了抽屉」。 */
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      if (useUi.getState().confirmState) return;
      closeNav();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navOpen, closeNav]);

  const refreshAll = useRefreshAll();
  const saveLayout = useSaveLayout();

  /* 频道栏宽度：读到偏好后写到 CSS 变量。拖拽手柄只改这个变量、松手才写服务端，
   * 所以这里的作用是「换设备/刷新后恢复」。CSS 里的兜底值就是默认值，
   * 首屏到偏好返回之间不会跳一下。
   *
   * resize 也要重算：宽度上限受「屏幕 40%」约束，从 1440 拖到 900 时侧栏必须跟着收窄，
   * 而从 900 拉回 1440 时也要还原成偏好值 —— 只 apply 一次的话它永远停在收窄后的样子。 */
  const sideW = prefsQuery.data?.layout.readerSideWidth ?? SIDE_W_DEFAULT;
  useEffect(() => {
    if (!prefsQuery.data) return undefined;
    applySideWidth(sideW);
    const onResize = (): void => applySideWidth(sideW);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [prefsQuery.data, sideW]);

  const logout = useMutation({
    mutationFn: () => api.logout(),
    onSettled: () => qc.clear(),
  });

  const unread = feedsQuery.data?.flags.unread ?? 0;

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
          <Icon name="menu" size={18} />
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
            <Icon name="refresh" size={16} className={refreshAll.isPending ? 'spin' : undefined} />
          </button>
          {/* 命令面板入口。快捷键是 ⌘K / Ctrl+K，但**必须有按钮**：
              纯快捷键的功能等于只有作者知道（v1 后期才有这个按钮）。 */}
          <button
            className="btn ghost icon cmdk-btn"
            title="命令面板（⌘K / Ctrl+K）"
            aria-label="打开命令面板"
            onClick={() => window.dispatchEvent(new Event('feedlore:cmdk'))}
          >
            <Icon name="command" size={16} />
          </button>
        </div>

        <div className="topbar-right">
          {/* 账号自己关掉了日报入口时不显示。
              藏入口只是顺手，真正的开关在服务端（generate 会 400）—— 两处都在才算真关掉。 */}
          {prefsQuery.data?.layout.digestEnabled !== false && (
            <button
              className="btn ghost icon topbar-digest"
              onClick={() => setPanel('digest')}
              title="AI 日报：把过去 24 小时的条目汇总成一份简报"
              aria-label="打开日报"
            >
              <Icon name="sparkle" size={16} />
            </button>
          )}
          <button
            className="btn ghost icon"
            onClick={() => setPanel('settings')}
            title="外观与阅读设置"
            aria-label="打开设置"
          >
            <Icon name="settings" size={17} />
          </button>
          {session.role === 'admin' && (
            <button
              className="btn ghost icon topbar-admin"
              onClick={() => setPanel('admin')}
              title="用户管理"
              aria-label="打开用户管理"
            >
              <Icon name="shield" size={16} />
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
              <Icon name="more" size={18} />
            </button>
            {moreOpen && (
              <div className="more-menu" role="menu">
                {prefsQuery.data?.layout.digestEnabled !== false && (
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMoreOpen(false);
                      setPanel('digest');
                    }}
                  >
                    <Icon name="sparkle" size={15} />
                    AI 日报
                  </button>
                )}
                {session.role === 'admin' && (
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMoreOpen(false);
                      setPanel('admin');
                    }}
                  >
                    <Icon name="shield" size={15} />
                    用户管理
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
                  <Icon name="arrow-right" size={15} />
                  退出登录{session.username ? `（${session.username}）` : ''}
                </button>
              </div>
            )}
          </span>
        </div>
      </header>

      {/* 三列：频道栏 · 拖拽手柄 · 列表。
          手柄单独占一列而不是贴边绝对定位 —— `.sidebar` 是 overflow:auto，
          贴边的手柄会被裁掉一半热区。 */}
      <div className="layout">
        <FeedsPanel />
        <SideResize width={sideW} onCommit={(w) => saveLayout.mutate({ readerSideWidth: w })} />
        <EntriesPanel />
      </div>

      {/* 抽屉遮罩：点空白处收起。桌面端不渲染（navOpen 只可能由 ☰ 触发，而它仅窄屏可见） */}
      {navOpen && <div className="nav-scrim" onClick={closeNav} role="presentation" />}

      <EntryReader />
      <PrefsPanel open={panel === 'settings'} onClose={() => setPanel(null)} />
      <CommandPalette
        role={session.role}
        onOpenDigest={() => setPanel('digest')}
        onOpenAdmin={() => setPanel('admin')}
      />
      <AdminPanel open={panel === 'admin'} onClose={() => setPanel(null)} />
      <DigestPanel open={panel === 'digest'} onClose={() => setPanel(null)} />

      {/* 确认框放在最后：DOM 顺序即层叠顺序，它在所有面板之上 */}
      <ConfirmDialog />

      {toast && (
        <div className={`toast ${toast.tone}`} role="status" onClick={dismissToast}>
          <Icon name={toast.tone === 'error' ? 'alert' : 'check'} size={14} />
          {toast.text}
        </div>
      )}
    </div>
  );
}
