/* 账号面板的三个详情层（设备 / 用户 / 新增用户）：从 AccountPane.tsx 抽出，逐字对齐。 */

import type { AdminUser, Role, SessionDevice } from '@feedlore/contract';
import { useState } from 'react';
import { Dropdown } from '../views/Dropdown.tsx';
import {
  deviceLabel,
  fmtRel,
  type OpResult,
  type OpResultMaybe,
  ROLE_LABEL,
} from './AccountPane.utils.ts';
import { DetailSheet } from './DetailSheet.tsx';
import { Result } from './primitives.tsx';

/* ---------- 登录设备详情层 ---------- */
export function DeviceSheet({
  device,
  busy,
  onClose,
  onRevoke,
}: {
  device: SessionDevice;
  busy: boolean;
  onClose: () => void;
  onRevoke: (device: SessionDevice) => Promise<OpResultMaybe>;
}) {
  const [err, setErr] = useState('');
  const revoke = async () => {
    const res = await onRevoke(device);
    if (res && !res.ok) setErr(res.error || '退出失败');
  };
  return (
    <DetailSheet
      title={deviceLabel(device.userAgent)}
      subtitle={device.ip || '未知地址'}
      onClose={onClose}
      foot={
        !device.current ? (
          <button
            className="btn btn-danger"
            id="revokeDeviceBtn"
            type="button"
            disabled={busy}
            onClick={revoke}
          >
            {busy ? '退出中…' : '退出该设备'}
          </button>
        ) : null
      }
    >
      <div className="ds-stat">
        <div className="ds-stat-line">
          {device.current
            ? '当前设备 · 就是你现在用的这台浏览器'
            : '其它设备 · 退出后需要重新输入密码'}
        </div>
        <div className="ds-stat-line" title={device.lastSeenAt}>
          最近活跃 {fmtRel(device.lastSeenAt)}
          {device.createdAt ? ` · 登录于 ${String(device.createdAt).slice(0, 10)}` : ''}
        </div>
      </div>
      <small className="form-tip">
        「本机」按当前浏览器的登录 Cookie 判断；同一浏览器多开窗口算同一台设备。
        在这里退出只影响这台设备，其它设备与账号密码都不变。
      </small>
      <Result id="deviceSheetResult" result={err ? { ok: false, msg: err } : null} />
    </DetailSheet>
  );
}

/* ---------- 用户详情层（改角色 / 改密码 / 删除） ---------- */
export function UserSheet({
  user,
  busy,
  onClose,
  onRole,
  onPassword,
  onDelete,
}: {
  user: AdminUser;
  busy: boolean;
  onClose: () => void;
  onRole: (user: AdminUser, next: Role) => Promise<OpResult>;
  onPassword: (user: AdminUser, pass: string) => Promise<OpResult>;
  onDelete: (user: AdminUser) => Promise<OpResultMaybe>;
}) {
  const [pass, setPass] = useState('');
  const [err, setErr] = useState('');
  const self = !!user.isSelf;

  // Dropdown 是受控组件：value={user.role}，失败时 user.role 没变，显示自然回滚，
  // 不再需要原生 select 那种 roleRef.current.value 手动回滚。
  const changeRole = async (next: Role) => {
    if (next === user.role) return;
    setErr('');
    const res = await onRole(user, next);
    if (!res.ok) setErr(res.error || '角色修改失败');
  };

  const removeUser = async () => {
    setErr('');
    const res = await onDelete(user);
    if (res && !res.ok) setErr(res.error || '删除失败');
  };

  const submitPass = async () => {
    if (pass.length < 4) {
      setErr('密码至少 4 位');
      return;
    }
    setErr('');
    const res = await onPassword(user, pass);
    if (res.ok) setPass('');
    else setErr(res.error || '设置失败');
  };

  return (
    <DetailSheet
      title={user.username}
      subtitle={`${ROLE_LABEL[user.role] || user.role}${self ? ' · 当前账号' : ''}`}
      onClose={onClose}
      foot={
        <>
          {!self ? (
            <button
              className="btn btn-danger"
              id="delUserBtn"
              type="button"
              disabled={busy}
              onClick={removeUser}
            >
              删除用户
            </button>
          ) : null}
          <button className="btn" type="button" onClick={onClose}>
            完成
          </button>
        </>
      }
    >
      <div className="ds-stat">
        <div className="ds-stat-line">{Number(user.feedCount) || 0} 个订阅源</div>
      </div>

      {self ? (
        <p className="hint">
          当前登录的账号不能在这里改角色或删除；换用户名、改密码请用上方「登录信息」。
        </p>
      ) : (
        <>
          <div className="form-row">
            <label>角色</label>
            <Dropdown
              id="dsUserRole"
              wrapId="dsUserRoleDD"
              title="角色"
              ariaLabel="角色"
              value={user.role}
              disabled={busy}
              onChange={changeRole}
              options={[
                { value: 'user', label: '普通' },
                { value: 'readonly', label: '只读' },
                { value: 'admin', label: '管理员' },
              ]}
            />
            <small className="form-tip">
              管理员可管理用户与站点设置；普通用户管理自己的订阅源、模型与日报；只读只能阅读。改角色立即生效。
            </small>
          </div>

          <div className="form-row">
            <label htmlFor="dsUserPass">设置新密码</label>
            <input
              id="dsUserPass"
              type="password"
              placeholder="至少 4 位"
              autoComplete="new-password"
              value={pass}
              onChange={/** @param {*} [ev] */ (ev) => setPass(ev.target.value)}
              onKeyDown={
                /** @param {*} [ev] */ (ev) => {
                  if (ev.key === 'Enter') {
                    ev.preventDefault();
                    submitPass();
                  }
                }
              }
            />
            <button
              className="btn btn-ghost btn-sm"
              id="setUserPassBtn"
              type="button"
              style={{ marginTop: 'var(--sp-2)' }}
              disabled={busy || pass.length < 4}
              onClick={submitPass}
            >
              设置密码
            </button>
            <small className="form-tip">保存后立即生效，对方已登录的设备会被要求重新登录。</small>
          </div>

          <small className="form-tip">删除用户会一并删除其订阅源、条目与日报，且不可恢复。</small>
        </>
      )}

      <Result id="userSheetResult" result={err ? { ok: false, msg: err } : null} />
    </DetailSheet>
  );
}

