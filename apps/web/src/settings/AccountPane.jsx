/* 设置弹层「账号」面板（v1.6.0 起 React 化，原 index.html 内联 DOM + app.js 绑定迁移至此，P2d）。
 *
 * 结构（v2.5.0 设置 A 方案）：
 * - 登录信息 / 数据导出 / 导入 / 备份 / 还原 / 安装仍按折叠分组摆放（表单类，见 primitives.Section）；
 * - 登录设备、用户管理改成「紧凑列表 + 详情层」：行只留头像 / 名称 / 状态，点行打开 DetailSheet
 *   做逐台退出、改角色、改密码、删除；新增用户也收进详情层，列表不再被一排输入框撑长；
 * - 行内与层内的操作都是「即改即生效」，失败直接写在层里 / 分组里的 Result。
 */

import { core } from '@core';
import React, { useEffect, useRef, useState } from 'react';
import { DetailSheet } from './DetailSheet.jsx';
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

const openOnKey = (fn) => (ev) => {
  if (ev.target !== ev.currentTarget) return;
  if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); fn(); }
};

/* ---------- 登录设备详情层 ---------- */
function DeviceSheet({ device, busy, onClose, onRevoke }) {
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
      foot={!device.current ? (
        <button className="btn btn-danger" id="revokeDeviceBtn" type="button"
          disabled={busy} onClick={revoke}>
          {busy ? '退出中…' : '退出该设备'}
        </button>
      ) : null}>
      <div className="ds-stat">
        <div className="ds-stat-line">
          {device.current ? '当前设备 · 就是你现在用的这台浏览器' : '其它设备 · 退出后需要重新输入密码'}
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
function UserSheet({ user, busy, onClose, onRole, onPassword, onDelete }) {
  const [pass, setPass] = useState('');
  const [err, setErr] = useState('');
  const roleRef = useRef(null);
  const self = !!user.isSelf;

  const changeRole = async (ev) => {
    const next = ev.target.value;
    if (next === user.role) return;
    setErr('');
    const res = await onRole(user, next);
    if (!res.ok) {
      setErr(res.error || '角色修改失败');
      if (roleRef.current) roleRef.current.value = user.role;
    }
  };

  const removeUser = async () => {
    setErr('');
    const res = await onDelete(user);
    if (res && !res.ok) setErr(res.error || '删除失败');
  };

  const submitPass = async () => {
    if (pass.length < 4) { setErr('密码至少 4 位'); return; }
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
            <button className="btn btn-danger" id="delUserBtn" type="button"
              disabled={busy} onClick={removeUser}>
              删除用户
            </button>
          ) : null}
          <button className="btn" type="button" onClick={onClose}>完成</button>
        </>
      }>
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
            <label htmlFor="dsUserRole">角色</label>
            <select id="dsUserRole" className="select" ref={roleRef} value={user.role}
              disabled={busy} onChange={changeRole}>
              <option value="user">普通</option>
              <option value="readonly">只读</option>
              <option value="admin">管理员</option>
            </select>
            <small className="form-tip">
              管理员可管理用户与站点设置；普通用户管理自己的订阅源、模型与日报；只读只能阅读。改角色立即生效。
            </small>
          </div>

          <div className="form-row">
            <label htmlFor="dsUserPass">设置新密码</label>
            <input id="dsUserPass" type="password" placeholder="至少 4 位"
              autoComplete="new-password" value={pass}
              onChange={(ev) => setPass(ev.target.value)}
              onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); submitPass(); } }} />
            <button className="btn btn-ghost btn-sm" id="setUserPassBtn" type="button"
              style={{ marginTop: 'var(--sp-2)' }}
              disabled={busy || pass.length < 4} onClick={submitPass}>
              设置密码
            </button>
            <small className="form-tip">保存后立即生效，对方已登录的设备会被要求重新登录。</small>
          </div>

          <small className="form-tip">
            删除用户会一并删除其订阅源、条目与日报，且不可恢复。
          </small>
        </>
      )}

      <Result id="userSheetResult" result={err ? { ok: false, msg: err } : null} />
    </DetailSheet>
  );
}

