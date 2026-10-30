import { useQuery } from '@tanstack/react-query';
import { api } from './lib/api';
import { qk } from './lib/query';
import { Login } from './components/Login';
import { Shell } from './components/Shell';

/**
 * 顶层门：会话是**服务端状态**，用 Query 管；不放进 zustand，也不放进组件本地 state。
 * 这样登录/登出/会话过期都只需要 `invalidateQueries(['session'])` 一处就够了。
 */
export default function App() {
  const session = useQuery({ queryKey: qk.session, queryFn: () => api.session() });

  if (session.isPending) {
    return <p className="hint boot">正在连接…</p>;
  }

  if (session.isError || !session.data) {
    return (
      <div className="panel error boot">
        <p>无法连接服务端：{session.error instanceof Error ? session.error.message : '未知错误'}</p>
        <button className="btn" onClick={() => void session.refetch()}>
          重试
        </button>
      </div>
    );
  }

  return session.data.authenticated ? <Shell session={session.data} /> : <Login />;
}
