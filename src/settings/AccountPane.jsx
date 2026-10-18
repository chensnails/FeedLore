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

const S = () => core;   // 核心逻辑单例（@core，v2.0.0 起改为模块引用）

/** test-result 提示：ok 时 4s 后自动清除，err 常驻（与旧 showResult 语义一致） */
function useResult(state) {
  const [result, setResult] = useState(state || null);
  const timerRef = useRef(null);
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);
  const show = (ok, msg) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setResult({ ok, msg });
    if (ok) timerRef.current = setTimeout(() => setResult(null), 4000);
  };
  const clear = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setResult(null);
  };
  return [result, show, clear];
}

const Result = ({ id, result }) => (
  <div id={id} className={'test-result' + (result ? ' show ' + (result.ok ? 'ok' : 'err') : '')}>
    {result ? result.msg : ''}
  </div>
);

export function AccountPane() {
  const s = S();
  const admin = !!(s && s.isAdmin && s.isAdmin());
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

  // 条目过滤规则（v2.7.0）：按账号独立保存，抓取写库前对新条目生效
  const [filters, setFilters] = useState([]);
  const [filtersLoaded, setFiltersLoaded] = useState(false);
  const [savingFilter, setSavingFilter] = useState(false);
  const [filterResult, showFilterResult] = useResult();

  // 进入面板：回填登录信息（旧 loadAccountForm），管理员再拉一次用户列表
  useEffect(() => {
    const st = (s && s.state) || {};
    const name = st.username || '';
    setUsername(name);
    setSavedName(name);
    loadFilters();
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
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      setUsers(data.users || []);
      setUsersError('');
    } catch (err) {
      setUsersError('读取用户失败：' + String((err && err.message) || err));
    } finally {
      setUsersLoaded(true);
    }
  }

  /* ---------- 条目过滤规则（v2.7.0） ---------- */

  async function loadFilters() {
    try {
      const res = await s.apiFetch('/api/prefs');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      setFilters(Array.isArray(data.filters) ? data.filters : []);
    } catch (err) {
      showFilterResult(false, '读取过滤规则失败：' + String((err && err.message) || err));
    } finally {
      setFiltersLoaded(true);
    }
  }

  async function saveFilters() {
    setSavingFilter(true);
    try {
      const res = await s.apiFetch('/api/prefs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filters }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
      // 服务端会重新清洗：空模式 / 非法正则 / 超长 都被丢弃，用回填结果告知差量
      const saved = Array.isArray(data.filters) ? data.filters : [];
      setFilters(saved);
      const dropped = filters.length - saved.length;
      showFilterResult(true, dropped > 0
        ? `已保存 ${saved.length} 条规则（${dropped} 条为空或非法，已丢弃）`
        : `已保存 ${saved.length} 条规则`);
      s.toast('过滤规则已保存');
    } catch (err) {
      showFilterResult(false, '保存失败：' + String((err && err.message) || err));
    } finally {
      setSavingFilter(false);
    }
  }

  const filterUid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  function addFilter() {
    setFilters((list) => [...list,
      { id: filterUid(), on: true, act: 'block', field: 'title', kind: 'kw', pattern: '' }]);
  }

  /** 本地改一条规则的某个字段（不动其它字段） */
  function patchFilter(id, patch) {
    setFilters((list) => list.map((f) => (f.id === id ? Object.assign({}, f, patch) : f)));
  }

  function removeFilter(id) {
    setFilters((list) => list.filter((f) => f.id !== id));
  }

  async function saveAccount() {
    setSaving(true);
    clearAccResult();
    try {
      const res = await s.apiFetch('/api/account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, currentPassword: current, newPassword: newPass }),
      });
      const data = await res.json();
      if (!res.ok) { showAccResult(false, data.error || '保存失败'); return; }
      showAccResult(true, '账号已更新');
      s.toast('账号已更新');
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
  async function userAction(act, u) {
    try {
      if (act === 'del') {
        if (!confirm(`确定删除用户「${u.username}」？其订阅源、条目与日报都会一并删除，且不可恢复。`)) return;
        const res = await s.apiFetch('/api/users/' + u.id, { method: 'DELETE' });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(d.error || 'HTTP ' + res.status);
        showUserResult(true, `已删除 ${u.username}`);
        s.toast(`已删除用户 ${u.username}`);
        await loadUsers();
      } else if (act === 'role') {
        const next = u.role === 'admin' ? 'user' : 'admin';
        const res = await s.apiFetch('/api/users/' + u.id, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: next }),
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(d.error || 'HTTP ' + res.status);
        showUserResult(true, `已将 ${u.username} 设为${next === 'admin' ? '管理员' : '普通用户'}`);
        await loadUsers();
      } else if (act === 'pass') {
        const np = prompt(`为「${u.username}」设置新密码（至少 4 位）：`);
        if (np == null) return;
        if (np.length < 4) { showUserResult(false, '密码至少 4 位'); return; }
        const res = await s.apiFetch('/api/users/' + u.id, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: np }),
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(d.error || 'HTTP ' + res.status);
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
      if (!res.ok) throw new Error(d.error || 'HTTP ' + res.status);
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

  const usersSub = users.length ? `共 ${users.length} 个` : '';

  return (
    <div className="tab-pane" data-pane="account" ref={paneRef}>
      <div className="pane-scroll">
        <Result id="accResult" result={accResult} />

        <details className="sec" data-sec="acc-login" open>
          <summary className="sec-head">
            <svg className="sec-arrow" aria-hidden="true" focusable="false"><use href="#i-chevron-right" /></svg>
            <span className="sec-title">登录信息</span>
            <span className="sec-sub">{savedName ? `当前用户 ${savedName}` : ''}</span>
          </summary>
          <div className="sec-body">
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
          </div>
        </details>

        {/* 条目过滤规则（v2.7.0）：所有用户独立配置，只在抓取写库前对新条目生效 */}
        <details className="sec" data-sec="acc-filters">
          <summary className="sec-head">
            <svg className="sec-arrow" aria-hidden="true" focusable="false"><use href="#i-chevron-right" /></svg>
            <span className="sec-title">条目过滤规则</span>
            <span className="sec-sub">{filters.length ? `${filters.length} 条` : '未配置'}</span>
          </summary>
          <div className="sec-body">
            {!filtersLoaded ? <div className="hint">正在读取规则…</div>
              : !filters.length ? <div className="hint">还没有规则。添加一条试试，比如屏蔽标题含「广告」的条目。</div>
                : filters.map((f) => (
                  <div className="filter-row" key={f.id} data-fid={f.id}>
                    <input className="filter-on" type="checkbox" checked={f.on !== false} title="启用该规则"
                      aria-label="启用该规则"
                      onChange={(e) => patchFilter(f.id, { on: e.target.checked })} />
                    <select className="select filter-act" title="动作" aria-label="动作"
                      value={f.act} onChange={(e) => patchFilter(f.id, { act: e.target.value })}>
                      <option value="block">屏蔽</option>
                      <option value="allow">只收</option>
                    </select>
                    <select className="select filter-field" title="匹配范围" aria-label="匹配范围"
                      value={f.field} onChange={(e) => patchFilter(f.id, { field: e.target.value })}>
                      <option value="title">标题</option>
                      <option value="desc">摘要</option>
                      <option value="content">正文</option>
                      <option value="all">全部</option>
                    </select>
                    <select className="select filter-kind" title="匹配方式" aria-label="匹配方式"
                      value={f.kind} onChange={(e) => patchFilter(f.id, { kind: e.target.value })}>
                      <option value="kw">关键词</option>
                      <option value="re">正则</option>
                    </select>
                    <input className="filter-pattern" type="text" spellCheck="false" autoComplete="off"
                      placeholder={f.kind === 're' ? '如：v\\d+\\.\\d+' : '关键词，不区分大小写'}
                      value={f.pattern}
                      onChange={(e) => patchFilter(f.id, { pattern: e.target.value })} />
                    <button className="btn btn-ghost btn-sm filter-del" type="button"
                      onClick={() => removeFilter(f.id)}>删除</button>
                  </div>
                ))}
            <div className="filter-actions">
              <button className="btn btn-ghost btn-sm" id="addFilterBtn" type="button"
                onClick={addFilter}>添加规则</button>
            </div>
            <small className="form-tip">
              在抓取写入数据库<b>之前</b>按规则过滤，只影响之后新抓的条目，已入库的历史文章不动。<br />
              <b>屏蔽</b>：命中即丢弃；<b>只收</b>：仅保留命中的（白名单）。两者同存时先按屏蔽拉黑、再按只收拉白。<br />
              关键词不区分大小写；匹配范围「全部」= 标题 + 摘要 + 正文。非法正则在保存时会被丢弃。
            </small>
            <Result id="filterResult" result={filterResult} />
            <div className="filter-save">
              <button className="btn btn-primary btn-sm" id="saveFilterBtn" type="button"
                disabled={savingFilter} onClick={saveFilters}>
                {savingFilter ? '保存中…' : '保存规则'}
              </button>
            </div>
          </div>
        </details>

        {/* 用户管理：仅管理员可见 */}
        {admin && (
          <details className="sec" data-sec="acc-users" id="accUsersSec">
            <summary className="sec-head">
              <svg className="sec-arrow" aria-hidden="true" focusable="false"><use href="#i-chevron-right" /></svg>
              <span className="sec-title">用户管理</span>
              <span className="sec-sub">{usersSub}</span>
            </summary>
            <div className="sec-body">
              <div className="user-list" id="userList">
                {!usersLoaded ? null
                  : usersError ? <div className="hint" style={{ padding: 10 }}>{usersError}</div>
                    : !users.length ? <div className="hint">还没有用户</div>
                      : users.map((u) => (
                        <div className="user-row" data-id={u.id} key={u.id}>
                          <span className="u-name">{u.username}</span>
                          {u.role === 'admin'
                            ? <span className="u-badge">管理员</span>
                            : <span className="u-badge role-user">普通</span>}
                          <span className="u-meta">{Number(u.feedCount) || 0} 个源</span>
                          {u.isSelf ? <span className="u-self">当前</span> : null}
                          <span className="u-spacer" />
                          {!u.isSelf && (
                            <button className="u-btn" data-act="role" data-id={u.id}
                              onClick={() => userAction('role', u)}>
                              {u.role === 'admin' ? '降为普通' : '设为管理员'}
                            </button>
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
                  <option value="admin">管理员</option>
                </select>
                <button className="btn btn-primary btn-sm" id="addUserBtn" type="button"
                  disabled={addingUser} onClick={addUser}>添加</button>
              </div>
              <small className="form-tip">
                每个用户拥有<b>自己独立</b>的订阅源、已读/收藏、日报与模型配置。普通用户可配置自己的模型并阅读，但看不到「状态 / 采集参数 / 用户管理」等站点级设置；管理员额外可管理用户与全局设置。
                删除用户会一并删除其订阅源、条目与日报，且不可恢复。
              </small>
              <Result id="userResult" result={userResult} />
            </div>
          </details>
        )}

        {/* 装到桌面属于「看一次就够」的内容，默认收起 */}
        <details className="sec" data-sec="acc-install">
          <summary className="sec-head">
            <svg className="sec-arrow" aria-hidden="true" focusable="false"><use href="#i-chevron-right" /></svg>
            <span className="sec-title">添加到手机</span>
            <span className="sec-sub">装到桌面，像 App 一样打开</span>
          </summary>
          <div className="sec-body">
            <p className="install-card-tip">
              用手机浏览器打开 <code id="installHost">{location.host}</code>，在浏览器菜单里选「安装应用 / 添加到主屏幕」即可。<br />
              Edge / Chrome：右上角「⋯」→ 添加到手机 / 安装应用；iOS Safari：分享 → 添加到主屏幕。
            </p>
            <button className="btn btn-ghost btn-sm install-trigger" type="button" onClick={install}>
              一键安装（浏览器支持时）
            </button>
          </div>
        </details>
      </div>

      <div className="pane-foot">
        <button className="btn btn-danger btn-sm" id="logoutBtn" onClick={logout}>退出登录</button>
        <div className="pane-foot-btns">
          <button className="btn btn-primary" id="saveAccBtn" disabled={saving} onClick={saveAccount}>
            {saving ? '保存中…' : '保存账号'}
          </button>
        </div>
      </div>
    </div>
  );
}