/* ---------- 新增用户详情层 ---------- */
export function AddUserSheet({
  busy,
  onClose,
  onCreate,
}: {
  busy: boolean;
  onClose: () => void;
  onCreate: (name: string, pass: string, role: Role) => Promise<OpResult>;
}) {
  const [name, setName] = useState('');
  const [pass, setPass] = useState('');
  const [role, setRole] = useState<Role>('user');
  const [err, setErr] = useState('');

  const submit = async () => {
    const n = name.trim();
    if (!n) {
      setErr('请填写用户名');
      return;
    }
    if (pass.length < 4) {
      setErr('密码至少 4 位');
      return;
    }
    setErr('');
    const res = await onCreate(n, pass, role);
    if (!res.ok) setErr(res.error || '创建失败');
  };

  return (
    <DetailSheet
      title="添加用户"
      subtitle="新账号从空白的订阅源开始"
      onClose={onClose}
      foot={
        <>
          <button className="btn" type="button" onClick={onClose}>
            取消
          </button>
          <button
            className="btn btn-primary"
            id="createUserBtn"
            type="button"
            disabled={busy}
            onClick={submit}
          >
            {busy ? '添加中…' : '添加用户'}
          </button>
        </>
      }
    >
      <div className="form-row">
        <label htmlFor="newUserName">用户名</label>
        <input
          id="newUserName"
          type="text"
          placeholder="用户名"
          spellCheck="false"
          aria-label="新用户的用户名"
          autoComplete="off"
          value={name}
          onChange={/** @param {*} [ev] */ (ev) => setName(ev.target.value)}
          onKeyDown={
            /** @param {*} [ev] */ (ev) => {
              if (ev.key === 'Enter') {
                ev.preventDefault();
                submit();
              }
            }
          }
        />
      </div>
      <div className="form-row">
        <label htmlFor="newUserPass">密码</label>
        <input
          id="newUserPass"
          type="password"
          placeholder="至少 4 位"
          aria-label="新用户的密码"
          autoComplete="new-password"
          value={pass}
          onChange={/** @param {*} [ev] */ (ev) => setPass(ev.target.value)}
          onKeyDown={
            /** @param {*} [ev] */ (ev) => {
              if (ev.key === 'Enter') {
                ev.preventDefault();
                submit();
              }
            }
          }
        />
      </div>
      <div className="form-row">
        <label>角色</label>
        <Dropdown
          id="newUserRole"
          wrapId="newUserRoleDD"
          title="角色"
          ariaLabel="角色"
          value={role}
          onChange={(v: Role) => setRole(v)}
          options={[
            { value: 'user', label: '普通用户' },
            { value: 'readonly', label: '只读用户' },
            { value: 'admin', label: '管理员' },
          ]}
        />
        <small className="form-tip">
          每个用户拥有自己独立的订阅源、已读/收藏、日报与模型配置；角色之后还能改。
        </small>
      </div>
      <Result id="userSheetResult" result={err ? { ok: false, msg: err } : null} />
    </DetailSheet>
  );
}
