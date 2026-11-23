/* 账号面板的状态、Query 与全部操作：从 AccountPane.tsx 抽出，逐字对齐。 */

import type { AccountBody, AdminUser, Role, SessionDevice } from '@feedlore/contract';
import { useQuery } from '@tanstack/react-query';
import type * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { qk } from '../kernel/query.ts';
import {
  deviceLabel,
  type OpResult,
  type OpResultMaybe,
  type ResultState,
  ROLE_LABEL,
  S,
  type SheetState,
} from './AccountPane.utils.ts';
import { useResult } from './primitives.tsx';

export function useAccountController(onDirtyChange?: (dirty: boolean) => void) {
  const s = S();
  const admin = !!(s && s.isAdmin && s.isAdmin());
  // 只读账户：只能阅读；配置项全部由服务端拒绝，账号凭据由管理员掌握
  const readonly = !!(s && s.state && s.state.role === 'readonly');
  const paneRef = useRef<HTMLDivElement>(null);
  const [sheet, setSheet] = useState<SheetState>(null);

  // 登录信息
  const [username, setUsername] = useState('');
  const [savedName, setSavedName] = useState('');
  const [current, setCurrent] = useState('');
  const [newPass, setNewPass] = useState('');
  // null = 只读摘要；'name' = 展开用户名；'pass' = 展开当前/新密码
  const [editLogin, setEditLogin] = useState<'name' | 'pass' | null>(null);
  const [saving, setSaving] = useState(false);
  const [accResult, showAccResult, clearAccResult] = useResult();

  // 用户管理
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [usersLoaded, setUsersLoaded] = useState(false);
  const [usersError, setUsersError] = useState('');
  const [userBusy, setUserBusy] = useState(''); // '' | add | role | pass | del
  const [userResult, showUserResult] = useResult();

  // 登录设备（会话）：所有角色都能看自己的设备并逐台退出
  const [devices, setDevices] = useState<SessionDevice[]>([]);
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
  const downloadTimers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  useEffect(
    () => () => {
      downloadTimers.current.forEach(clearTimeout);
    },
    [],
  );
  const busyDownload = (setBusy: (v: boolean) => void) => {
    setBusy(true);
    downloadTimers.current.push(setTimeout(() => setBusy(false), 5000));
  };
  // 改了导出选项 = 用户要的是另一份包，别让上一次的置忙窗口把它拦住
  useEffect(() => {
    setExporting(false);
  }, [inclLlm]);

  // 数据导入 / 整站还原：结果提示常驻到下一次操作（条数比 toast 更值得细看）
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<ResultState>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreMsg, setRestoreMsg] = useState<ResultState>(null);

  // 进入面板：回填登录信息（旧 loadAccountForm）。
  // 用户列表 / 登录设备由 usersQuery / devicesQuery 按 enabled 自动加载。
  useEffect(() => {
    const st = (s && s.state) || {};
    const name = st.username || '';
    setUsername(name);
    setSavedName(name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 可折叠分组的开合按账号持久化（与旧 bindSections 同一机制）
  useEffect(() => {
    if (s && s.bindSections && paneRef.current) s.bindSections(paneRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // V5：用户列表 / 登录设备交给 Query；queryFn 走 core.apiFetch 端口，测试桩照常生效。
  // users 仅管理员拉（enabled: admin），sessions 所有角色都拉。写后 refetch 保留原函数名。
  const usersQuery = useQuery({
    queryKey: qk.users,
    enabled: !!admin,
    queryFn: async () => {
      const res = await s.apiFetch('/api/users');
      if (!res.ok) throw await s.httpError(res);
      return res.json();
    },
    refetchOnMount: 'always',
    gcTime: 0,
    retry: false,
  });
  const devicesQuery = useQuery({
    queryKey: qk.sessions,
    queryFn: async () => {
      const res = await s.apiFetch('/api/sessions');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(s.errText(data, 'HTTP ' + res.status));
      return data;
    },
    refetchOnMount: 'always',
    gcTime: 0,
    retry: false,
  });

  useEffect(() => {
    if (!usersQuery.data) return;
    setUsers(usersQuery.data.users || []);
    setUsersError('');
    setUsersLoaded(true);
  }, [usersQuery.data]);
  useEffect(() => {
    if (!usersQuery.isError) return;
    const err = usersQuery.error;
    setUsersError('读取用户失败：' + String(err?.message || err));
    setUsersLoaded(true);
  }, [usersQuery.isError, usersQuery.error]);

  useEffect(() => {
    if (!devicesQuery.data) return;
    setDevices(devicesQuery.data.sessions || []);
    setDevicesError('');
    setDevicesLoaded(true);
  }, [devicesQuery.data]);
  useEffect(() => {
    if (!devicesQuery.isError) return;
    const err = devicesQuery.error;
    setDevicesError('读取登录设备失败：' + String(err?.message || err));
    setDevicesLoaded(true);
  }, [devicesQuery.isError, devicesQuery.error]);

  // 写后 / 手动刷新沿用原入口：refetch 强制重拉并触发上面的回填。
  async function loadUsers() {
    await usersQuery.refetch();
  }
  async function loadDevices() {
    await devicesQuery.refetch();
  }

  async function revokeDevice(d: SessionDevice): Promise<OpResultMaybe> {
    const ok = await s.confirm({
      title: '退出这台设备？',
      desc: `${deviceLabel(d.userAgent)}（${d.ip || '未知地址'}）会立即失去登录状态，需要重新输入密码。`,
      confirmText: '退出该设备',
      danger: true,
    });
    if (!ok) return;
    setRevoking(d.id);
    try {
      const res = await s.apiFetch('/api/sessions/' + encodeURIComponent(d.id), {
        method: 'DELETE',
      });
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
      const body: AccountBody = { currentPassword: current };
      if (username) body.username = username;
      if (newPass) body.newPassword = newPass;
      const res = await s.apiFetch('/api/account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        showAccResult(false, s.errText(data, '保存失败'));
        return;
      }
      showAccResult(true, '账号已更新');
      setCurrent('');
      setNewPass('');
      setUsername(data.username);
      setSavedName(data.username);
      setEditLogin(null); // 保存成功即回到只读摘要，不把输入框留在页面上
      if (s.state) s.state.username = data.username; // 同步全局态（顶栏 / 其他面板共用）
    } catch (err) {
      showAccResult(false, '保存失败：' + String((err && err.message) || err));
    } finally {
      setSaving(false);
    }
  }

  /** 收起编辑态：有草稿先确认，避免「再点一次」把刚输入的内容静默丢掉。 */
  async function closeEditLogin() {
    const hasDraft = username !== savedName || current !== '' || newPass !== '';
    if (hasDraft) {
      const ok = await s.confirm({
        title: '放弃未保存的更改？',
        desc: '收起后，这次输入的内容不会保存。',
        confirmText: '放弃',
        danger: true,
      });
      if (!ok) return;
    }
    setUsername(savedName);
    setCurrent('');
    setNewPass('');
    setEditLogin(null);
  }

  async function logout() {
    try {
      await s.apiFetch('/api/logout', { method: 'POST' });
    } catch (_) {
      /* 忽略 */
    }
    location.replace('/login.html');
  }

  /* 删除用户：不可恢复，走危险确认 */
  async function deleteUser(u: AdminUser): Promise<OpResultMaybe> {
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
  async function changeUserRole(u: AdminUser, next: Role): Promise<OpResult> {
    const ok = await s.confirm({
      title: `将「${u.username}」设为${ROLE_LABEL[next] || next}？`,
      desc:
        next === 'admin'
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
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
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
  async function setUserPassword(u: AdminUser, np: string): Promise<OpResult> {
    if (np.length < 4) return { ok: false, error: '密码至少 4 位' };
    setUserBusy('pass');
    try {
      const res = await s.apiFetch('/api/users/' + u.id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
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
  async function createUser(name: string, pass: string, role: Role): Promise<OpResult> {
    setUserBusy('add');
    try {
      const res = await s.apiFetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
  async function importArchive(ev: React.ChangeEvent<HTMLInputElement>) {
    const input = ev.target;
    const file = input.files && input.files[0];
    input.value = ''; // 清掉选择，同一个文件还能再选一次
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
      await s.loadFeeds().catch(() => {
        /* 侧栏刷新失败不影响已入库的数据 */
      });
    } catch (err) {
      setImportMsg({ ok: false, msg: '导入失败：' + String((err && err.message) || err) });
    } finally {
      setImporting(false);
    }
  }

  /* 整站还原：两次确认，成功后会话已被清空，直接回登录页 */
  async function restoreSite(ev: React.ChangeEvent<HTMLInputElement>) {
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
      desc: '当前全站数据会被包内数据整体替换，不做合并；服务端会先自动生成一份当前站点备份留底，所有登录会话立即失效，还原后需要重新登录。此操作不可撤销。',
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
      const b = data.autoBackup;
      s.toast(
        `整站还原完成：${c.users || 0} 个账号、${c.entries || 0} 篇文章${b?.file ? `，自动留底 ${b.file}` : ''}，请重新登录`,
      );
      setTimeout(() => s.goLogin(), 800);
    } catch (err) {
      setRestoreMsg({ ok: false, msg: '还原失败：' + String((err && err.message) || err) });
      setRestoring(false);
    }
  }

  const usersSub = users.length ? `共 ${users.length} 个` : '';
  const otherDevices = devices.filter(/** @param {*} [d] */ (d) => !d.current).length;
  // 登录信息草稿；用户 / 设备的改动都在各自详情层里即时生效，不计入面板脏态
  const dirty = !readonly && (username !== savedName || current !== '' || newPass !== '');
  useEffect(() => {
    if (onDirtyChange) onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  const sheetDevice =
    sheet && sheet.type === 'device' ? devices.find((d) => d.id === sheet.id) : null;
  const sheetUser = sheet && sheet.type === 'user' ? users.find((u) => u.id === sheet.id) : null;

  return {
    paneRef,
    admin,
    readonly,
    dirty,
    sheet,
    setSheet,
    sheetDevice,
    sheetUser,
    userBusy,
    accResult,
    username,
    savedName,
    current,
    newPass,
    editLogin,
    setUsername,
    setCurrent,
    setNewPass,
    setEditLogin,
    closeEditLogin,
    saving,
    saveAccount,
    usersSub,
    userResult,
    usersLoaded,
    usersError,
    loadUsers,
    users,
    devResult,
    devicesError,
    devicesLoaded,
    devices,
    loadDevices,
    revoking,
    revokeOthers,
    otherDevices,
    inclLlm,
    setInclLlm,
    exporting,
    startExport,
    importing,
    importMsg,
    importArchive,
    backingUp,
    startBackup,
    restoring,
    restoreMsg,
    restoreSite,
    revokeDevice,
    changeUserRole,
    setUserPassword,
    deleteUser,
    createUser,
    logout,
    install,
  };
}
