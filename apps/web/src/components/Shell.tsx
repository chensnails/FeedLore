import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { qk } from '../lib/query';
import { useUi } from '../store/ui';
import type { Session } from '../lib/types';
import { FeedsPanel } from './FeedsPanel';

/**
 * 登录后的主壳：顶部工具条 + 内容区。
 * 只负责「谁登录了 / 怎么登出」，数据展示下放给 FeedsPanel。
 */
export function Shell({ session }: { session: Session }) {
  const qc = useQueryClient();
  const onlyUnread = useUi((s) => s.onlyUnread);
  const toggleOnlyUnread = useUi((s) => s.toggleOnlyUnread);

  const feedsQuery = useQuery({
    queryKey: qk.feeds,
    queryFn: () => api.feeds.list(),
  });

  const logout = useMutation({
    mutationFn: () => api.logout(),
    onSettled: () => {
      qc.clear();
    },
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
            title="只看有未读的频道"
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

      <FeedsPanel />
    </div>
  );
}
