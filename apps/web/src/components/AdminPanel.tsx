import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { qk } from '../lib/query';
import {
  useCreateUser,
  useDeleteUser,
  usePatchUser,
} from '../lib/mutations';
import { useOverlayFocus } from '../lib/useOverlayFocus';
import { AccountForm } from './AccountForm';
import { useUi } from '../store/ui';
import { Icon } from './Icon';

/**
 * 用户管理面板（仅管理员可见）。
 *
 * 权限边界（见需求「权限控制」）：管理员角色 = 普通用户全部权限 + **仅**用户账户管理。
 * 因此本面板只承载账号增删改、改角色、重置密码、以及当前账号自身的设置（AccountForm）。
 * 原「状态 / 采集参数 / 关于」三个系统级页签已按权限收口移除——它们既不属于用户账户管理，
 * 普通用户也无此权限，按「管理员不得额外扩展任何功能」的要求不再对管理员开放。
 *
 * 刻意做成覆盖层而不是独立路由：v2 前端还没有路由（单页 + 覆盖层），引入路由会把
 * 「刷新后回到哪个视图」这个新问题一起引进来，当前不值得。
 */

export function AdminPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const sheetRef = useRef<HTMLElement>(null);
  useOverlayFocus(open, sheetRef);

  // Esc 关闭：与阅读层一致，键盘用户不该只能去找那个叉
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="reader-backdrop" onClick={onClose} role="presentation">
      <section className="admin-sheet" ref={sheetRef} onClick={(e) => e.stopPropagation()}>
        <button className="reader-close btn ghost icon" onClick={onClose} aria-label="关闭">
          <Icon name="close" size={16} />
        </button>

        <h2 className="admin-title">用户管理</h2>

        <UsersTab />
      </section>
    </div>
  );
}

/* ============================ 用户账户管理 ============================ */

function UsersTab() {
  const usersQuery = useQuery({ queryKey: qk.adminUsers, queryFn: () => api.admin.users.list() });
  const askConfirm = useUi((s) => s.askConfirm);
  const create = useCreateUser();
  const patch = usePatchUser();
  const del = useDeleteUser();

  const [name, setName] = useState('');
  const [pw, setPw] = useState('');
  const [role, setRole] = useState<'user' | 'admin'>('user');
  /** 正在重置密码的用户 id（行内输入框，避免用 prompt 弹窗打断流程） */
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [resetPw, setResetPw] = useState('');

  if (usersQuery.isPending) return <p className="hint">读取用户…</p>;
  if (usersQuery.isError) {
    return <p className="hint error-text">用户读取失败：{String((usersQuery.error as Error)?.message ?? '未知错误')}</p>;
  }

  const users = usersQuery.data;

  const submitCreate = (): void => {
    if (!name.trim() || pw.length < 4) return;
    create.mutate({ username: name.trim(), password: pw, role }, {
      onSuccess: () => {
        setName('');
        setPw('');
        setRole('user');
      },
    });
  };

  return (
    <div className="admin-body">
      <table className="admin-table">
        <thead>
          <tr>
            <th>用户名</th>
            <th>角色</th>
            <th>频道</th>
            <th>创建时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>
                {u.username}
                {u.isSelf && <span className="hint tiny">（当前登录）</span>}
              </td>
              <td>
                <select
                  className="input sm"
                  value={u.role}
                  onChange={(e) => patch.mutate({ id: u.id, body: { role: e.target.value as 'user' | 'admin' } })}
                  disabled={patch.isPending}
                  aria-label={`${u.username} 的角色`}
                >
                  <option value="user">普通用户</option>
                  <option value="admin">管理员</option>
                </select>
              </td>
              <td className="tab-num">{u.feedCount}</td>
              <td className="hint tiny">{u.createdAt ? new Date(u.createdAt).toLocaleDateString('zh-CN') : '—'}</td>
              <td className="admin-row-actions">
                {resetFor === u.id ? (
                  <>
                    <input
                      className="input sm admin-inline-input"
                      type="password"
                      placeholder="新密码"
                      value={resetPw}
                      onChange={(e) => setResetPw(e.target.value)}
                    />
                    <button
                      className="btn ghost sm"
                      disabled={resetPw.length < 4 || patch.isPending}
                      onClick={() =>
                        patch.mutate(
                          { id: u.id, body: { password: resetPw } },
                          {
                            onSuccess: () => {
                              setResetFor(null);
                              setResetPw('');
                            },
                          },
                        )
                      }
                    >
                      确认
                    </button>
                    <button className="btn ghost sm" onClick={() => setResetFor(null)}>
                      取消
                    </button>
                  </>
                ) : (
                  <button className="btn ghost sm" onClick={() => setResetFor(u.id)}>
                    重置密码
                  </button>
                )}
                <button
                  className="btn ghost sm danger"
                  disabled={u.isSelf || del.isPending}
                  title={u.isSelf ? '不能删除当前登录的账号' : '删除该用户及其全部订阅'}
                  onClick={() => {
                    void (async () => {
                      const ok = await askConfirm({
                        title: `删除用户「${u.username}」？`,
                        body: '其订阅与条目会一起删除，不可恢复。',
                        okText: '删除',
                        danger: true,
                      });
                      if (ok) del.mutate(u.id);
                    })();
                  }}
                >
                  删除
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 className="admin-h3">新增用户</h3>
      <div className="admin-create">
        <input className="input" placeholder="用户名" value={name} onChange={(e) => setName(e.target.value)} />
        <input
          className="input"
          placeholder="初始密码（至少 4 位）"
          type="password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
        />
        <select className="input" value={role} onChange={(e) => setRole(e.target.value as 'user' | 'admin')} aria-label="新用户角色">
          <option value="user">普通用户</option>
          <option value="admin">管理员</option>
        </select>
        <button className="btn sm" onClick={submitCreate} disabled={create.isPending || !name.trim() || pw.length < 4}>
          {create.isPending ? '创建中…' : '创建'}
        </button>
      </div>
      <p className="hint tiny">用户名可用字母、数字与 . _ - @，最长 40 位。登录用用户名，不用邮箱。</p>

      <h3 className="admin-h3">我的账号</h3>
      <AccountForm />
    </div>
  );
}
