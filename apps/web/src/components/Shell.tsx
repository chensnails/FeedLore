import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api } from '../lib/api';
import { applyAppearance } from '../lib/appearance';
import { qk } from '../lib/query';
import { useUi } from '../store/ui';
import type { Session } from '../lib/types';
import { FeedsPanel } from './FeedsPanel';
import { EntriesPanel } from './EntriesPanel';
import { EntryReader } from './EntryReader';

/**
 * 登录后的主壳：顶部工具条 + 左频道栏 + 条目列表 + 阅读层覆盖。
 * 自己只负责「谁登录了 / 怎么登出 / 外观落到 DOM 上」，数据展示下放给子组件。
 */
export function Shell({ session }: { session: Session }) {
  const qc = useQueryClient();
  const onlyUnread = useUi((s) => s.onlyUnread);
  const toggleOnlyUnread = useUi((s) => s.toggleOnlyUnread);

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

  const logout = useMutation({
    mutationFn: () => api.logout(),
    onSettled: () => qc.clear(),
  });

  const unread = feedsQuery.data?.flags.unread ?? 0;

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
        </div>

        <div className="topbar-right">
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
    </div>
  );
}
