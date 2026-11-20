/* 账号面板的四个展示分组（登录 / 设备 / 用户 / 安装）：从 AccountPane.tsx 抽出，DOM 逐字对齐。 */

import type { AdminUser, SessionDevice } from '@feedlore/contract';
import { deviceLabel, fmtRel, openOnKey, ROLE_LABEL } from './AccountPane.utils.ts';
import { EditToggle, ReadonlyField, Result, type ResultData, Section } from './primitives.tsx';

/* ---------- 设备行 ---------- */
const DeviceRow = ({ d, onOpen }: { d: SessionDevice; onOpen: (id: string) => void }) => (
  <div
    className={'sl-row' + (d.current ? ' is-current' : '')}
    key={d.id}
    data-session-id={d.id}
    role="button"
    tabIndex={0}
    aria-label={`${deviceLabel(d.userAgent)}：查看设备详情`}
    onClick={() => onOpen(d.id)}
    onKeyDown={openOnKey(() => onOpen(d.id))}
  >
    <span className="sl-ava">
      <svg className="ico" aria-hidden="true" focusable="false">
        <use href="#i-activity" />
      </svg>
    </span>
    <div className="sl-main">
      <div className="sl-name">{deviceLabel(d.userAgent)}</div>
      <div className="sl-sub" title={d.lastSeenAt}>
        {d.ip || '未知地址'} · {fmtRel(d.lastSeenAt)}活跃
      </div>
    </div>
    <span className="sl-side">
      {d.current ? <span className="sl-badge muted">本机</span> : null}
    </span>
    <svg className="ico feed-caret" aria-hidden="true" focusable="false">
      <use href="#i-chevron-right" />
    </svg>
  </div>
);

/* ---------- 用户行 ---------- */
const UserRow = ({ u, onOpen }: { u: AdminUser; onOpen: (id: string) => void }) => (
  <div
    className="sl-row"
    key={u.id}
    data-uid={u.id}
    role="button"
    tabIndex={0}
    aria-label={`${u.username}：查看账号详情`}
    onClick={() => onOpen(u.id)}
    onKeyDown={openOnKey(() => onOpen(u.id))}
  >
    <span className="sl-ava">
      <svg className="ico" aria-hidden="true" focusable="false">
        <use href="#i-user" />
      </svg>
    </span>
    <div className="sl-main">
      <div className="sl-name">{u.username}</div>
      <div className="sl-sub">
        {Number(u.feedCount) || 0} 个源{u.isSelf ? ' · 当前账号' : ''}
      </div>
    </div>
    <span className="sl-side">
      <span className={'sl-badge' + (u.role === 'admin' ? '' : ' muted')}>
        {ROLE_LABEL[u.role] || u.role}
      </span>
    </span>
    <svg className="ico feed-caret" aria-hidden="true" focusable="false">
      <use href="#i-chevron-right" />
    </svg>
  </div>
);

/* ---------- 登录信息 ---------- */
export interface LoginSectionProps {
  readonly: boolean;
  editLogin: 'name' | 'pass' | null;
  username: string;
  savedName: string;
  current: string;
  newPass: string;
  setUsername: (v: string) => void;
  setCurrent: (v: string) => void;
  setNewPass: (v: string) => void;
  setEditLogin: (v: 'name' | 'pass' | null) => void;
  closeEditLogin: () => void;
}

export function LoginSection({
  readonly,
  editLogin,
  username,
  savedName,
  current,
  newPass,
  setUsername,
  setCurrent,
  setNewPass,
  setEditLogin,
  closeEditLogin,
}: LoginSectionProps) {
  return (
    <Section
      secKey="acc-login"
      title="登录信息"
      open
      sub={savedName ? `当前用户 ${savedName}` : ''}
    >
      {readonly ? (
        <>
          <ReadonlyField label="用户名" value={username} />
          <div className="hint">
            只读账户：只能阅读，不能修改订阅源、规则、模型或日报配置；用户名和密码由管理员维护。
          </div>
        </>
      ) : !editLogin ? (
        /* 默认只读：把「能改什么」摆出来，但输入框必须点一下才出现，
           避免在设置页里随手就把账号信息改掉。 */
        <>
          <ReadonlyField label="用户名" value={savedName} />
          <ReadonlyField label="密码" value="已设置" hint="修改时需要先验证当前密码" />
          <div className="ro-actions">
            <EditToggle
              id="accEditNameBtn"
              editText="修改用户名"
              onClick={() => setEditLogin('name')}
            />
            <EditToggle
              id="accEditPassBtn"
              editText="修改密码"
              onClick={() => setEditLogin('pass')}
            />
          </div>
        </>
      ) : (
        /* 展开后一次能看到三项：想改哪个点哪个入口，分组只有一个编辑态 */
        <>
          <div className="form-row">
            <label htmlFor="accUsername">用户名</label>
            <input
              id="accUsername"
              type="text"
              spellCheck="false"
              value={username}
              onChange={/** @param {*} [e] */ (e) => setUsername(e.target.value)}
            />
          </div>
          <div className="form-row">
            <label htmlFor="accCurrent">
              当前密码 <span className="req">*</span>
            </label>
            <input
              id="accCurrent"
              type="password"
              placeholder="修改密码时需验证当前密码"
              autoComplete="current-password"
              value={current}
              onChange={/** @param {*} [e] */ (e) => setCurrent(e.target.value)}
            />
          </div>
          <div className="form-row">
            <label htmlFor="accNew">新密码</label>
            <input
              id="accNew"
              type="password"
              placeholder="留空则不修改，至少 4 位"
              autoComplete="new-password"
              value={newPass}
              onChange={/** @param {*} [e] */ (e) => setNewPass(e.target.value)}
            />
          </div>
          <div className="ro-actions">
            <EditToggle editing closeText="收起" onClick={closeEditLogin} editText="修改密码" />
            <span className="ro-actions-hint">改完点下方「保存账号」生效</span>
          </div>
        </>
      )}
    </Section>
  );
}

