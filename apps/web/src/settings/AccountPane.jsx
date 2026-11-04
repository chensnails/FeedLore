/* 设置弹层「账号」面板（v1.6.0 起 React 化，原 index.html 内联 DOM + app.js 绑定迁移至此，P2d）。
 *
 * 迁移说明（对照旧实现）：
 * - 登录信息（改用户名 / 密码）、用户管理（仅管理员）、添加到手机、退出登录，四块能力原样搬运；
 * - 表单由受控状态管理（旧实现裸读 DOM .value）；
 * - 结果提示内联在组件里（旧 showResult 的 test-result + 4s 自动清除语义保留）；
 * - 用户管理对同一份列表做乐观 UI：操作成功后重新拉取（与旧 loadUserList 一致），
 *   危险操作（删除）仍走浏览器 confirm，改密码走 prompt（保持与旧实现一致）；
 * - 类名 / ID / data 属性与旧 DOM 完全一致，样式零改动；可折叠分组（details.sec）
 *   的开合仍按账号持久化，经桥 bindSections 复用同一机制。
 */

import { core } from '@core';
import React, { useEffect, useRef, useState } from 'react';
import { PaneFoot, Result, Section, useResult } from './primitives.jsx';

const S = () => core;   // 核心逻辑单例（@core，v2.0.0 起改为模块引用）

const ROLE_LABEL = { admin: '管理员', user: '普通', readonly: '只读' };

/** UA 只取「浏览器 · 系统」两段，原文太长且没人读得懂；认不出就截断原文兜底。 */
function deviceLabel(ua) {
  if (!ua) return '未知设备';
  const os = /Windows NT/.test(ua) ? 'Windows'
    : /iPhone|iPad|iPod/.test(ua) ? 'iOS'
      : /Android/.test(ua) ? 'Android'
        : /Mac OS X/.test(ua) ? 'macOS'
          : /Linux/.test(ua) ? 'Linux' : '';
  const br = /Edg\//.test(ua) ? 'Edge'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
      : /Firefox\//.test(ua) ? 'Firefox'
        : /Chrome\//.test(ua) ? 'Chrome'
          : /Safari\//.test(ua) ? 'Safari' : '';
  if (br || os) return [br, os].filter(Boolean).join(' · ');
  return ua.length > 48 ? ua.slice(0, 48) + '…' : ua;
}

/** 最近活跃时间按相对量显示；超过 30 天回落到日期，绝对时间留在 title 里。 */
function fmtRel(iso) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  const diff = Date.now() - t;
  if (diff < 60e3) return '刚刚';
  if (diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前';
  if (diff < 86400e3) return Math.floor(diff / 3600e3) + ' 小时前';
  if (diff < 30 * 86400e3) return Math.floor(diff / 86400e3) + ' 天前';
  return iso.slice(0, 10);
}

