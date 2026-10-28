/* 设置弹层「数据源」面板（v1.5.0 起 React 化，原 index.html 内联 DOM + app.js 绑定迁移至此）。
 *
 * 混合期约定（与模型 / 外观 / 关于面板一致）：
 * - 频道数据以 core.state 为单一数据源：组件每次渲染实时读 core.state
 *   （feedList / feedMeta / groupOrder 均原地修改、实时引用），原地改动后 bump tick
 *   触发重绘；服务端往返（增 / 删 / 改）统一走桥 loadFeeds() 刷新共享 state 再 bump。
 * - 采集参数（管理员专属）：进入面板拉 /api/config 回填；cfgLoaded 复刻旧 srcFormReady
 *   语义——没加载完禁止保存，避免把兜底值当成用户设置存下去。
 * - 折叠分组状态按账号持久化：桥 setLayout('collapsedGroups', …)（users.prefs.layout）。
 * - 可折叠分组（details.sec）的开合同样按账号持久化：挂载后经桥 bindSections(容器)
 *   套上已记住的状态并监听变化（与旧实现同一机制）。
 * - 拖拽排序：Pointer 事件移植自旧实现（桌面 + 触屏通用）；频道重排 / 跨组落库
 *   /api/feeds/reorder，分组重排落库 /api/prefs（groupOrder）。
 *
 * 相比旧实现的改进（用户原则：技术落后 / 体验不好的可丢弃）：
 * - 修复「出网代理」不回填的 bug：服务端 GET /api/config 原来漏返 source.proxyUrl，
 *   管理员重开面板时代理输入框是空的，再点保存会把我置成空——本次已在服务端补返该字段；
 * - 重命名由命令式就地改 innerHTML 改为受控编辑态（Enter 提交 / Esc 取消 / 失焦提交）；
 * - 排序 / 跨组后同步刷新工具栏频道下拉（旧实现漏更 renderFeedSelect）；
 * - 采集参数拉取失败不再连带把整个面板打成「读取失败」（ feeds 正常展示，参数区保持兜底值并禁止保存）；
 * - 增删频道后不再重复请求 /api/config（旧实现每次 add/delete 都重拉一遍全局配置）。
 */

import { core } from '@core';
import React, { useCallback, useEffect, useRef, useState } from 'react';

const S = () => core;   // 核心逻辑单例（@core，v2.0.0 起改为模块引用）

/** 频道头像：图标加载失败（拉取 404 / 防盗链）时回退到首字母，避免破图标 */
function FeedAvatar({ icon, name }) {
  const [failed, setFailed] = useState(false);
  if (!icon || failed) {
    return <span className="feed-avatar feed-avatar-txt">{(name || '?').slice(0, 1)}</span>;
  }
  return (
    <img className="feed-avatar" src={icon} alt="" loading="lazy"
      onError={() => setFailed(true)} />
  );
}

/* ---------- 选项表（与旧 index.html / app.js 逐字对齐） ---------- */
// 每频道频率：比全局「自动抓取」多了 15 分钟 / 2 小时两档
const FREQ_OPTIONS = [
  [5, '每 5 分钟'], [10, '每 10 分钟'], [15, '每 15 分钟'], [20, '每 20 分钟'],
  [30, '每 30 分钟'], [60, '每 1 小时'], [120, '每 2 小时'], [180, '每 3 小时'],
  [360, '每 6 小时'], [720, '每 12 小时'], [1440, '每天'],
];
const REFRESH_OPTIONS = [
  [5, '每 5 分钟'], [10, '每 10 分钟'], [20, '每 20 分钟'], [30, '每 30 分钟'],
  [60, '每 1 小时'], [180, '每 3 小时'], [360, '每 6 小时'], [720, '每 12 小时'], [1440, '每天'],
];
const KEEP_DAYS_OPTIONS = [
  [0, '不限时长'], [30, '1 个月'], [90, '3 个月'], [180, '半年'],
  [365, '1 年'], [730, '2 年'], [1095, '3 年'], [1825, '5 年'],
];
const AUTO_REFRESH_OPTIONS = [
  [0, '关闭'], [1, '每 1 分钟'], [5, '每 5 分钟'], [15, '每 15 分钟'], [30, '每 30 分钟'],
];
// v2.4.0：图片缓存参数（仅管理员）
const IMG_TTL_OPTIONS = [
  [1, '1 天'], [3, '3 天'], [7, '7 天'], [14, '14 天'], [30, '30 天'], [90, '90 天'],
];
const IMG_KEEP_OPTIONS = [
  [7, '7 天'], [30, '1 个月'], [90, '3 个月'], [180, '半年'], [365, '1 年'], [730, '2 年'],
];
// 兜底值 = 旧 HTML 里各控件的默认值（配置拉到之前显示这些；拉到之前禁止保存）
const CFG_DEFAULTS = {
  refreshMinutes: '30', keepPerFeed: '300', keepDays: '0',
  timeoutSeconds: '25', concurrency: '3', autoRefreshMinutes: '0', proxyUrl: '',
  imgTtlDays: '7', imgKeepDays: '90', imgMaxDim: '1280', imgQuality: '78',
  feedFailLimit: '5',
};

/** 字节数格式化（图片缓存体积展示） */
function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

/** 选项表补上「库里当前值」：部署时用 env 设了非标称值（如 IMG_TTL_DAYS=5）也能正确回显 */
function withCurrentOption(list, cur) {
  if (list.some(([v]) => String(v) === String(cur))) return list;
  const n = Number(cur);
  if (!Number.isFinite(n)) return list;
  return [...list, [n, `${n} 天`]].sort((a, b) => a[0] - b[0]);
}

/* ---------- 纯函数（自旧 app.js 移植，行为逐字对齐） ---------- */
function fmtMinutes(m) {
  const n = Number(m);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 60) return `${n} 分钟`;
  if (n === 60) return '1 小时';
  if (n < 1440) return `${(n / 60).toFixed(n % 60 ? 1 : 0)} 小时`;
  return '1 天';
}

/** 设置面板里显示「今天 12:36」这类相对时间 */
function fmtDateTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now.getTime() - 86400000).toDateString() === d.toDateString();
  if (sameDay) return `今天 ${hm}`;
  if (yesterday) return `昨天 ${hm}`;
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
}

/** 订阅地址只显示「主机名 + 路径」，太长就截断 */
function prettyUrl(u) {
  try {
    const x = new URL(u);
    const path = x.pathname.replace(/\/$/, '');
    const s = x.host + path;
    return s.length > 64 ? s.slice(0, 62) + '…' : s;
  } catch (_) { return String(u || ''); }
}

function feedStatusText(f) {
  const parts = [`${f.entryCount} 条`];
  parts.push(f.lastFetchedAt ? fmtDateTime(f.lastFetchedAt) + ' 抓取' : '尚未抓取');
  parts.push(`每 ${fmtMinutes(f.effectiveRefreshMinutes)}`);
  if (!f.enabled && f.lastFetchedAt) parts.push('已停采');
  return parts.join(' · ');
}

/* ---------- 小件 ---------- */
const Ico = ({ name }) => (
  <svg className="ico" aria-hidden="true" focusable="false"><use href={`#i-${name}`} /></svg>
);

const GRIP = (
  <svg className="ico drag-grip" aria-hidden="true" focusable="false" viewBox="0 0 16 16">
    <circle cx="5" cy="3.5" r="1.35" /><circle cx="11" cy="3.5" r="1.35" />
    <circle cx="5" cy="8" r="1.35" /><circle cx="11" cy="8" r="1.35" />
    <circle cx="5" cy="12.5" r="1.35" /><circle cx="11" cy="12.5" r="1.35" />
  </svg>
);