/* ---------- 登录设备 ---------- */
export interface DevicesSectionProps {
  devResult: ResultData | null;
  devicesError: string;
  devicesLoaded: boolean;
  devices: SessionDevice[];
  loadDevices: () => Promise<void>;
  onOpenDevice: (id: string) => void;
  revoking: string;
  revokeOthers: () => void;
  otherDevices: number;
}

export function DevicesSection({
  devResult,
  devicesError,
  devicesLoaded,
  devices,
  loadDevices,
  onOpenDevice,
  revoking,
  revokeOthers,
  otherDevices,
}: DevicesSectionProps) {
  return (
    <Section
      secKey="acc-devices"
      title="登录设备"
      open
      sub={!devicesLoaded ? '读取中…' : devices.length ? `${devices.length} 台` : '仅本机'}
    >
      <Result id="devResult" result={devResult} />
      {devicesError ? (
        <div className="hint pane-msg">
          {devicesError}
          <button className="btn btn-ghost btn-sm" type="button" onClick={loadDevices}>
            重试
          </button>
        </div>
      ) : !devicesLoaded ? (
        <div className="hint">正在读取登录设备…</div>
      ) : (
        <>
          <div className="sl-list" id="deviceList">
            {devices.map((d) => (
              <DeviceRow key={d.id} d={d} onOpen={onOpenDevice} />
            ))}
          </div>
          <div className="sl-toolbar">
            {otherDevices ? (
              <button
                className="btn btn-ghost btn-sm"
                id="revokeOtherSessionsBtn"
                type="button"
                disabled={revoking === 'others'}
                onClick={revokeOthers}
              >
                {revoking === 'others' ? '退出中…' : `退出其它设备（${otherDevices} 台）`}
              </button>
            ) : null}
            <span className="sl-toolbar-note">「本机」按当前浏览器判断；逐台退出用行详情</span>
          </div>
        </>
      )}
    </Section>
  );
}

/* ---------- 用户管理 ---------- */
export interface UsersSectionProps {
  userResult: ResultData | null;
  usersSub: string;
  usersLoaded: boolean;
  usersError: string;
  loadUsers: () => Promise<void>;
  users: AdminUser[];
  onOpenUser: (id: string) => void;
  userBusy: string;
  onAddUser: () => void;
}

export function UsersSection({
  userResult,
  usersSub,
  usersLoaded,
  usersError,
  loadUsers,
  users,
  onOpenUser,
  userBusy,
  onAddUser,
}: UsersSectionProps) {
  return (
    <Section secKey="acc-users" id="accUsersSec" title="用户管理" open sub={usersSub}>
      <Result id="userResult" result={userResult} />
      {!usersLoaded ? (
        <div className="hint">正在读取用户…</div>
      ) : usersError ? (
        <div className="hint pane-msg">
          {usersError}
          <button className="btn btn-ghost btn-sm" type="button" onClick={loadUsers}>
            重试
          </button>
        </div>
      ) : !users.length ? (
        <div className="sl-empty">还没有用户</div>
      ) : (
        <div className="sl-list" id="userList">
          {users.map((u) => (
            <UserRow key={u.id} u={u} onOpen={onOpenUser} />
          ))}
        </div>
      )}

      <div className="sl-toolbar">
        <button
          className="btn btn-ghost btn-sm"
          id="addUserBtn"
          type="button"
          disabled={userBusy === 'add'}
          onClick={onAddUser}
        >
          <svg className="ico" aria-hidden="true" focusable="false">
            <use href="#i-plus" />
          </svg>
          添加用户
        </button>
        <span className="sl-toolbar-note">每个账号的订阅源、已读与日报相互独立</span>
      </div>

      <small className="form-tip">
        点行可改角色、重置密码或删除。
        <br />
        <b>管理员</b>：额外可管理用户与全局设置。
        <br />
        <b>普通用户</b>：管理自己的订阅源、模型与日报。
        <br />
        <b>只读用户</b>
        ：只能阅读，不能修改订阅源、规则、模型、日报等配置，也不能自行修改用户名和密码。
      </small>
    </Section>
  );
}

/* ---------- 添加到手机 ---------- */
export function InstallSection({ onInstall }: { onInstall: () => void }) {
  return (
    <Section secKey="acc-install" advanced title="添加到手机" sub="装到桌面，像 App 一样打开">
      <p className="install-card-tip">
        用手机浏览器打开 <code id="installHost">{location.host}</code>
        ，在浏览器菜单里选「安装应用 / 添加到主屏幕」即可。
        <br />
        Edge / Chrome：右上角「⋯」→ 添加到手机 / 安装应用；iOS Safari：分享 → 添加到主屏幕。
      </p>
      <button className="btn btn-ghost btn-sm install-trigger" type="button" onClick={onInstall}>
        一键安装（浏览器支持时）
      </button>
    </Section>
  );
}