export function AccountPane({ onDirtyChange }) {
  const s = S();
  const admin = !!(s && s.isAdmin && s.isAdmin());
  // 只读账户：只能阅读；配置项全部由服务端拒绝，账号凭据由管理员掌握
  const readonly = !!(s && s.state && s.state.role === 'readonly');
  const paneRef = useRef(null);

  // 登录信息
  const [username, setUsername] = useState('');
  const [savedName, setSavedName] = useState('');
  const [current, setCurrent] = useState('');
  const [newPass, setNewPass] = useState('');
  const [saving, setSaving] = useState(false);
  const [accResult, showAccResult, clearAccResult] = useResult();

  // 用户管理
  const [users, setUsers] = useState([]);
  const [usersLoaded, setUsersLoaded] = useState(false);
  const [usersError, setUsersError] = useState('');
  const [newUserName, setNewUserName] = useState('');
  const [newUserPass, setNewUserPass] = useState('');
  const [newUserRole, setNewUserRole] = useState('user');
  const [addingUser, setAddingUser] = useState(false);
  const [userResult, showUserResult] = useResult();

  // 登录设备（会话）：所有角色都能看自己的设备并逐台退出
  const [devices, setDevices] = useState([]);
  const [devicesLoaded, setDevicesLoaded] = useState(false);
  const [devicesError, setDevicesError] = useState('');
  const [revoking, setRevoking] = useState('');
  const [devResult, showDevResult] = useResult();

  // 数据导出：模型 Key 默认不打包，勾选才附带（导出的是明文，提示放在勾选项下）
  const [inclLlm, setInclLlm] = useState(false);

  // 进入面板：回填登录信息（旧 loadAccountForm），管理员再拉一次用户列表
  useEffect(() => {
    const st = (s && s.state) || {};
    const name = st.username || '';
    setUsername(name);
    setSavedName(name);
    loadDevices();
    if (admin) loadUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 可折叠分组的开合按账号持久化（与旧 bindSections 同一机制）
  useEffect(() => {
    if (s && s.bindSections && paneRef.current) s.bindSections(paneRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadUsers() {
    try {
      const res = await s.apiFetch('/api/users');
      if (!res.ok) throw await s.httpError(res);
      const data = await res.json();
      setUsers(data.users || []);
      setUsersError('');
    } catch (err) {
      setUsersError('读取用户失败：' + String((err && err.message) || err));
    } finally {
      setUsersLoaded(true);
    }
  }

  async function loadDevices() {
    try {
      const res = await s.apiFetch('/api/sessions');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(s.errText(data, 'HTTP ' + res.status));
      setDevices(data.sessions || []);
      setDevicesError('');
    } catch (err) {
      setDevicesError('读取登录设备失败：' + String((err && err.message) || err));
    } finally {
      setDevicesLoaded(true);
    }
  }

  async function revokeDevice(d) {
    const ok = await s.confirm({
      title: '退出这台设备？',
      desc: `${deviceLabel(d.userAgent)}（${d.ip || '未知地址'}）会立即失去登录状态，需要重新输入密码。`,
      confirmText: '退出该设备',
      danger: true,
    });
    if (!ok) return;
    setRevoking(d.id);
    try {
      const res = await s.apiFetch('/api/sessions/' + encodeURIComponent(d.id), { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(s.errText(data, 'HTTP ' + res.status));
      s.toast('已退出该设备');
      await loadDevices();
    } catch (err) {
      showDevResult(false, '退出失败：' + String((err && err.message) || err));
    } finally {
      setRevoking('');
    }
  }

  async function revokeOthers() {
    const others = devices.filter((d) => !d.current).length;
    if (!others) return;
    const ok = await s.confirm({
      title: `退出其它 ${others} 台设备？`,
      desc: '只保留当前这台，其它设备需要重新登录。',
      confirmText: '全部退出',
      danger: true,
    });
    if (!ok) return;
    setRevoking('others');
    try {
      const res = await s.apiFetch('/api/sessions/revoke-others', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(s.errText(data, 'HTTP ' + res.status));
      showDevResult(true, `已退出 ${data.revoked || 0} 台设备`);
      await loadDevices();
    } catch (err) {
      showDevResult(false, '退出失败：' + String((err && err.message) || err));
    } finally {
      setRevoking('');
    }
  }

  /* ---------- 条目过滤规则已迁至「规则」tab（WatchPane） ---------- */

  async function saveAccount() {
    setSaving(true);
    clearAccResult();
    try {
      /* 只提交本次真的要改的字段：契约里 newPassword 带 min(4)、username 有格式要求，
         把空串原样发过去会在 zod 处 400（「只改用户名」/「只改密码」两种正常用法都走不通）。 */
      const body = { currentPassword: current };
      if (username) body.username = username;
      if (newPass) body.newPassword = newPass;
      const res = await s.apiFetch('/api/account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) { showAccResult(false, s.errText(data, '保存失败')); return; }
      showAccResult(true, '账号已更新');
      setCurrent('');
      setNewPass('');
      setUsername(data.username);
      setSavedName(data.username);
      if (s.state) s.state.username = data.username;   // 同步全局态（顶栏 / 其他面板共用）
    } catch (err) {
      showAccResult(false, '保存失败：' + String((err && err.message) || err));
    } finally {
      setSaving(false);
    }
  }

  async function logout() {
    try { await s.apiFetch('/api/logout', { method: 'POST' }); } catch (_) { /* 忽略 */ }
    location.replace('/login.html');
  }

  // 用户行操作：删除 / 改角色 / 改密码（与旧 userList 事件委托逐分支一致）
  async function userAction(act, u, nextRole) {
    try {
      if (act === 'del') {
        const ok = await s.confirm({
          title: `删除用户「${u.username}」？`,
          desc: '其订阅源、条目与日报都会一并删除，且不可恢复。',
          confirmText: '删除用户',
          danger: true,
        });
        if (!ok) return;
        const res = await s.apiFetch('/api/users/' + u.id, { method: 'DELETE' });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(s.errText(d, 'HTTP ' + res.status));
        showUserResult(true, `已删除 ${u.username}`);
        s.toast(`已删除用户 ${u.username}`);
        await loadUsers();
      } else if (act === 'role') {
        const next = nextRole || (u.role === 'admin' ? 'user' : 'admin');
        const ok = await s.confirm({
          title: `将「${u.username}」设为${ROLE_LABEL[next] || next}？`,
          desc: next === 'admin'
            ? '管理员可以管理用户与站点级设置。'
            : next === 'readonly'
              ? '只读用户只能阅读，不能修改订阅源、规则、模型或日报。'
              : '普通用户可以管理自己的订阅源、模型与日报。',
          confirmText: '修改角色',
          danger: next === 'admin',
        });
        if (!ok) return false;
        const res = await s.apiFetch('/api/users/' + u.id, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: next }),
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(s.errText(d, 'HTTP ' + res.status));
        showUserResult(true, `已将 ${u.username} 设为${ROLE_LABEL[next] || next}`);
        await loadUsers();
        return true;
      } else if (act === 'pass') {
        const np = await s.confirm({
          title: `为「${u.username}」设置新密码`,
          desc: '至少 4 位，设置后立即生效。',
          confirmText: '设置密码',
          input: { label: '新密码', placeholder: '至少 4 位', type: 'password', autoComplete: 'new-password', required: true },
        });
        if (np == null) return;
        if (np.length < 4) { showUserResult(false, '密码至少 4 位'); return; }
        const res = await s.apiFetch('/api/users/' + u.id, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: np }),
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(s.errText(d, 'HTTP ' + res.status));
        showUserResult(true, `已重置 ${u.username} 的密码`);
      }
    } catch (err) {
      showUserResult(false, '操作失败：' + String((err && err.message) || err));
    }
  }

  async function addUser() {
    const name = newUserName.trim();
    if (!name) { showUserResult(false, '请填写用户名'); return; }
    if (newUserPass.length < 4) { showUserResult(false, '密码至少 4 位'); return; }
    setAddingUser(true);
    try {
      const res = await s.apiFetch('/api/users', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: name, password: newUserPass, role: newUserRole }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(s.errText(d, 'HTTP ' + res.status));
      showUserResult(true, `已创建用户 ${name}`);
      s.toast(`已创建用户 ${name}`);
      setNewUserName('');
      setNewUserPass('');
      setNewUserRole('user');
      await loadUsers();
    } catch (err) {
      showUserResult(false, '创建失败：' + String((err && err.message) || err));
    } finally {
      setAddingUser(false);
    }
  }

  async function install() {
    const ok = s.promptInstall ? await s.promptInstall() : false;
    if (!ok) s.toast('请用手机浏览器菜单里的「安装应用 / 添加到主屏幕」');
  }

  function startExport() {
    s.downloadUrl('/api/export' + (inclLlm ? '?llm=1' : ''));
    s.toast('正在生成导出包，浏览器会自动保存文件');
  }

  async function startBackup() {
    const ok = await s.confirm({
      title: '下载整站备份？',
      desc: '包含所有账号（密码哈希）、订阅源与文章、日报、模型配置、站点设置与图片缓存，属于敏感文件。站点越大生成越久，期间请勿重复点击。',
      confirmText: '开始备份',
      danger: true,
    });
    if (!ok) return;
    s.downloadUrl('/api/backup');
    s.toast('正在生成整站备份，完成后浏览器会保存文件');
  }

  const usersSub = users.length ? `共 ${users.length} 个` : '';
  // 登录信息草稿 + 新增用户表单；当前密码本身不是持久改动，但填了就该提醒
  const dirty = !readonly && (
    username !== savedName || current !== '' || newPass !== ''
    || newUserName !== '' || newUserPass !== '' || newUserRole !== 'user'
  );
  useEffect(() => {
    if (onDirtyChange) onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  return (
    <div className="tab-pane" data-pane="account" ref={paneRef}>
      <div className="pane-scroll">
        <Result id="accResult" result={accResult} />

        <Section secKey="acc-login" title="登录信息" open
          sub={savedName ? `当前用户 ${savedName}` : ''}>
          {readonly ? (
              <>
                <div className="form-row">
                  <label htmlFor="accUsername">用户名</label>
                  <input id="accUsername" type="text" value={username} disabled />
                </div>
                <div className="hint">只读账户：只能阅读，不能修改订阅源、规则、模型或日报配置；用户名和密码由管理员维护。</div>
              </>
            ) : (
              <>
                <div className="form-row">
                  <label htmlFor="accUsername">用户名</label>
                  <input id="accUsername" type="text" spellCheck="false" value={username}
                    onChange={(e) => setUsername(e.target.value)} />
                </div>
                <div className="form-row">
                  <label htmlFor="accCurrent">当前密码 <span className="req">*</span></label>
                  <input id="accCurrent" type="password" placeholder="修改前需验证当前密码"
                    autoComplete="current-password" value={current}
                    onChange={(e) => setCurrent(e.target.value)} />
                </div>
                <div className="form-row">
                  <label htmlFor="accNew">新密码</label>
                  <input id="accNew" type="password" placeholder="留空则不修改，至少 4 位"
                    autoComplete="new-password" value={newPass}
                    onChange={(e) => setNewPass(e.target.value)} />
                </div>
              </>
            )}
        </Section>

        {/* 登录设备（会话）：本机按当前 Cookie 标记，其余可逐台退出 */}
        <Section secKey="acc-devices" title="登录设备" open
          sub={!devicesLoaded ? '读取中…' : (devices.length ? `${devices.length} 台` : '仅本机')}>
          <Result id="devResult" result={devResult} />
          {devicesError ? (
            <div className="hint pane-msg">
              {devicesError}
              <button className="btn btn-ghost btn-sm" type="button" onClick={loadDevices}>重试</button>
            </div>
          ) : !devicesLoaded ? (
            <div className="hint">正在读取登录设备…</div>
          ) : (
            <>
              <div className="dev-list" id="deviceList">
                {devices.map((d) => (
                  <div className={'dev-row' + (d.current ? ' current' : '')} key={d.id}>
                    <div className="dev-main">
                      <span className="dev-name">
                        {deviceLabel(d.userAgent)}
                        {d.current ? <span className="dev-badge">本机</span> : null}
                      </span>
                      <span className="dev-meta" title={`最近活跃 ${d.lastSeenAt}`}>
                        {d.ip || '未知地址'} · {fmtRel(d.lastSeenAt)}活跃
                      </span>
                    </div>
                    {!d.current && (
                      <button className="u-btn dev-revoke" type="button" disabled={revoking === d.id}
                        onClick={() => revokeDevice(d)}>
                        {revoking === d.id ? '退出中…' : '退出'}
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <small className="form-tip">
                「本机」按当前浏览器判断。退出其它设备后它们需要重新输入密码；在这台设备上退出请用左下角的「退出登录」。
              </small>
              {devices.some((d) => !d.current) ? (
                <div className="dev-actions">
                  <button className="btn btn-ghost btn-sm" id="revokeOtherSessionsBtn" type="button"
                    disabled={revoking === 'others'} onClick={revokeOthers}>
                    {revoking === 'others' ? '退出中…' : '退出其它设备'}
                  </button>
                </div>
              ) : null}
            </>
          )}
        </Section>

        {/* 数据导出：账号级存档，换机或长期留存用 */}
        <Section secKey="acc-export" title="数据导出" sub="tar.gz">
          <p className="hint">
            把本账号的订阅源、全部文章（含已读 / 收藏 / 关注标记）、日报与偏好设置打包下载；
            不含登录会话、图片缓存与全文抓取缓存。
          </p>
          {!readonly && (
            <div className="form-row">
              <label className="form-row-head">
                <span>连同模型 API Key 一起导出</span>
                <span className="switch">
                  <input id="exportLlm" type="checkbox" checked={inclLlm}
                    onChange={(e) => setInclLlm(e.target.checked)} />
                  <span className="switch-slider" />
                </span>
              </label>
              <small className="form-tip">勾选后 llm.json 里是解密的明文 Key，文件请只放在受控位置。</small>
            </div>
          )}
          <div className="dev-actions">
            <button className="btn btn-ghost btn-sm" id="exportBtn" type="button" onClick={startExport}>
              下载导出包
            </button>
          </div>
          <small className="form-tip">
            包内 manifest.json 写明格式版本与条数，文章按 entries-0001.jsonl 分批；恢复是按表导入，不是一键还原。
          </small>
        </Section>

        {/* 用户管理：仅管理员可见 */}
        {admin && (
          <Section secKey="acc-users" id="accUsersSec" title="用户管理" sub={usersSub}>
              <div className="user-list" id="userList">
                {!usersLoaded ? null
                  : usersError ? <div className="hint pane-msg">{usersError}</div>
                    : !users.length ? <div className="hint">还没有用户</div>
                      : users.map((u) => (
                        <div className="user-row" data-id={u.id} key={u.id}>
                          <span className="u-name">{u.username}</span>
                          <span className={'u-badge' + (u.role === 'admin' ? '' : ' role-' + u.role)}>
                            {ROLE_LABEL[u.role] || u.role}
                          </span>
                          <span className="u-meta">{Number(u.feedCount) || 0} 个源</span>
                          {u.isSelf ? <span className="u-self">当前</span> : null}
                          <span className="u-spacer" />
                          {!u.isSelf && (
                            <select className="select u-role" data-act="role" data-id={u.id}
                              title="角色" aria-label={`${u.username} 的角色`} value={u.role}
                              onChange={async (e) => {
                                const ok = await userAction('role', u, e.target.value);
                                if (ok !== true) e.target.value = u.role;
                              }}>
                              <option value="user">普通</option>
                              <option value="readonly">只读</option>
                              <option value="admin">管理员</option>
                            </select>
                          )}
                          <button className="u-btn" data-act="pass" data-id={u.id}
                            onClick={() => userAction('pass', u)}>改密码</button>
                          {!u.isSelf && (
                            <button className="u-btn danger" data-act="del" data-id={u.id}
                              onClick={() => userAction('del', u)}>删除</button>
                          )}
                        </div>
                      ))}
              </div>
              <div className="user-add">
                <input id="newUserName" type="text" placeholder="用户名" spellCheck="false"
                  autoComplete="off" value={newUserName} onChange={(e) => setNewUserName(e.target.value)} />
                <input id="newUserPass" type="password" placeholder="密码（至少 4 位）"
                  autoComplete="new-password" value={newUserPass} onChange={(e) => setNewUserPass(e.target.value)} />
                <select id="newUserRole" className="select" title="角色" value={newUserRole}
                  onChange={(e) => setNewUserRole(e.target.value)}>
                  <option value="user">普通用户</option>
                  <option value="readonly">只读用户</option>
                  <option value="admin">管理员</option>
                </select>
                <button className="btn btn-primary" id="addUserBtn" type="button"
                  disabled={addingUser} onClick={addUser}>添加</button>
              </div>
              <small className="form-tip">
                每个用户拥有<b>自己独立</b>的订阅源、已读/收藏、日报与模型配置。普通用户可配置自己的订阅源、模型与日报，但看不到「状态 / 采集参数 / 用户管理」等站点级设置；管理员额外可管理用户与全局设置。只读用户只能阅读，不能修改订阅源、规则、模型、日报等配置，也不能自行修改用户名和密码，适合把账号借给别人阅读。
                删除用户会一并删除其订阅源、条目与日报，且不可恢复。
              </small>
              <Result id="userResult" result={userResult} />
          </Section>
        )}

        {/* 整站备份：管理员级、含敏感数据，单独分组并走危险确认 */}
        {admin && (
          <Section secKey="acc-backup" title="整站备份" sub="仅管理员">
            <p className="hint">
              打包全站数据：所有账号（含密码哈希）、订阅源与文章、日报、模型配置、站点设置与图片缓存。
              这是敏感文件，请只保存在受控位置；包内不含登录会话，恢复后所有人需要重新登录。
            </p>
            <div className="dev-actions">
              <button className="btn btn-danger btn-sm" id="backupBtn" type="button" onClick={startBackup}>
                下载整站备份
              </button>
            </div>
            <small className="form-tip">
              同一时间只允许生成一份；恢复由运维按表手工导入，适合换机搬运用。
            </small>
          </Section>
        )}

        {/* 装到桌面属于「看一次就够」的内容，默认收起 */}
        <Section secKey="acc-install" title="添加到手机" sub="装到桌面，像 App 一样打开">
            <p className="install-card-tip">
              用手机浏览器打开 <code id="installHost">{location.host}</code>，在浏览器菜单里选「安装应用 / 添加到主屏幕」即可。<br />
              Edge / Chrome：右上角「⋯」→ 添加到手机 / 安装应用；iOS Safari：分享 → 添加到主屏幕。
            </p>
            <button className="btn btn-ghost btn-sm install-trigger" type="button" onClick={install}>
              一键安装（浏览器支持时）
            </button>
        </Section>
      </div>

      <PaneFoot lead={
        <button className="btn btn-danger btn-sm" id="logoutBtn" onClick={logout}>退出登录</button>
      }>
        {!readonly && (
          <button className="btn btn-primary" id="saveAccBtn" disabled={saving || !dirty} onClick={saveAccount}>
            {saving ? '保存中…' : '保存账号'}
          </button>
        )}
      </PaneFoot>
    </div>
  );
}