const jsonPost = (body) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export function SourcePane({ admin }) {
  /* ---- 状态 ---- */
  const [tick, setTick] = useState(0);                 // 原地改动后强制重绘（共享 state 是实时引用）
  const bump = useCallback(() => setTick((t) => t + 1), []);

  const [cfg, setCfg] = useState(CFG_DEFAULTS);        // 采集参数表单（字符串，与旧 DOM .value 一致）
  const [cfgLoaded, setCfgLoaded] = useState(false);   // 复刻旧 srcFormReady
  const [loadError, setLoadError] = useState('');      // /api/feeds 拉取失败（列表区兜底）
  const [imgStats, setImgStats] = useState({ count: 0, bytes: 0 });   // 图片缓存统计（v2.4.0）

  const [url, setUrl] = useState('');
  const [result, setResult] = useState(null);          // { ok, msg } | null —— #feedResult
  const [collapsed, setCollapsed] = useState(() => new Set((S() && S().state && S().state.collapsedGroups) || []));
  const [renamingId, setRenamingId] = useState(null);  // 正在重命名的频道 id
  const [editingUrlId, setEditingUrlId] = useState(null); // 正在改订阅地址的频道 id
  const [groupDraft, setGroupDraft] = useState({});        // 频道分组输入草稿 { feedId: string }（提交式：打字不发请求）
  const [renamingGroup, setRenamingGroup] = useState(null); // 正在重命名的分组名（v2.9.0 新增）
  const [renamingGroupDraft, setRenamingGroupDraft] = useState(''); // 组重命名草稿（提交式）
  const [busyFeed, setBusyFeed] = useState('');        // 单频道「立即抓取」中的 id
  const [busy, setBusy] = useState('');                // '' | 'add' | 'import' | 'all' | 'save'
  // 某个频道有保存中的请求时禁用该行控件（复刻旧实现的逐控件 disabled，防重复提交）
  const [pendingIds, setPendingIds] = useState(() => new Set());
  const [drop, setDrop] = useState(null);              // 拖拽落点指示 { type, id, group, before }
  const [dragging, setDragging] = useState(false);
  const [feedQuery, setFeedQuery] = useState('');      // 频道搜索（本地过滤，应对大量频道）

  const paneRef = useRef(null);
  const urlRef = useRef(null);
  const renameInputRef = useRef(null);
  const urlEditRef = useRef(null);
  const groupRenameInputRef = useRef(null);
  const renameDone = useRef(false);
  const urlEditDone = useRef(false);
  const dragRef = useRef(null);
  const moveRef = useRef(null);
  const endRef = useRef(null);

  /* ---- 实时读取共享 state（单一数据源） ---- */
  const st = (S() && S().state) || {};
  const feeds = st.feedList || [];
  const meta = st.feedMeta || {};
  const groups = (S() && S().groupFeeds) ? S().groupFeeds(feeds) : [];

  // 频道搜索过滤：默认空串时 displayGroups === groups（零行为变化，拖拽/分组测试不受影响）
  const fq = feedQuery.trim().toLowerCase();
  const displayGroups = fq
    ? groups
      .map((g) => ({
        name: g.name,
        feeds: (g.feeds || []).filter((f) => (
          `${f.title || ''} ${f.customTitle || ''} ${f.url || ''} ${f.groupName || ''}`.toLowerCase().includes(fq)
        )),
      }))
      .filter((g) => g.feeds.length)
    : groups;

  const total = meta.total || 0;
  const onCount = meta.enabled || 0;
  const cardCount = meta.cardEnabled == null ? onCount : meta.cardEnabled;
  const groupNames = meta.groups || [];
  const globalMins = meta.refreshMinutes || 30;
  const ownFreqCount = feeds.filter((f) => f.refreshMinutes != null).length;

  /* ---- 稳定回调（拖拽监听器的 add/remove 需要同一引用） ---- */
  const pushSummary = useCallback(() => {
    const s = S();
    if (s && s.setSettingsSummary && s.getSettingsSummary) s.setSettingsSummary(s.getSettingsSummary());
  }, []);

  const loadConfig = useCallback(async () => {
    try {
      const res = await S().apiFetch('/api/config');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const src = data.source || {};
      setCfg({
        refreshMinutes: String(src.refreshMinutes == null ? '' : src.refreshMinutes),
        keepPerFeed: String(src.keepPerFeed == null ? '' : src.keepPerFeed),
        keepDays: String(src.keepDays == null ? 0 : src.keepDays),
        timeoutSeconds: String(src.timeoutSeconds == null ? '' : src.timeoutSeconds),
        concurrency: String(src.concurrency == null ? '' : src.concurrency),
        autoRefreshMinutes: String(src.autoRefreshMinutes == null ? 0 : src.autoRefreshMinutes),
        proxyUrl: String(src.proxyUrl || ''),
        imgTtlDays: String(src.imgTtlDays == null ? '' : src.imgTtlDays),
        imgKeepDays: String(src.imgKeepDays == null ? '' : src.imgKeepDays),
        imgMaxDim: String(src.imgMaxDim == null ? '' : src.imgMaxDim),
        imgQuality: String(src.imgQuality == null ? '' : src.imgQuality),
        feedFailLimit: String(src.feedFailLimit == null ? '' : src.feedFailLimit),
      });
      setCfgLoaded(true);
      // 图片缓存统计失败不阻塞参数回填（面板照常可用，只是看不到张数）
      try {
        const sres = await S().apiFetch('/api/image-cache');
        if (sres.ok) {
          const sd = await sres.json();
          setImgStats({ count: Number(sd.count) || 0, bytes: Number(sd.bytes) || 0 });
        }
      } catch (_) { /* 统计接口异常时保持兜底 */ }
    } catch (err) {
      // 拉取失败：保持兜底值 + 禁止保存（旧实现此时直接把整个面板打成读取失败，这里更健壮）
      setCfgLoaded(false);
      const s = S();
      if (s && s.toast) s.toast('采集参数读取失败：' + String((err && err.message) || err), false);
    }
  }, []);

  const reloadFeeds = useCallback(async () => {
    await S().loadFeeds();
    bump();
    pushSummary();
  }, [bump, pushSummary]);

  /** 频道行的开关 / 分组 / 频率 / 重命名 / 订阅地址统一走这里（旧 patchFeed 的迁移）。
   *  返回响应 JSON（改地址要用它带回的 probe 判断新地址能不能抓到）。 */
  const patchFeed = useCallback(async (id, patch, okMsg) => {
    const s = S();
    const key = String(id);
    setPendingIds((p) => { const n = new Set(p); n.add(key); return n; });
    try {
      // 注意合并顺序：jsonPost 自带 method:'POST'，必须后覆盖回 PATCH
      const res = await s.apiFetch('/api/feeds/' + id, Object.assign(jsonPost(patch), { method: 'PATCH' }));
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
      if (okMsg && s.toast) s.toast(okMsg);
      await reloadFeeds();
      s.state.tag = null;
      if (s.loadPage) await s.loadPage(true);
      if (s.renderReaderChannels) s.renderReaderChannels();
      return data;
    } finally {
      setPendingIds((p) => { const n = new Set(p); n.delete(key); return n; });
    }
  }, [reloadFeeds]);

  // 按 groupOrder 把分组铺平为全局数组（组内保持相对顺序），并给每组重算 sort_order
  const flattenAndRenumber = useCallback((grouped) => {
    const s = S();
    const order = s.state.groupOrder || [];
    const seq = [];
    for (const n of order) { const g = grouped.find((x) => x.name === n); if (g) seq.push(g); }
    for (const g of grouped) if (order.indexOf(g.name) < 0) seq.push(g);
    const flat = [];
    let so = 0;
    for (const g of seq) for (const f of g.feeds) { f.sortOrder = so++; flat.push(f); }
    s.state.feedList = flat;
  }, []);

  const persistReorder = useCallback(async () => {
    const s = S();
    const items = (s.state.feedList || []).map((f) => ({ id: f.id, sortOrder: f.sortOrder, groupName: f.groupName || '' }));
    try {
      await s.apiFetch('/api/feeds/reorder', jsonPost({ feeds: items }));
    } catch (e) {
      console.error('保存排序失败', e);
      if (s.toast) s.toast('排序保存失败');
    }
  }, []);

  const persistGroupOrder = useCallback(async () => {
    try {
      // 分组顺序是「每用户」偏好，走 /api/prefs（普通用户也能保存自己的分组顺序）
      await S().apiFetch('/api/prefs', jsonPost({ groupOrder: S().state.groupOrder }));
    } catch (e) { console.error('保存分组顺序失败', e); }
  }, []);

  const groupOfRow = useCallback((row) => {
    const id = row.getAttribute('data-id');
    if (!id) return '';
    const f = (S().state.feedList || []).find((x) => String(x.id) === String(id));
    return f ? (f.groupName || '') : '';
  }, []);

  const applyFeedReorder = useCallback((ctx) => {
    const s = S();
    const dragId = ctx.id;
    const grouped = s.groupFeeds(s.state.feedList);
    for (const g of grouped) {
      const i = g.feeds.findIndex((f) => String(f.id) === String(dragId));
      if (i >= 0) { g.feeds.splice(i, 1); break; }
    }
    const t = ctx.target;
    let gi = grouped.findIndex((g) => g.name === t.group);
    if (gi < 0) { grouped.push({ name: t.group || '', feeds: [] }); gi = grouped.length - 1; }
    let idx;
    if (t.type === 'head') idx = 0;
    else {
      const tid = t.id;
      idx = grouped[gi].feeds.findIndex((f) => String(f.id) === String(tid));
      if (idx < 0) idx = grouped[gi].feeds.length;
      else if (!t.before) idx += 1;
    }
    const dragFeed = (s.state.feedList || []).find((f) => String(f.id) === String(dragId));
    if (!dragFeed) return;
    dragFeed.groupName = t.group || '';
    grouped[gi].feeds.splice(idx, 0, dragFeed);
    flattenAndRenumber(grouped);
    bump();
    if (s.renderReaderChannels) s.renderReaderChannels();
    if (s.renderFeedSelect) s.renderFeedSelect();
    persistReorder();
  }, [bump, flattenAndRenumber, persistReorder]);

  const applyGroupReorder = useCallback((ctx) => {
    const s = S();
    const order = (s.state.groupOrder || []).slice();
    const i = order.indexOf(ctx.group);
    if (i >= 0) order.splice(i, 1);
    const t = ctx.target;
    let j = order.indexOf(t.group);
    if (j < 0) j = order.length;
    else if (!t.before) j += 1;
    order.splice(j, 0, ctx.group);
    s.state.groupOrder = order;
    const grouped = s.groupFeeds(s.state.feedList);
    flattenAndRenumber(grouped);
    bump();
    if (s.renderReaderChannels) s.renderReaderChannels();
    if (s.renderFeedSelect) s.renderFeedSelect();
    persistReorder();
    persistGroupOrder();
  }, [bump, flattenAndRenumber, persistGroupOrder, persistReorder]);

  // 手动填序号：把某频道排到所在分组的第 N 位（1 基），与拖拽并存。
  // 只在「本组」内调整顺序；跨组仍用拖拽（拖拽会改 groupName）。
  const applyNumericOrder = useCallback((id, pos) => {
    const s = S();
    if (!Number.isFinite(pos) || pos < 1) { bump(); return; }   // 非法输入：恢复显示
    const grouped = s.groupFeeds(s.state.feedList);
    let src = null;
    for (const g of grouped) {
      const i = g.feeds.findIndex((f) => String(f.id) === String(id));
      if (i >= 0) { src = g; break; }
    }
    if (!src) return;
    const feed = src.feeds.splice(src.feeds.findIndex((f) => String(f.id) === String(id)), 1)[0];
    const p = Math.min(Math.max(1, Math.floor(pos)), src.feeds.length + 1);
    src.feeds.splice(p - 1, 0, feed);
    flattenAndRenumber(grouped);   // 重算全局 sort_order（组内顺序由它决定）
    bump();
    if (s.renderReaderChannels) s.renderReaderChannels();
    if (s.renderFeedSelect) s.renderFeedSelect();
    persistReorder();
  }, [bump, flattenAndRenumber, persistReorder]);

  /* ---- 拖拽（Pointer 事件，移植自旧实现） ---- */
  const onDragMove = useCallback((ev) => {
    const ctx = dragRef.current;
    if (!ctx) return;
    if (!ctx.moved) {
      if (Math.hypot(ev.clientX - ctx.x0, ev.clientY - ctx.y0) < 6) return;
      ctx.moved = true;
      setDragging(true);
      document.body.classList.add('is-dragging-feeds');
    }
    ev.preventDefault();
    // 拖动的源元素隐藏命中，便于 elementFromPoint 找到真正的放置目标
    if (ctx.el) ctx.el.style.pointerEvents = 'none';
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    if (!under) { ctx.target = null; setDrop(null); return; }
    if (ctx.kind === 'feed') {
      const row = under.closest('.feed-row');
      const head = under.closest('.feed-group-head');
      let elm = null, before = true, group = '';
      if (row && ctx.el && !row.contains(ctx.el)) {
        const r = row.getBoundingClientRect();
        before = ev.clientY < r.top + r.height / 2;
        elm = row; group = groupOfRow(row);
      } else if (head && ctx.el && !head.contains(ctx.el)) {
        elm = head; group = head.getAttribute('data-group') || ''; before = true;
      }
      if (!elm) { ctx.target = null; setDrop(null); return; }
      ctx.target = { type: elm === head ? 'head' : 'row', id: elm.getAttribute('data-id') || '', group, before };
      setDrop(ctx.target);
    } else {
      const head = under.closest('.feed-group-head');
      let elm = null, before = true;
      if (head && ctx.el && !head.contains(ctx.el)) {
        const r = head.getBoundingClientRect();
        before = ev.clientY < r.top + r.height / 2;
        elm = head;
      }
      if (!elm) { ctx.target = null; setDrop(null); return; }
      ctx.target = { type: 'group', id: '', group: head.getAttribute('data-group') || '', before };
      setDrop(ctx.target);
    }
  }, [groupOfRow]);

  const onDragEnd = useCallback(() => {
    document.removeEventListener('pointermove', moveRef.current);
    document.removeEventListener('pointerup', endRef.current);
    document.removeEventListener('pointercancel', endRef.current);
    document.body.classList.remove('is-dragging-feeds');
    const ctx = dragRef.current;
    dragRef.current = null;
    setDragging(false);
    setDrop(null);
    if (ctx && ctx.el) ctx.el.style.pointerEvents = '';
    if (!ctx || !ctx.moved || !ctx.target) return;
    if (ctx.kind === 'feed') applyFeedReorder(ctx);
    else applyGroupReorder(ctx);
  }, [applyFeedReorder, applyGroupReorder]);

  moveRef.current = onDragMove;
  endRef.current = onDragEnd;

  const onGripDown = (ev, kind, payload) => {
    if (ev.button != null && ev.button !== 0) return;
    if (kind === 'group' && payload.group === '') return;   // 「未分组」不可拖动（仍可作放置目标）
    const el = ev.target.closest(kind === 'feed' ? '.feed-row' : '.feed-group-head');
    if (!el) return;
    ev.preventDefault();
    dragRef.current = {
      kind, id: payload.id, group: payload.group, el,
      x0: ev.clientX, y0: ev.clientY, moved: false, target: null,
    };
    document.addEventListener('pointermove', moveRef.current, { passive: false });
    document.addEventListener('pointerup', endRef.current);
    document.addEventListener('pointercancel', endRef.current);
  };

  /* ---- 副作用 ---- */
  // 进入面板：拉频道列表（走桥，同步共享 state 与侧栏）；间隔刚可能被改过，重启定时器（同旧实现）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await S().loadFeeds();
        if (cancelled) return;
        setLoadError('');
      } catch (err) {
        if (!cancelled) setLoadError(String((err && err.message) || err));
        return;
      }
      bump();
      pushSummary();
      const s = S();
      if (s.scheduleAutoRefresh) s.scheduleAutoRefresh();
    })();
    return () => { cancelled = true; };
  }, [bump, pushSummary]);

  // 采集参数：管理员才拉（普通用户看不到这一段，也不该碰 /api/config）
  useEffect(() => {
    if (admin && !cfgLoaded) loadConfig();
  }, [admin, cfgLoaded, loadConfig]);

  // 可折叠分组：套上按账号记住的开合状态并监听变化（与旧 bindSections 同一机制）
  useEffect(() => {
    const s = S();
    if (s && s.bindSections && paneRef.current) s.bindSections(paneRef.current);
  }, [admin]);

  useEffect(() => {
    document.body.classList.toggle('is-dragging-feeds', dragging);
    return () => document.body.classList.remove('is-dragging-feeds');
  }, [dragging]);

  // 成功提示 4 秒后自动淡出（复刻旧 showResult 的 ok 态行为）
  useEffect(() => {
    if (!result || !result.ok) return;
    const t = setTimeout(() => setResult(null), 4000);
    return () => clearTimeout(t);
  }, [result]);

  // 重命名输入框：挂上即聚焦并全选
  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  // 订阅地址输入框：同样挂上即聚焦并全选（改地址基本是整串替换）
  useEffect(() => {
    if (editingUrlId && urlEditRef.current) {
      urlEditRef.current.focus();
      urlEditRef.current.select();
    }
  }, [editingUrlId]);

  // 分组重命名输入框（v2.9.0）：挂上即聚焦并全选
  useEffect(() => {
    if (renamingGroup && groupRenameInputRef.current) {
      groupRenameInputRef.current.focus();
      groupRenameInputRef.current.select();
    }
  }, [renamingGroup]);

  // 卸载时收尾：拖拽中的 document 监听 / body 类名 / 源元素命中恢复
  useEffect(() => () => {
    document.removeEventListener('pointermove', moveRef.current);
    document.removeEventListener('pointerup', endRef.current);
    document.removeEventListener('pointercancel', endRef.current);
    document.body.classList.remove('is-dragging-feeds');
    const ctx = dragRef.current;
    if (ctx && ctx.el) ctx.el.style.pointerEvents = '';
  }, []);

  /* ---- 动作 ---- */
  const onAdd = async () => {
    const u = url.trim();
    if (!u) { setResult({ ok: false, msg: '请先填入 RSS 地址' }); if (urlRef.current) urlRef.current.focus(); return; }
    const s = S();
    setBusy('add');
    setResult(null);
    try {
      const res = await s.apiFetch('/api/feeds', jsonPost({ url: u }));
      const data = await res.json();
      if (!res.ok) { setResult({ ok: false, msg: data.error || '添加失败' }); return; }
      setUrl('');
      setResult({ ok: true, msg: `已添加「${s.shortFeedName(s.feedTitle(data.feed))}」，新增 ${data.added} 条` });
      s.toast('订阅已添加');
      await reloadFeeds();
      s.state.tag = null;
      if (s.loadPage) await s.loadPage(true);
    } catch (err) {
      setResult({ ok: false, msg: '添加失败：' + (err.message || err) });
    } finally {
      setBusy('');
    }
  };

  const onImport = async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = '';   // 允许重新选择同一文件
    if (!file) return;
    const s = S();
    setBusy('import');
    try {
      const text = await file.text();
      const res = await s.apiFetch('/api/feeds/import', jsonPost({ opml: text }));
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '导入失败');
      const parts = [`已导入 ${data.added} 个新频道`];
      if (data.duplicated) parts.push(`跳过 ${data.duplicated} 个重复`);
      if (data.groups && data.groups.length) parts.push(`${data.groups.length} 个分组`);
      setResult({ ok: true, msg: parts.join(' · ') });
      await reloadFeeds();
    } catch (err) {
      setResult({ ok: false, msg: '导入失败：' + (err.message || err) });
    } finally {
      setBusy('');
    }
  };

  const onRefreshAll = async () => {
    const s = S();
    setBusy('all');
    try {
      const res = await s.apiFetch('/api/feeds/refresh', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const failed = (data.failed || []).length;
      setResult({
        ok: !failed,
        msg: failed
          ? `抓取完成，新增 ${data.added} 条，${failed} 个频道失败`
          : `抓取完成，新增 ${data.added} 条`,
      });
      await reloadFeeds();
      s.state.tag = null;
      if (s.loadPage) await s.loadPage(true);
    } catch (err) {
      setResult({ ok: false, msg: '抓取失败：' + (err.message || err) });
    } finally {
      setBusy('');
    }
  };

  const onRefreshFeed = async (id) => {
    const s = S();
    setBusyFeed(id);
    try {
      const res = await s.apiFetch('/api/feeds/' + id + '/refresh', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error((data.result && data.result.error) || '抓取失败');
      s.toast(data.result.added ? `新增 ${data.result.added} 条` : '没有新内容');
      await reloadFeeds();
      if (s.loadPage) await s.loadPage(true);
    } catch (err) {
      s.toast('抓取失败：' + (err.message || err), false);
    } finally {
      setBusyFeed('');
    }
  };

  const onDelete = async (f) => {
    const s = S();
    const name = s.shortFeedName(s.feedTitle(f));
    const ok = await s.confirm({
      title: `删除订阅「${name}」？`,
      desc: '该频道已抓取的条目会一并删除，且不可恢复。',
      confirmText: '删除订阅',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await s.apiFetch('/api/feeds/' + f.id, { method: 'DELETE' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      s.toast('订阅已删除');
      await reloadFeeds();
      s.state.tag = null;
      if (s.loadPage) await s.loadPage(true);
    } catch (err) {
      s.toast('删除失败：' + (err.message || err), false);
    }
  };

  const onSaveCfg = async () => {
    if (!cfgLoaded) { setResult({ ok: false, msg: '设置尚未加载完成，请稍后再试' }); return; }
    const s = S();
    setBusy('save');
    try {
      const res = await s.apiFetch('/api/config', jsonPost({
        source: {
          refreshMinutes: cfg.refreshMinutes,
          keepPerFeed: cfg.keepPerFeed,
          keepDays: cfg.keepDays,
          timeoutSeconds: cfg.timeoutSeconds,
          concurrency: cfg.concurrency,
          autoRefreshMinutes: cfg.autoRefreshMinutes,
          proxyUrl: cfg.proxyUrl,
          imgTtlDays: cfg.imgTtlDays,
          imgKeepDays: cfg.imgKeepDays,
          imgMaxDim: cfg.imgMaxDim,
          imgQuality: cfg.imgQuality,
          feedFailLimit: cfg.feedFailLimit,
        },
      }));
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setResult({ ok: false, msg: data.error || '保存失败' }); return; }
      // 表单保存只用内联结果，不再叠一层 toast（列表级动作才用 toast）
      setResult({ ok: true, msg: '抓取设置已保存' });
      if (s.scheduleAutoRefresh) s.scheduleAutoRefresh();   // 立刻按新的「页面自动刷新」间隔重排
    } catch (err) {
      setResult({ ok: false, msg: '保存失败：' + (err.message || err) });
    } finally {
      setBusy('');
    }
  };

  /** 清空图片缓存（v2.4.0）：删库 + 清 L1，下次访问按新压缩参数重新缓存 */
  const onClearImgCache = async () => {
    const s = S();
    const n = Number(imgStats.count) || 0;
    const ok = await s.confirm({
      title: `清空图片缓存（${n} 张）？`,
      desc: '已缓存的图片会从库里删除，下次浏览时按当前压缩参数重新缓存。',
      confirmText: '清空缓存',
      danger: true,
    });
    if (!ok) return;
    setBusy('imgclear');
    try {
      const res = await s.apiFetch('/api/image-cache/clear', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
      setImgStats({ count: 0, bytes: 0 });
      s.toast(`已清空 ${data.removed} 张缓存图片`);
    } catch (err) {
      s.toast('清空失败：' + (err.message || err), false);
    } finally {
      setBusy('');
    }
  };

  /* ---- 频道行动作 ---- */
  const onToggle = async (f, key, next, okMsg) => {
    const s = S();
    try {
      await patchFeed(f.id, { [key]: next }, okMsg);
    } catch (err) {
      bump();   // 受控控件回滚：强制重绘让 checked 回到服务端值（无重绘 DOM 会停留在错误态）
      s.toast('保存失败：' + (err.message || err), false);
    }
  };

  /* ---- 频道分组：提交式（v2.9.0 重写） ----
   * 旧实现是 onChange 即 PATCH：每敲一个字符就发一次请求 + reloadFeeds 全量刷新，
   * 输入框 key 又随 groupName 变化被重挂载 —— 表现为「无法输入文字」。
   * 现在打字只写本地草稿，失焦 / 回车才提交；Escape 清空草稿恢复原值。 */
  const setGroupDraftFor = (id, v) => setGroupDraft((d) => Object.assign({}, d, { [id]: v }));
  const clearGroupDraft = (id) => setGroupDraft((d) => { const n = Object.assign({}, d); delete n[id]; return n; });

  const commitGroup = useCallback(async (f) => {
    const id = String(f.id);
    const draft = groupDraft[id];
    clearGroupDraft(id);
    if (draft === undefined) return;                    // 没编辑过（blur 也可能来自其它交互）
    const val = String(draft || '').trim().slice(0, 40);
    if (val === (f.groupName || '')) return;            // 没变
    try {
      await patchFeed(f.id, { groupName: val }, val ? `已归入「${val}」` : '已移出分组');
    } catch (err) {
      const s = S();
      if (s && s.toast) s.toast('保存失败：' + String((err && err.message) || err), false);
    }
  }, [groupDraft, patchFeed]);

  /* ---- 分组重命名（v2.9.0 新增）：一次改组 + 同步分组顺序 ----
   * 语义：把组内所有频道改到新组名；新名与已有组同名时相当于「合并分组」。
   * 逐个 PATCH（每组频道数有限），不新增批量接口。 */
  const startGroupRename = (g) => { setRenamingGroupDraft(g.name); setRenamingGroup(g.name); };

  const commitGroupRename = useCallback(async (g, rawNext) => {
    const s = S();
    setRenamingGroup(null);
    const oldName = String(g.name || '');
    const val = String(rawNext == null ? '' : rawNext).trim().slice(0, 40);
    if (!val || val === oldName) return;
    const members = (s.state.feedList || []).filter((f) => String(f.groupName || '').trim() === oldName);
    try {
      for (const f of members) {
        await s.apiFetch('/api/feeds/' + f.id, Object.assign(jsonPost({ groupName: val }), { method: 'PATCH' }));
      }
      // 分组顺序里的旧名换新名（旧名不在顺序里就把新名追加到末尾）
      const order = (s.state.groupOrder || []).slice();
      const i = order.indexOf(oldName);
      if (i >= 0) order.splice(i, 1, val);
      else if (order.indexOf(val) < 0) order.push(val);
      s.state.groupOrder = order;
      await s.apiFetch('/api/prefs', jsonPost({ groupOrder: order }));
      s.toast(`分组已改名「${val}」${members.length ? `（${members.length} 个频道）` : ''}`);
      await reloadFeeds();
      if (s.renderReaderChannels) s.renderReaderChannels();
      if (s.renderFeedSelect) s.renderFeedSelect();
    } catch (err) {
      if (s && s.toast) s.toast('分组改名失败：' + String((err && err.message) || err), false);
      await reloadFeeds().catch(() => {});
    }
  }, [reloadFeeds]);

  const onFreqChange = async (f, ev) => {
    const s = S();
    const next = ev.target.value === '' ? null : Number(ev.target.value);
    const cur = f.refreshMinutes == null ? null : Number(f.refreshMinutes);
    if (cur === next) return;
    try {
      await patchFeed(f.id, { refreshMinutes: next },
        next == null ? '已改为跟随全局频率' : `该频道已设为每 ${fmtMinutes(next)}抓取`);
    } catch (err) {
      bump();   // 受控下拉回滚到服务端值
      s.toast('保存失败：' + (err.message || err), false);
    }
  };

  const onOrderChange = (f, order, ev) => {
    const pos = parseInt(ev.target.value, 10);
    if (!Number.isFinite(pos) || pos < 1) { ev.target.value = String(order); return; }   // 非法输入：恢复显示
    applyNumericOrder(f.id, pos);
  };

  const onHeadClick = (ev, g) => {
    if (ev.target.closest('.drag-handle')) return;   // 手柄区域是拖拽，不触发折叠
    const next = new Set(collapsed);
    if (next.has(g.name)) next.delete(g.name); else next.add(g.name);
    setCollapsed(next);
    const s = S();
    if (s.state) s.state.collapsedGroups = next;
    if (s.setLayout) s.setLayout('collapsedGroups', [...next]);
  };

  /* ---- 重命名（受控编辑态；旧实现是命令式就地改 innerHTML） ---- */
  const startRename = (id) => { renameDone.current = false; setRenamingId(id); };

  const finishRename = (f, commit) => {
    if (renameDone.current) return;
    renameDone.current = true;
    const v = renameInputRef.current ? renameInputRef.current.value : '';
    setRenamingId(null);
    if (!commit) return;
    const val = String(v || '').trim();
    const cur = S().feedTitle(f);
    if (!val || val === cur) return;
    patchFeed(f.id, { title: val }, '名称已更新').catch(() => { /* 输入框已收回，无需恢复 */ });
  };

  /* ---- 改订阅地址 ----
   * 校验与「同用户 URL 唯一」判重都在后端（与新增共用 rss.assertFeedUrl），这里只处理编辑态；
   * 服务端改完会按新地址当场试抓一次，结果走 probe 反馈。 */
  const startEditUrl = (id) => { urlEditDone.current = false; setEditingUrlId(id); };

  const finishEditUrl = (f, commit) => {
    if (urlEditDone.current) return;
    urlEditDone.current = true;
    const v = urlEditRef.current ? urlEditRef.current.value : '';
    setEditingUrlId(null);
    const s = S();
    if (!commit) return;
    const val = String(v || '').trim();
    if (!val || val === f.url) return;
    patchFeed(f.id, { url: val }, '订阅地址已更新').then((data) => {
      const probe = data && data.probe;
      if (!probe) return;
      if (!probe.ok) s.toast('新地址抓取失败：' + (probe.error || '未知错误') + '（地址已保存，下个周期自动重试）', false);
      else if (probe.added) s.toast('新地址可用：本次新增 ' + probe.added + ' 条');
    }).catch((err) => {
      s.toast('地址未更新：' + (err.message || err), false);
    });
  };

  /* ---- 采集参数摘要行（收起时也能看到当前值） ---- */
  const paramsSub = (() => {
    const keepDays = Number(cfg.keepDays || 0);
    const keepDaysText = keepDays > 0
      ? (KEEP_DAYS_OPTIONS.find(([v]) => v === keepDays) || [null, `${keepDays} 天`])[1]
      : '不限时长';
    const auto = Number(cfg.autoRefreshMinutes || 0);
    const keepN = Number(cfg.keepPerFeed || 0);
    const keepNText = keepN > 0 ? `${keepN} 条` : '不限条数';
    const proxy = String(cfg.proxyUrl || '').trim();
    const proxyText = proxy ? ` · 代理 ${proxy.replace(/\/\/[^@]*@/, '//***@')}` : '';
    return `每 ${fmtMinutes(cfg.refreshMinutes)}抓取 · 保留 ${keepNText}`
      + ` · ${keepDaysText}`
      + (auto ? ` · 页面刷新 ${fmtMinutes(auto)}` : '')
      + proxyText;
  })();

  /* ---- 渲染 ---- */
  const rowDropCls = (f) => (
    drop && drop.type === 'row' && String(drop.id) === String(f.id)
      ? (drop.before ? ' drag-over-before' : ' drag-over-after')
      : ''
  );
  const headDropCls = (g) => (
    drop && (drop.type === 'head' || drop.type === 'group') && drop.group === g.name
      ? (drop.before ? ' drag-over-before' : ' drag-over-after')
      : ''
  );

  const renderRow = (f, order) => {
    const s = S();
    // 该行有保存中的请求：禁用本行控件（复刻旧实现的逐控件 disabled，防重复提交）
    const pend = pendingIds.has(String(f.id));
    const name = s.shortFeedName(s.feedTitle(f));
    const avatar = <FeedAvatar icon={f.icon} name={name} />;
    return (
      <div
        key={f.id}
        className={'feed-row' + (f.enabled ? '' : ' off') + (f.cardEnabled ? '' : ' no-card') + rowDropCls(f)}
        data-id={f.id}
      >
        <span
          className="drag-handle"
          title="拖动排序：组内重排，或拖到其它分组"
          aria-label="拖动排序"
          onPointerDown={(ev) => onGripDown(ev, 'feed', { id: f.id })}
        >
          {GRIP}
        </span>
        <input
          className="feed-order"
          type="number"
          min="1"
          key={order}
          defaultValue={order}
          data-order={f.id}
          title="序号：填数字调整在本组内的顺序（与拖拽并存）"
          aria-label="序号"
          onChange={(ev) => onOrderChange(f, order, ev)}
        />
        {avatar}
        <div className="feed-info">
          {renamingId === f.id ? (
            <input
              ref={renameInputRef}
              className="feed-title-edit"
              type="text"
              maxLength={200}
              defaultValue={s.feedTitle(f)}
              spellCheck={false}
              autoComplete="off"
              onKeyDown={(ev) => {
                if (ev.key === 'Enter') { ev.preventDefault(); finishRename(f, true); }
                else if (ev.key === 'Escape') { ev.preventDefault(); finishRename(f, false); }
              }}
              onBlur={() => finishRename(f, true)}
            />
          ) : (
            <div className="feed-title" title={s.feedTitle(f)}>{name}</div>
          )}
          {editingUrlId === f.id ? (
            <input
              ref={urlEditRef}
              className="feed-url-edit"
              type="text"
              inputMode="url"
              maxLength={600}
              defaultValue={f.url}
              spellCheck={false}
              autoComplete="off"
              title="订阅地址：需以 http:// 或 https:// 开头，改完会立即按新地址试抓一次"
              onKeyDown={(ev) => {
                if (ev.key === 'Enter') { ev.preventDefault(); finishEditUrl(f, true); }
                else if (ev.key === 'Escape') { ev.preventDefault(); finishEditUrl(f, false); }
              }}
              onBlur={() => finishEditUrl(f, true)}
            />
          ) : (
            <div className="feed-url" title={f.url}>{prettyUrl(f.url)}</div>
          )}
          <div className="feed-stat">
            {feedStatusText(f)}{' '}
            {f.status === 'error' ? (
              <span className="err" title={f.error || ''}><Ico name="alert" /> 抓取失败</span>
            ) : null}
          </div>
          <div className="feed-metas">
            <label className="feed-group">
              <span>分组</span>
              <input
                type="text"
                list="groupList"
                data-group={f.id}
                key={'grp-' + f.id}
                value={groupDraft[String(f.id)] !== undefined ? groupDraft[String(f.id)] : (f.groupName || '')}
                placeholder="未分组"
                maxLength={40}
                spellCheck={false}
                autoComplete="off"
                disabled={pend}
                onChange={(ev) => setGroupDraftFor(String(f.id), ev.target.value)}
                onBlur={() => commitGroup(f)}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter') { ev.preventDefault(); ev.currentTarget.blur(); }
                  else if (ev.key === 'Escape') { ev.preventDefault(); clearGroupDraft(String(f.id)); }}
                }
              />
            </label>
            <label className="feed-group">
              <span>频率</span>
              <select
                className={'feed-freq' + (f.refreshMinutes == null ? '' : ' own')}
                data-freq={f.id}
                value={f.refreshMinutes == null ? '' : String(f.refreshMinutes)}
                title="这个频道多久抓一次；未设置则跟随全局"
                disabled={pend}
                onChange={(ev) => onFreqChange(f, ev)}
              >
                <option value="">{`跟随全局（${fmtMinutes(globalMins)}）`}</option>
                {FREQ_OPTIONS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
              </select>
            </label>
          </div>
        </div>
        <div className="feed-actions">
          <label className="feed-sw" title="采集：开启后定时抓取这个频道的新条目">
            <span className="feed-sw-label">采集</span>
            <span className="switch">
              <input
                type="checkbox"
                data-toggle={f.id}
                checked={f.enabled}
                disabled={pend}
                onChange={(ev) => onToggle(f, 'enabled', ev.target.checked, ev.target.checked ? '已开启采集' : '已停止采集')}
              />
              <span className="switch-slider"></span>
            </span>
          </label>
          <label className="feed-sw" title="卡片：开启后在「卡片」页展示这个频道的条目">
            <span className="feed-sw-label">卡片</span>
            <span className="switch">
              <input
                type="checkbox"
                data-card-toggle={f.id}
                checked={f.cardEnabled}
                disabled={pend}
                onChange={(ev) => onToggle(f, 'cardEnabled', ev.target.checked, ev.target.checked ? '已在卡片页展示' : '已从卡片页隐藏')}
              />
              <span className="switch-slider"></span>
            </span>
          </label>
          <button className="feed-icon-btn" data-rename={f.id} title="重命名" type="button" disabled={pend} onClick={() => startRename(f.id)}>
            <Ico name="edit" />
          </button>
          <button
            className="feed-icon-btn"
            data-url={f.id}
            title="修改订阅地址"
            type="button"
            disabled={pend}
            onClick={() => startEditUrl(f.id)}
          >
            <Ico name="link" />
          </button>
          <button
            className="feed-icon-btn"
            data-refresh={f.id}
            title="立即抓取"
            type="button"
            disabled={busyFeed === f.id}
            onClick={() => onRefreshFeed(f.id)}
          >
            {busyFeed === f.id ? '…' : <Ico name="refresh" />}
          </button>
          <button className="feed-icon-btn danger" data-del={f.id} title="删除该订阅" type="button" disabled={pend} onClick={() => onDelete(f)}>
            <Ico name="trash" />
          </button>
        </div>
      </div>
    );
  };

  const setCfgField = (k) => (ev) => setCfg((c) => Object.assign({}, c, { [k]: ev.target.value }));

  return (
    <div className="tab-pane" data-pane="source" ref={paneRef}>
      <div className="pane-scroll">

        {/* 添加订阅：高频动作，常显，不折进分组里 */}
        <div className="source-add">
          <div className="input-with-btn">
            <input
              id="rssUrl"
              type="url"
              placeholder="粘贴 RSS / Atom 地址"
              spellCheck={false}
              autoComplete="off"
              value={url}
              onChange={(ev) => setUrl(ev.target.value)}
              onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); onAdd(); } }}
              ref={urlRef}
            />
            <button
              className="btn btn-primary"
              id="addFeedBtn"
              type="button"
              disabled={busy === 'add'}
              onClick={onAdd}
            >
              {busy === 'add' ? '抓取中…' : '添加'}
            </button>
          </div>
          <div className="source-add-foot">
            <small className="form-tip">
              支持 RSS 2.0 / Atom，例如 <code>https://rsshub.app/telegram/channel/example</code>
            </small>
            <button className="btn" id="importOpmlBtn" type="button" disabled={busy === 'import'} onClick={() => document.getElementById('opmlFile').click()}>
              {busy === 'import' ? '导入中…' : '导入 OPML'}
            </button>
            <button className="btn" id="exportOpmlBtn" type="button" onClick={() => { const s = S(); if (s && s.exportOpml) s.exportOpml(); }}>
              导出 OPML
            </button>
            <input
              type="file"
              id="opmlFile"
              accept=".opml,application/xml,text/xml"
              hidden
              onChange={onImport}
            />
          </div>
          <div className={'test-result' + (result ? ' show ' + (result.ok ? 'ok' : 'err') : '')} id="feedResult" role="status">
            {result ? result.msg : ''}
          </div>
        </div>

        {/* 采集参数：设置一次就不常动，默认收起；收起时标题右侧直接显示当前值（仅管理员） */}
        {admin && (
          <details className="sec" data-sec="src-params">
            <summary className="sec-head">
              <svg className="sec-arrow" aria-hidden="true" focusable="false"><use href="#i-chevron-right" /></svg>
              <span className="sec-title">采集参数</span>
              <span className="sec-sub" id="srcParamsSub">{paramsSub}</span>
            </summary>
            <div className="sec-body">
              <div className="source-opts">
                <label htmlFor="srcRefresh">自动抓取{' '}
                  <select id="srcRefresh" className="select" value={cfg.refreshMinutes} onChange={setCfgField('refreshMinutes')}>
                    {REFRESH_OPTIONS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
                  </select>
                </label>
                <label htmlFor="srcKeep">每频道保留{' '}
                  <input
                    id="srcKeep"
                    type="number"
                    min="0"
                    max="5000"
                    step="20"
                    value={cfg.keepPerFeed}
                    placeholder="0 = 不限"
                    onChange={setCfgField('keepPerFeed')}
                  />{' '}
                  条
                </label>
                <label htmlFor="srcKeepDays">最长保留{' '}
                  <select id="srcKeepDays" className="select" value={cfg.keepDays} onChange={setCfgField('keepDays')}>
                    {KEEP_DAYS_OPTIONS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
                  </select>
                </label>
                <label htmlFor="srcTimeout">抓取超时{' '}
                  <input
                    id="srcTimeout"
                    type="number"
                    min="5"
                    max="120"
                    step="5"
                    value={cfg.timeoutSeconds}
                    onChange={setCfgField('timeoutSeconds')}
                  />{' '}
                  秒
                </label>
                <label htmlFor="srcConcurrency">抓取并发{' '}
                  <input
                    id="srcConcurrency"
                    type="number"
                    min="1"
                    max="10"
                    step="1"
                    value={cfg.concurrency}
                    onChange={setCfgField('concurrency')}
                  />{' '}
                  个
                </label>
                <label htmlFor="srcFeedFailLimit">连续失败自动停用{' '}
                  <input
                    id="srcFeedFailLimit"
                    type="number"
                    min="2"
                    max="20"
                    step="1"
                    value={cfg.feedFailLimit}
                    placeholder="5"
                    onChange={setCfgField('feedFailLimit')}
                  />{' '}
                  次
                </label>
                <label className="src-proxy-row" htmlFor="srcProxy">出网代理{' '}
                  <input
                    id="srcProxy"
                    type="text"
                    placeholder="留空 = 直连"
                    autoComplete="off"
                    spellCheck={false}
                    value={cfg.proxyUrl}
                    onChange={setCfgField('proxyUrl')}
                  />
                </label>
                <label htmlFor="srcAutoRefresh">页面自动刷新{' '}
                  <select id="srcAutoRefresh" className="select" value={cfg.autoRefreshMinutes} onChange={setCfgField('autoRefreshMinutes')}>
                    {AUTO_REFRESH_OPTIONS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
                  </select>
                </label>
                <label htmlFor="srcImgTtl">图片回源窗口{' '}
                  <select id="srcImgTtl" className="select" value={cfg.imgTtlDays} onChange={setCfgField('imgTtlDays')}>
                    {withCurrentOption(IMG_TTL_OPTIONS, cfg.imgTtlDays).map(([v, t]) => <option key={v} value={v}>{t}</option>)}
                  </select>
                </label>
                <label htmlFor="srcImgKeep">图片保留{' '}
                  <select id="srcImgKeep" className="select" value={cfg.imgKeepDays} onChange={setCfgField('imgKeepDays')}>
                    {withCurrentOption(IMG_KEEP_OPTIONS, cfg.imgKeepDays).map(([v, t]) => <option key={v} value={v}>{t}</option>)}
                  </select>
                </label>
                <label htmlFor="srcImgMaxDim">图片最长边{' '}
                  <input
                    id="srcImgMaxDim"
                    type="number"
                    min="320"
                    max="4096"
                    step="80"
                    value={cfg.imgMaxDim}
                    placeholder="1280"
                    onChange={setCfgField('imgMaxDim')}
                  />{' '}
                  px
                </label>
                <label htmlFor="srcImgQuality">图片质量{' '}
                  <input
                    id="srcImgQuality"
                    type="number"
                    min="30"
                    max="100"
                    step="1"
                    value={cfg.imgQuality}
                    placeholder="78"
                    onChange={setCfgField('imgQuality')}
                  />{' '}
                  / 100
                </label>
                <div className="src-img-cache">
                  <span className="src-img-cache-stat">
                    图片缓存 <strong>{imgStats.count}</strong> 张 · {fmtBytes(imgStats.bytes)}
                  </span>
                  <button
                    className="btn btn-ghost"
                    id="clearImgCacheBtn"
                    type="button"
                    title="删除全部已缓存图片（库 + 内存），下次访问按当前压缩参数重新缓存"
                    disabled={busy === 'imgclear' || !imgStats.count}
                    onClick={onClearImgCache}
                  >
                    {busy === 'imgclear' ? '清空中…' : '清空图片缓存'}
                  </button>
                </div>
              </div>
              <small className="form-tip">
                条目同时受两个上限约束：每个频道最多保留上面「每频道保留」的条数，且发布时间早于「最长保留」的一律清理。
                「每频道保留」填 0 表示无条数上限，只按时长清理；「最长保留」选「不限时长」则只按条数清理。两者都设上限才会同时生效。
                收藏的条目不受这两条限制，不会被清理。
                「自动抓取」是服务端去源站取新内容；「页面自动刷新」只是让打开的页面重新读一次列表，不触发抓取。
                每个频道还能在下方单独指定抓取频率，未设置的跟随全局。
                「出网代理」抓 RSS 和代理图片都走这里；支持 <code>http://</code>、<code>https://</code>、<code>socks5://</code>（含账号可写 <code>http://user:pass@host:port</code>）；留空走默认出网。保存后下次抓取生效。
                「连续失败自动停用」：频道连续抓取失败达到此次数就自动停止它的采集（不再每轮重试打扰源站），在「状态 → 异常频道」里重试成功会自动恢复采集，手动重新打开采集开关也会清零计数。
                图片部分：全站图片（卡片图 / 阅读大图 / 频道头像 / 灯箱）走统一代理永久缓存在数据库，「图片最长边」「图片质量」控制 WebP 压缩强度——越小越省空间也越模糊；
                「图片回源窗口」内的重复访问不再请求上游，超过窗口仍先返回旧图、后台静默刷新；「图片保留」到期后由每日清理删除。
                改动保存后对之后新缓存的图片生效；点「清空图片缓存」可立即按新参数重新缓存全部图片。
              </small>
            </div>
          </details>
        )}

        {/* 频道列表：日常最常看，默认展开 */}
        <details className="sec" data-sec="src-feeds" open>
          <summary className="sec-head">
            <svg className="sec-arrow" aria-hidden="true" focusable="false"><use href="#i-chevron-right" /></svg>
            <span className="sec-title">频道列表</span>
            <span className="sec-sub" id="feedToolbarHint">
              {total
                ? `${total} 个频道${groupNames.length ? ` · ${groupNames.length} 个分组` : ''}`
                  + `${ownFreqCount ? ` · ${ownFreqCount} 个单独设了频率` : ''}`
                  + ' · 改分组或频率后即保存'
                : ''}
            </span>
          </summary>
          <div className="sec-body">
            <div className="feed-filter">
              <svg className="feed-filter-ico" aria-hidden="true" focusable="false"><use href="#i-search" /></svg>
              <input className="feed-filter-input" type="search" value={feedQuery}
                placeholder="搜索频道（名称 / 地址 / 分组）" aria-label="搜索频道"
                onChange={(ev) => setFeedQuery(ev.target.value)} />
            </div>
            <div className="feed-list" id="feedList">
              {fq && !displayGroups.length ? <div className="hint pane-msg">没有匹配的频道</div> : null}
              {loadError ? (
                <div className="hint pane-msg lg">{`读取失败：${loadError}`}</div>
              ) : (!feeds.length ? (
                <div className="hint pane-msg empty-tip">还没有订阅源，在上方粘贴一个 RSS 地址试试</div>
              ) : (
                displayGroups.map((g) => {
                  const isCollapsed = !!(g.name && collapsed.has(g.name));
                  // 「未分组」标题只在确实存在命名分组时才渲染（否则一行标题挺突兀）
                  const showHead = !!g.name || feeds.some((f) => String(f.groupName || '').trim());
                  return (
                    <React.Fragment key={g.name || '__ungrouped'}>
                      {showHead && (
                        <div
                          className={'feed-group-head' + (isCollapsed ? ' collapsed' : '') + headDropCls(g)}
                          data-group={g.name}
                          onClick={(ev) => onHeadClick(ev, g)}
                        >
                          {g.name && renamingGroup === g.name ? (
                    <input
                      ref={groupRenameInputRef}
                      className="feed-group-edit"
                      type="text"
                      maxLength={40}
                      value={renamingGroupDraft}
                      spellCheck={false}
                      autoComplete="off"
                      aria-label="重命名分组"
                      onChange={(ev) => setRenamingGroupDraft(ev.target.value)}
                      onKeyDown={(ev) => {
                        if (ev.key === 'Enter') { ev.preventDefault(); ev.currentTarget.blur(); }
                        else if (ev.key === 'Escape') { ev.preventDefault(); setRenamingGroup(null); }
                      }}
                      onBlur={(ev) => commitGroupRename(g, ev.target.value)}
                      onClick={(ev) => ev.stopPropagation()}
                    />
                  ) : (
                    <>
                      {g.name ? (
                        <span
                          className="drag-handle"
                          title="拖动排序分组"
                          aria-label="拖动排序分组"
                          onPointerDown={(ev) => onGripDown(ev, 'group', { group: g.name })}
                        >
                          {GRIP}
                        </span>
                      ) : null}
                      <svg className="ico feed-group-caret" aria-hidden="true" focusable="false"><use href="#i-chevron-down" /></svg>
                      <span className={'feed-group-name' + (g.name ? '' : ' muted')}>{g.name || '未分组'}</span>
                      <span className="feed-group-n">{g.feeds.length}</span>
                      {g.name ? (
                        <button
                          className="feed-icon-btn feed-group-rename"
                          data-group-rename={g.name}
                          title="重命名分组（组内频道一并改名）"
                          type="button"
                          onClick={(ev) => { ev.stopPropagation(); startGroupRename(g); }}
                        >
                          <Ico name="edit" />
                        </button>
                      ) : null}
                    </>
                  )}
                        </div>
                      )}
                      {(!isCollapsed || fq) && g.feeds.map((f, i) => renderRow(f, i + 1))}
                    </React.Fragment>
                  );
                })
              ))}
            </div>
            {/* 分组名建议列表：给每个频道行里的分组输入框用 */}
            <datalist id="groupList">
              {groupNames.map((g) => <option key={g} value={g} />)}
            </datalist>
          </div>
        </details>

      </div>

      <div className="pane-foot">
        <span className="hint" id="settingsHint">
          {total ? (
            <>
              <strong>{onCount}</strong>{` / ${total} 个频道在定时采集 · `}
              <strong>{cardCount}</strong>{` 个在「卡片」页展示`}
              {groupNames.length ? ` · ${groupNames.length} 个分组` : ''}
            </>
          ) : '添加一个 RSS 地址即可开始'}
        </span>
        <div className="pane-foot-btns">
          <button
            className="btn btn-ghost"
            id="refreshAllFeedsBtn"
            type="button"
            disabled={busy === 'all'}
            onClick={onRefreshAll}
          >
            {busy === 'all' ? '抓取中…' : '刷新全部'}
          </button>
          <button
            className="btn btn-primary"
            id="saveSourceBtn"
            type="button"
            hidden={!admin}
            disabled={busy === 'save'}
            onClick={onSaveCfg}
          >
            {busy === 'save' ? '保存中…' : '保存设置'}
          </button>
        </div>
      </div>
    </div>
  );
}