/* ---------- 新增用户详情层 ---------- */
function AddUserSheet({ busy, onClose, onCreate }) {
  const [name, setName] = useState('');
  const [pass, setPass] = useState('');
  const [role, setRole] = useState('user');
  const [err, setErr] = useState('');

  const submit = async () => {
    const n = name.trim();
    if (!n) { setErr('请填写用户名'); return; }
    if (pass.length < 4) { setErr('密码至少 4 位'); return; }
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
          <button className="btn" type="button" onClick={onClose}>取消</button>
          <button className="btn btn-primary" id="createUserBtn" type="button"
            disabled={busy} onClick={submit}>
            {busy ? '添加中…' : '添加用户'}
          </button>
        </>
      }>
      <div className="form-row">
        <label htmlFor="newUserName">用户名</label>
        <input id="newUserName" type="text" placeholder="用户名" spellCheck="false"
          aria-label="新用户的用户名" autoComplete="off" value={name}
          onChange={(ev) => setName(ev.target.value)}
          onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); submit(); } }} />
      </div>
      <div className="form-row">
        <label htmlFor="newUserPass">密码</label>
        <input id="newUserPass" type="password" placeholder="至少 4 位"
          aria-label="新用户的密码" autoComplete="new-password" value={pass}
          onChange={(ev) => setPass(ev.target.value)}
          onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); submit(); } }} />
      </div>
      <div className="form-row">
        <label htmlFor="newUserRole">角色</label>
        <select id="newUserRole" className="select" value={role}
          onChange={(ev) => setRole(ev.target.value)}>
          <option value="user">普通用户</option>
          <option value="readonly">只读用户</option>
          <option value="admin">管理员</option>
        </select>
        <small className="form-tip">
          每个用户拥有自己独立的订阅源、已读/收藏、日报与模型配置；角色之后还能改。
        </small>
      </div>
      <Result id="userSheetResult" result={err ? { ok: false, msg: err } : null} />
    </DetailSheet>
  );
}

