import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { qk } from '../lib/query';
import { BrandLogo } from './BrandLogo';

/**
 * 登录页。刻意保持极简：一个表单 + 一个内联错误位。
 * 错误文案直接用服务端返回（`用户名或密码错误`），不在前端另造一套，避免两边不一致。
 */
export function Login() {
  const qc = useQueryClient();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const login = useMutation({
    mutationFn: () => api.login({ username, password }),
    onSuccess: () => {
      // 会话变了：把会话与依赖会话的数据一起失效，避免「已登录但仍看到旧 401 缓存」
      void qc.invalidateQueries({ queryKey: qk.session });
      void qc.invalidateQueries({ queryKey: qk.feeds });
    },
  });

  const err =
    login.error instanceof ApiError
      ? login.error.message
      : login.error
        ? '登录失败，请稍后重试'
        : null;

  return (
    <main className="login">
      <form
        className="login-card"
        onSubmit={(e) => {
          e.preventDefault();
          login.mutate();
        }}
      >
        <div className="login-brand">
          <BrandLogo className="login-logo" />
          <h1>笺川</h1>
        </div>
        <p className="login-sub">FeedLore · 自托管阅读</p>

        <label className="field">
          <span>用户名</span>
          <input
            autoFocus
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>

        <label className="field">
          <span>密码</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        {err && (
          <p className="login-err" role="alert">
            {err}
          </p>
        )}

        <button className="btn primary" disabled={login.isPending || !username || !password}>
          {login.isPending ? '登录中…' : '登录'}
        </button>
      </form>
    </main>
  );
}
