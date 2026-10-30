import { useState } from 'react';
import { useSaveAccount } from '../lib/mutations';

/**
 * 改自己的密码 / 用户名。改完当前会话保持有效（不踢自己下线）。
 *
 * 独立成文件是因为它有两个入口：管理面板（顺手给的「我的账号」）与设置面板的「账号」页。
 * 普通用户进不去管理面板，设置面板是**唯一**的改密路径 —— 两份实现早晚会分叉。
 *
 * 三个字段都可选，但「当前密码」必须填：服务端拿它验证身份，
 * 只凭 cookie 就能改密等于把 CSRF 的后果放大成账号接管。
 */
export function AccountForm() {
  const [current, setCurrent] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const save = useSaveAccount();

  const submit = (): void => {
    if (!current) return;
    save.mutate(
      {
        currentPassword: current,
        ...(username.trim() ? { username: username.trim() } : {}),
        ...(password ? { newPassword: password } : {}),
      },
      {
        onSuccess: () => {
          setCurrent('');
          setPassword('');
          setUsername('');
        },
      },
    );
  };

  return (
    <>
      <div className="admin-create">
        <input
          type="password"
          placeholder="当前密码（必填）"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
        <input placeholder="新用户名（可选）" value={username} onChange={(e) => setUsername(e.target.value)} />
        <input
          type="password"
          placeholder="新密码（可选）"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button
          className="btn"
          onClick={submit}
          disabled={save.isPending || !current || (!username.trim() && !password)}
        >
          {save.isPending ? '提交中…' : '更新'}
        </button>
      </div>
      <p className="hint tiny">用户名与新密码至少填一项；改完不会把其他设备踢下线。</p>
    </>
  );
}