export function AccountPane({ onDirtyChange }) {
  const s = S();
  const admin = !!(s && s.isAdmin && s.isAdmin());
  // 只读账户：只能阅读；配置项全部由服务端拒绝，账号凭据由管理员掌握
  const readonly = !!(s && s.state && s.state.role === 'readonly');
  const paneRef = useRef(null);
  const [sheet, setSheet] = useState(null);   // {type:'device'|'user'|'addUser', id?}

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
  const [userBusy, setUserBusy] = useState('');   // '' | add | role | pass | del
  const [userResult, showUserResult] = useResult();

  // 登录设备（会话）：所有角色都能看自己的设备并逐台退出
  const [devices, setDevices] = useState([]);
  const [devicesLoaded, setDevicesLoaded] = useState(false);
  const [devicesError, setDevicesError] = useState('');
  const [revoking, setRevoking] = useState('');
  const [devResult, showDevResult] = useResult();

  // 数据导出：模型 Key 默认不打包，勾选才附带（导出的是明文，提示放在勾选项下）
  const [inclLlm, setInclLlm] = useState(false);

  /* 下载走 <a> 由浏览器接管，前端拿不到「生成完成」事件（流式 tar.gz 不落内存）。
     这里只在生成窗口内把按钮置忙、防重复点击：服务端本来就会用
     E_BACKUP_IN_PROGRESS 拒绝第二份，与其让用户点完收到一条报错，不如先拦住。 */
  const [exporting, setExporting] = useState(false);
  const [backingUp, setBackingUp] = useState(false);
  const downloadTimers = useRef([]);
  useEffect(() => () => { downloadTimers.current.forEach(clearTimeout); }, []);
  const busyDownload = (setBusy) => {
    setBusy(true);
    downloadTimers.current.push(setTimeout(() => setBusy(false), 5000));
  };
  // 改了导出选项 = 用户要的是另一份包，别让上一次的置忙窗口把它拦住
  useEffect(() => { setExporting(false); }, [inclLlm]);

  // 数据导入 / 整站还原：结果提示常驻到下一次操作（条数比 toast 更值得细看）
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreMsg, setRestoreMsg] = useState(null);

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
      setSheet(null);
      s.toast('已退出该设备');
      await loadDevices();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: '退出失败：' + String((err && err.message) || err) };
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

  /* 删除用户：不可恢复，走危险确认 */
  async function deleteUser(u) {
    const ok = await s.confirm({
      title: `删除用户「${u.username}」？`,
      desc: '其订阅源、条目与日报都会一并删除，且不可恢复。',
      confirmText: '删除用户',
      danger: true,
    });
    if (!ok) return;
    setUserBusy('del');
    try {
      const res = await s.apiFetch('/api/users/' + u.id, { method: 'DELETE' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(s.errText(d, 'HTTP ' + res.status));
      setSheet(null);
      showUserResult(true, `已删除 ${u.username}`);
      s.toast(`已删除用户 ${u.username}`);
      await loadUsers();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: '删除失败：' + String((err && err.message) || err) };
    } finally {
      setUserBusy('');
    }
  }

  /* 改角色：服务端立即生效，确认框里说明该角色能做什么；取消返回 false 让下拉回退 */
  async function changeUserRole(u, next) {
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
    if (!ok) return { ok: false, canceled: true };
    setUserBusy('role');
    try {
      const res = await s.apiFetch('/api/users/' + u.id, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: next }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(s.errText(d, 'HTTP ' + res.status));
      showUserResult(true, `已将 ${u.username} 设为${ROLE_LABEL[next] || next}`);
      await loadUsers();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: '角色修改失败：' + String((err && err.message) || err) };
    } finally {
      setUserBusy('');
    }
  }

  /* 管理员重置他人密码：不再用浏览器 prompt，输入框就在详情层里 */
  async function setUserPassword(u, np) {
    if (np.length < 4) return { ok: false, error: '密码至少 4 位' };
    setUserBusy('pass');
    try {
      const res = await s.apiFetch('/api/users/' + u.id, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: np }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(s.errText(d, 'HTTP ' + res.status));
      showUserResult(true, `已重置 ${u.username} 的密码`);
      s.toast(`已重置 ${u.username} 的密码，请告知对方新密码`);
      return { ok: true };
    } catch (err) {
      const msg = '设置失败：' + String((err && err.message) || err);
      showUserResult(false, msg);
      return { ok: false, error: msg };
    } finally {
      setUserBusy('');
    }
  }

  /* 新增用户：成功即关层并重拉列表（服务端会分配 id） */
  async function createUser(name, pass, role) {
    setUserBusy('add');
    try {
      const res = await s.apiFetch('/api/users', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: name, password: pass, role }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(s.errText(d, 'HTTP ' + res.status));
      setSheet(null);
      showUserResult(true, `已创建用户 ${name}`);
      s.toast(`已创建用户 ${name}`);
      await loadUsers();
      return { ok: true };
    } catch (err) {
      const msg = '创建失败：' + String((err && err.message) || err);
      showUserResult(false, msg);
      return { ok: false, error: msg };
    } finally {
      setUserBusy('');
    }
  }

  async function install() {
    const ok = s.promptInstall ? await s.promptInstall() : false;
    if (!ok) s.toast('请用手机浏览器菜单里的「安装应用 / 添加到主屏幕」');
  }

  function startExport() {
    if (exporting) return;
    busyDownload(setExporting);
    s.downloadUrl('/api/export' + (inclLlm ? '?llm=1' : ''));
    s.toast('正在生成导出包，浏览器会自动保存文件');
  }

  async function startBackup() {
    if (backingUp) return;
    const ok = await s.confirm({
      title: '下载整站备份？',
      desc: '包含所有账号（密码哈希）、订阅源与文章、日报、模型配置、站点设置与图片缓存，属于敏感文件。站点越大生成越久，期间请勿重复点击。',
      confirmText: '开始备份',
      danger: true,
    });
    if (!ok) return;
    busyDownload(setBackingUp);
    s.downloadUrl('/api/backup');
    s.toast('正在生成整站备份，完成后浏览器会保存文件');
  }

  /* 账号导入：只做增量合并，已存在的频道与文章跳过（保留现状） */
  async function importArchive(ev) {
    const input = ev.target;
    const file = input.files && input.files[0];
    input.value = '';   // 清掉选择，同一个文件还能再选一次
    if (!file) return;
    const ok = await s.confirm({
      title: '导入到当前账号？',
      desc: `会把「${file.name}」里的频道、文章标记、日报与偏好合并进来；已存在的频道和文章会跳过，现有文章的已读 / 收藏 / 关注状态不会被改动。模型配置只在这个账号还没配过模型时写入。`,
      confirmText: '开始导入',
    });
    if (!ok) return;
    setImporting(true);
    setImportMsg(null);
    try {
      const res = await s.uploadArchive('/api/import', file);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(s.errText(data, 'HTTP ' + res.status));
      const f = data.feeds || {};
      const e = data.entries || {};
      const d = data.digests || {};
      const parts = [
        `新增 ${f.inserted || 0} 个频道（跳过 ${f.skipped || 0} 个）`,
        `新增 ${e.inserted || 0} 篇文章（跳过 ${e.skipped || 0} 篇）`,
        `新增 ${d.inserted || 0} 篇日报（跳过 ${d.skipped || 0} 篇）`,
      ];
      if (data.prefs) parts.push('已写入偏好设置');
      if (data.llm === 'applied') parts.push('已写入模型配置（Key 按本机密钥重新加密）');
      else if (data.llm === 'already-configured') parts.push('本账号已有模型配置，包内那份未覆盖');
      else if (data.llm === 'url-blocked') parts.push('包里的模型地址指向内网，已跳过');
      setImportMsg({ ok: true, msg: '导入完成：' + parts.join('，') + '。' });
      await s.loadFeeds().catch(() => { /* 侧栏刷新失败不影响已入库的数据 */ });
    } catch (err) {
      setImportMsg({ ok: false, msg: '导入失败：' + String((err && err.message) || err) });
    } finally {
      setImporting(false);
    }
  }

  /* 整站还原：两次确认，成功后会话已被清空，直接回登录页 */
  async function restoreSite(ev) {
    const input = ev.target;
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    const step1 = await s.confirm({
      title: '准备还原整站？',
      desc: `将读取「${file.name}」里的账号、频道、文章、日报、设置与图片缓存。上传完成后还需要再确认一次，才会真正清库写入。`,
      confirmText: '继续',
      danger: true,
    });
    if (!step1) return;
    const step2 = await s.confirm({
      title: '确认清空并还原整站？',
      desc: '当前全站数据会被包内数据整体替换，不做合并；所有登录会话立即失效，还原后需要重新登录。此操作不可撤销。',
      confirmText: '清空并还原',
      danger: true,
    });
    if (!step2) return;
    setRestoring(true);
    setRestoreMsg(null);
    try {
      const res = await s.uploadArchive('/api/restore', file);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(s.errText(data, 'HTTP ' + res.status));
      const c = data.counts || {};
      s.toast(`整站还原完成：${c.users || 0} 个账号、${c.entries || 0} 篇文章，请重新登录`);
      setTimeout(() => s.goLogin(), 800);
    } catch (err) {
      setRestoreMsg({ ok: false, msg: '还原失败：' + String((err && err.message) || err) });
      setRestoring(false);
    }
  }

  const usersSub = users.length ? `共 ${users.length} 个` : '';
  const otherDevices = devices.filter((d) => !d.current).length;
  // 登录信息草稿；用户 / 设备的改动都在各自详情层里即时生效，不计入面板脏态
  const dirty = !readonly && (username !== savedName || current !== '' || newPass !== '');
  useEffect(() => {
    if (onDirtyChange) onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  const sheetDevice = sheet && sheet.type === 'device' ? devices.find((d) => d.id === sheet.id) : null;
  const sheetUser = sheet && sheet.type === 'user' ? users.find((u) => u.id === sheet.id) : null;

  const renderDeviceRow = (d) => (
    <div className={'sl-row' + (d.current ? ' is-current' : '')} key={d.id} data-session-id={d.id}
      role="button" tabIndex={0}
      aria-label={`${deviceLabel(d.userAgent)}：查看设备详情`}
      onClick={() => setSheet({ type: 'device', id: d.id })}
      onKeyDown={openOnKey(() => setSheet({ type: 'device', id: d.id }))}>
      <span className="sl-ava">
        <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-activity" /></svg>
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
      <svg className="ico feed-caret" aria-hidden="true" focusable="false"><use href="#i-chevron-right" /></svg>
    </div>
  );

  const renderUserRow = (u) => (
    <div className="sl-row" key={u.id} data-uid={u.id}
      role="button" tabIndex={0} aria-label={`${u.username}：查看账号详情`}
      onClick={() => setSheet({ type: 'user', id: u.id })}
      onKeyDown={openOnKey(() => setSheet({ type: 'user', id: u.id }))}>
      <span className="sl-ava">
        <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-user" /></svg>
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
      <svg className="ico feed-caret" aria-hidden="true" focusable="false"><use href="#i-chevron-right" /></svg>
    </div>
  );

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

        {/* 登录设备（会话）：紧凑列表，点行看详情 / 退出 */}
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
              <div className="sl-list" id="deviceList">{devices.map(renderDeviceRow)}</div>
              <div className="sl-toolbar">
                {otherDevices ? (
                  <button className="btn btn-ghost btn-sm" id="revokeOtherSessionsBtn" type="button"
                    disabled={revoking === 'others'} onClick={revokeOthers}>
                    {revoking === 'others' ? '退出中…' : `退出其它设备（${otherDevices} 台）`}
                  </button>
                ) : null}
                <span className="sl-toolbar-note">「本机」按当前浏览器判断；逐台退出用行详情</span>
              </div>
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
            <button className="btn btn-ghost btn-sm" id="exportBtn" type="button"
              disabled={exporting} aria-busy={exporting} onClick={startExport}>
              {exporting ? '生成中…' : '下载导出包'}
            </button>
          </div>
          <small className="form-tip">
            包内 manifest.json 写明格式版本与条数，文章按 entries-0001.jsonl 分批；换机或回滚时在下方「数据导入」里原样上传即可。
          </small>
        </Section>

        {/* 数据导入：账号级增量合并（只读账户由服务端拒绝写操作，不展示） */}
        {!readonly && (
          <Section secKey="acc-import" title="数据导入" sub="tar.gz">
            <p className="hint">
              上传本账号的导出包，把频道、文章标记、日报与偏好合并进来；
              已存在的频道与文章会跳过，现有文章的已读 / 收藏 / 关注状态不会被改动。
              包里若带模型配置（导出时勾选），只在这个账号还没配过模型时写入，并用本机主密钥重新加密。
            </p>
            <div className="dev-actions">
              <button className="btn btn-ghost btn-sm" id="importBtn" type="button" disabled={importing}
                aria-busy={importing}
                onClick={() => document.getElementById('importFile').click()}>
                {importing ? '导入中…（文件大时需要一点时间）' : '选择导出包并导入'}
              </button>
              <input id="importFile" type="file" accept=".gz,application/gzip,application/x-gzip" hidden
                onChange={importArchive} />
            </div>
            <Result id="importResult" result={importMsg} />
            <small className="form-tip">
              导入只做增量合并，不会删除现有数据；模型 API Key 只有在导出时勾选才会在包里，
              写入时用的是本机的加密主密钥，不是包里的那份。
              这里只收「数据导出」的账号包，整站备份请到下方「整站还原」上传。
            </small>
          </Section>
        )}

        {/* 用户管理：仅管理员可见，紧凑列表 + 详情层 */}
        {admin && (
          <Section secKey="acc-users" id="accUsersSec" title="用户管理" open sub={usersSub}>
            <Result id="userResult" result={userResult} />
            {!usersLoaded ? <div className="hint">正在读取用户…</div>
              : usersError ? (
                <div className="hint pane-msg">
                  {usersError}
                  <button className="btn btn-ghost btn-sm" type="button" onClick={loadUsers}>重试</button>
                </div>
              ) : !users.length ? <div className="sl-empty">还没有用户</div>
                : <div className="sl-list" id="userList">{users.map(renderUserRow)}</div>}

            <div className="sl-toolbar">
              <button className="btn btn-ghost btn-sm" id="addUserBtn" type="button"
                disabled={userBusy === 'add'} onClick={() => setSheet({ type: 'addUser' })}>
                <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-plus" /></svg>
                添加用户
              </button>
              <span className="sl-toolbar-note">每个账号的订阅源、已读与日报相互独立</span>
            </div>

            <small className="form-tip">
              点行可改角色、重置密码或删除。管理员额外可管理用户与全局设置；普通用户管理自己的订阅源、模型与日报；
              只读用户只能阅读，不能修改订阅源、规则、模型、日报等配置，也不能自行修改用户名和密码。
            </small>
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
              <button className="btn btn-danger btn-sm" id="backupBtn" type="button"
                disabled={backingUp} aria-busy={backingUp} onClick={startBackup}>
                {backingUp ? '生成中…' : '下载整站备份'}
              </button>
            </div>
            <small className="form-tip">
              同一时间只允许生成一份；换机时可在下方「整站还原」里上传该备份包直接还原。
            </small>
          </Section>
        )}

        {/* 整站还原：清库覆盖、全员掉线，两次确认后才会真正执行 */}
        {admin && (
          <Section secKey="acc-restore" title="整站还原" sub="仅管理员">
            <p className="hint">
              上传整站备份包，用它<b>整体替换</b>当前全站数据：账号（含密码）、订阅源与文章、
              日报、模型配置、站点设置与图片缓存。还原期间站点短暂不可用，结束后所有登录会话失效。
            </p>
            <div className="dev-actions">
              <button className="btn btn-danger btn-sm" id="restoreBtn" type="button" disabled={restoring}
                aria-busy={restoring}
                onClick={() => document.getElementById('restoreFile').click()}>
                {restoring ? '还原中…（请勿关闭页面）' : '上传备份并还原'}
              </button>
              <input id="restoreFile" type="file" accept=".gz,application/gzip,application/x-gzip" hidden
                onChange={restoreSite} />
            </div>
            <Result id="restoreResult" result={restoreMsg} />
            <small className="form-tip">
              还原不做合并，先清空再写入，不可撤销；建议先下载当前整站备份留底。只接受本系统导出的 tar.gz。
              这里只收「整站备份」，账号导出包请到上方「数据导入」上传。
              还原后建议重启一次服务，让进程加载包内的站点设置（含登录签名密钥）。
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

      {sheetDevice ? (
        <DeviceSheet key={'dev-' + sheetDevice.id} device={sheetDevice}
          busy={revoking === sheetDevice.id} onClose={() => setSheet(null)}
          onRevoke={revokeDevice} />
      ) : null}
      {sheetUser ? (
        <UserSheet key={'user-' + sheetUser.id} user={sheetUser} busy={!!userBusy}
          onClose={() => setSheet(null)}
          onRole={changeUserRole} onPassword={setUserPassword} onDelete={deleteUser} />
      ) : null}
      {sheet && sheet.type === 'addUser' ? (
        <AddUserSheet busy={userBusy === 'add'} onClose={() => setSheet(null)} onCreate={createUser} />
      ) : null}

      <PaneFoot dirty={dirty} lead={
        <button type="button" className="btn btn-danger btn-sm" id="logoutBtn" onClick={logout}>退出登录</button>
      }>
        {!readonly && (
          <button type="button" className="btn btn-primary" id="saveAccBtn" aria-busy={saving ? 'true' : undefined}
            disabled={saving || !dirty} onClick={saveAccount}>
            {saving ? '保存中…' : '保存账号'}
          </button>
        )}
      </PaneFoot>
    </div>
  );
}
