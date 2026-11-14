/* 设置弹层「数据源」面板（v2.5.0 起按 A 方案重做：列表 + 详情两层）。
 *
 * 结构约定：
 * - 列表只留紧凑行（头像 + 标题 + 状态，整行命中 ≥64px）；点行打开 DetailSheet
 *   （桌面 = 面板内右侧抽屉，移动 = 贴底弹层），名称 / 地址 / 分组 / 频率 / 序号 /
 *   采集 / 卡片 / 全文 / 立即抓取 / 删除全部收进详情层。
 * - 桌面保留行内「采集 / 卡片」快捷开关（高频动作不必进详情）；移动端收进详情层。
 * - 命名分组默认收起，展开态按账号持久化：桥 setLayout('srcGroupsOpen', …)；
 *   搜索时强制展开命中分组；批量模式下全部展开便于勾选。
 * - 行级修改即改即生效，toast 带「撤销」（6 秒）；删除可撤销（重建订阅，
 *   条目需重抓，已读 / 收藏状态会丢失——确认框里明说）。
 * - 批量模式：多选后在页脚统一 开/关采集、开/关卡片、移组、删除，均可撤销。
 *
 * 沿用旧实现的机制：
 * - 频道数据以 core.state 为单一数据源：组件每次渲染实时读 core.state
 *   （feedList / feedMeta / groupOrder 均原地修改、实时引用），原地改动后 bump tick
 *   触发重绘；服务端往返（增 / 删 / 改）统一走桥 loadFeeds() 刷新共享 state 再 bump。
 * - 采集参数（管理员专属）：进入面板拉 /api/config 回填；cfgLoaded 复刻旧 srcFormReady
 *   语义——没加载完禁止保存，避免把兜底值当成用户设置存下去。
 * - 可折叠分组（details.sec）的开合按账号持久化：挂载后经桥 bindSections(容器)。
 * - 拖拽排序：Pointer 事件（桌面 + 触屏通用）；频道重排 / 跨组落库
 *   /api/feeds/reorder，分组重排落库 /api/prefs（groupOrder）。拖拽结束 250ms 内
 *   抑制行点击，避免松手误开详情层。
 */

import { core } from '@core';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { EditSection, PaneFoot, Result, Section, useFormLoadGuard } from './primitives.jsx';
import { DetailSheet } from './DetailSheet.jsx';
import { NO_AUTOFILL_PROPS } from '../ui/noAutofill.js';
import { isImgFailed, markImgFailed } from '../imgFail.js';

const S = () => core;   // 核心逻辑单例（@core，v2.0.0 起改为模块引用）

/** 频道头像：图标加载失败（拉取 404 / 防盗链）时回退到首字母，避免破图标 */
function FeedAvatar({ icon, name }) {
  const [failed, setFailed] = useState(false);
  if (!icon || failed || isImgFailed(icon)) {
    return <span className="feed-avatar feed-avatar-txt">{(name || '?').slice(0, 1)}</span>;
  }
  return (
    <img className="feed-avatar" src={icon} alt="" loading="lazy"
      onError={() => { markImgFailed(icon); setFailed(true); }} />
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
// 注意合并顺序：jsonPost 自带 method:'POST'，必须后覆盖回 PATCH
const patchInit = (body) => Object.assign(jsonPost(body), { method: 'PATCH' });

/** 删除撤销用的快照：重建订阅需要 url + 开关 + 分组，其余字段走 PATCH 补 */
const snapshotFeed = (f) => ({
  url: f.url, enabled: f.enabled, cardEnabled: f.cardEnabled,
  groupName: f.groupName || '', fullText: f.fullText,
  refreshMinutes: f.refreshMinutes, customTitle: f.customTitle,
});

/* ---------- 频道详情层（A 方案第二层） ----------
 * 输入框用 defaultValue + key 绑服务端值：提交 / 撤销后服务端值变了，
 * key 跟着变 → 自动重挂载回显新值，不需要手动同步草稿。 */
function FeedSheet({ feed, order, globalMins, busyFeed, pending, onClose, onToggle, onFreq, onOrder, onName, onUrl, onGroup, onRefresh, onDelete }) {
  const s = S();
  const nameRef = useRef(null);
  const urlRef = useRef(null);
  const groupRef = useRef(null);
  const name = s.shortFeedName(s.feedTitle(feed));

  const editKeys = (resetVal) => (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); ev.currentTarget.blur(); }
    else if (ev.key === 'Escape') { ev.preventDefault(); ev.currentTarget.value = resetVal; ev.currentTarget.blur(); }
  };

  const commitOrder = (ev) => {
    const pos = parseInt(ev.target.value, 10);
    if (!Number.isFinite(pos) || pos < 1) { ev.target.value = String(order); return; }
    if (pos !== order) onOrder(feed.id, pos);
  };

  const swRow = (key, label, desc, checked, okOn, okOff, dataAttr) => (
    <label className="ds-sw-row">
      <span className="ds-sw-txt">
        <span className="ds-sw-name">{label}</span>
        <span className="ds-sw-desc">{desc}</span>
      </span>
      <span className="switch">
        <input type="checkbox" {...{ [dataAttr]: feed.id }} aria-label={label}
          checked={checked} disabled={pending}
          onChange={(ev) => onToggle(feed, key, ev.target.checked, ev.target.checked ? okOn : okOff)} />
        <span className="switch-slider" />
      </span>
    </label>
  );

  return (
    <DetailSheet title={name} subtitle={prettyUrl(feed.url)} onClose={onClose}
      foot={
        <>
          <button className="btn" type="button" disabled={busyFeed === feed.id} onClick={() => onRefresh(feed.id)}>
            {busyFeed === feed.id ? '抓取中…' : '立即抓取'}
          </button>
          <button className="btn btn-danger" type="button" disabled={pending} onClick={() => onDelete(feed)}>
            删除订阅
          </button>
        </>
      }>
      <div className="ds-stat">
        <div className="ds-stat-line">{feedStatusText(feed)}</div>
        {feed.status === 'error' ? (
          <div className="ds-stat-line err"><Ico name="alert" /> {s.errText(feed.error)}</div>
        ) : null}
      </div>

      <div className="form-row">
        <label htmlFor="dsName">名称</label>
        <input id="dsName" key={'n-' + (feed.customTitle || '')} ref={nameRef}
          type="text" maxLength={200} spellCheck={false} autoComplete="off"
          data-sheet-title={feed.id} defaultValue={s.feedTitle(feed)}
          onBlur={() => onName(feed, nameRef.current ? nameRef.current.value : '')}
          onKeyDown={editKeys(s.feedTitle(feed))} />
        <small className="form-tip">改完即保存；清空可恢复订阅源原标题</small>
      </div>

      <div className="form-row">
        <label htmlFor="dsUrl">订阅地址</label>
        <input id="dsUrl" key={'u-' + feed.url} ref={urlRef}
          type="text" inputMode="url" maxLength={600} spellCheck={false} autoComplete="off"
          data-sheet-url={feed.id} defaultValue={feed.url}
          onBlur={() => onUrl(feed, urlRef.current ? urlRef.current.value : '')}
          onKeyDown={editKeys(feed.url)} />
        <small className="form-tip">需以 http:// 或 https:// 开头，改完会立即按新地址试抓一次</small>
      </div>

      <div className="form-row">
        <label htmlFor="dsGroup">分组</label>
        <input id="dsGroup" key={'g-' + (feed.groupName || '')} ref={groupRef}
          type="text" list="groupList" maxLength={40} spellCheck={false} autoComplete="off"
          placeholder="未分组" data-sheet-group={feed.id} defaultValue={feed.groupName || ''}
          onBlur={() => onGroup(feed, groupRef.current ? groupRef.current.value : '')}
          onKeyDown={editKeys(feed.groupName || '')} />
        <small className="form-tip">留空移出分组；输入新名即建组</small>
      </div>

      <div className="form-row">
        <label htmlFor="dsFreq">抓取频率</label>
        <select id="dsFreq" className={'select feed-freq' + (feed.refreshMinutes == null ? '' : ' own')}
          data-sheet-freq={feed.id}
          value={feed.refreshMinutes == null ? '' : String(feed.refreshMinutes)}
          disabled={pending}
          onChange={(ev) => onFreq(feed, ev.target.value === '' ? null : Number(ev.target.value))}>
          <option value="">{`跟随全局（${fmtMinutes(globalMins)}）`}</option>
          {FREQ_OPTIONS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
        </select>
        <small className="form-tip">未设置则跟随全局自动抓取间隔</small>
      </div>

      <div className="form-row">
        <label htmlFor="dsOrder">组内序号</label>
        <input id="dsOrder" className="feed-order" key={'o-' + order}
          type="number" min="1" data-sheet-order={feed.id} defaultValue={order}
          onBlur={commitOrder}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter') { ev.preventDefault(); ev.currentTarget.blur(); }
            else if (ev.key === 'Escape') { ev.preventDefault(); ev.currentTarget.value = String(order); ev.currentTarget.blur(); }
          }} />
        <small className="form-tip">填数字调整在本组内的顺序（与拖拽并存）</small>
      </div>

      {swRow('enabled', '采集', '开启后定时抓取这个频道的新条目', feed.enabled, '已开启采集', '已停止采集', 'data-sheet-toggle')}
      {swRow('cardEnabled', '卡片', '开启后在「卡片」页展示这个频道的条目', feed.cardEnabled, '已在卡片页展示', '已从卡片页隐藏', 'data-sheet-card')}
      {swRow('fullText', '全文', '订阅只给摘要时，抓取原文页面并提取完整正文（会增加抓取耗时）', feed.fullText, '已开启全文抓取（下轮抓取生效）', '已关闭全文抓取', 'data-sheet-fulltext')}
    </DetailSheet>
  );
}

export function SourcePane({ admin, onDirtyChange }) {
  /* ---- 状态 ---- */
  const [tick, setTick] = useState(0);                 // 原地改动后强制重绘（共享 state 是实时引用）
  const bump = useCallback(() => setTick((t) => t + 1), []);

  const [cfg, setCfg] = useState(CFG_DEFAULTS);        // 采集参数表单（字符串，与旧 DOM .value 一致）
  const [savedCfg, setSavedCfg] = useState('');        // 上次落库的指纹，用来算「改过没」
  const [cfgLoaded, setCfgLoaded] = useState(false);   // 复刻旧 srcFormReady
  const [loadError, setLoadError] = useState('');      // /api/feeds 拉取失败（列表区兜底）
  const [feedsLoading, setFeedsLoading] = useState(true); // 首屏列表未到，不该显示「还没有订阅源」
  const cfgGuard = useFormLoadGuard();                 // 采集参数：异步回填不许盖掉用户已改的字段
  const [imgStats, setImgStats] = useState({ count: 0, bytes: 0 });   // 图片缓存统计（v2.4.0）

  const [url, setUrl] = useState('');
  const [result, setResult] = useState(null);          // { ok, msg } | null —— #feedResult
  // A 方案：命名分组默认收起，这里记「显式展开」的组名（按账号持久化 srcGroupsOpen）
  const [openGroups, setOpenGroups] = useState(() => new Set((S() && S().state && S().state.srcGroupsOpen) || []));
  const [renamingGroup, setRenamingGroup] = useState(null); // 正在重命名的分组名
  const [renamingGroupDraft, setRenamingGroupDraft] = useState(''); // 组重命名草稿（提交式）
  const [busyFeed, setBusyFeed] = useState('');        // 单频道「立即抓取」中的 id
  const [busy, setBusy] = useState('');                // '' | 'add' | 'import' | 'all' | 'save' | 'imgclear' | 'bulk'
  // 某个频道有保存中的请求时禁用该行控件（防重复提交）
  const [pendingIds, setPendingIds] = useState(() => new Set());
  const [drop, setDrop] = useState(null);              // 拖拽落点指示 { type, id, group, before }
  const [dragging, setDragging] = useState(false);
  const [feedQuery, setFeedQuery] = useState('');      // 频道搜索（本地过滤，应对大量频道）
  const [bulk, setBulk] = useState(false);             // 批量模式
  const [selected, setSelected] = useState(() => new Set()); // 批量选中的频道 id（字符串）
  const [sheetId, setSheetId] = useState(null);        // 打开详情层的频道 id

  const paneRef = useRef(null);
  const urlRef = useRef(null);
  const groupRenameInputRef = useRef(null);
  const dragRef = useRef(null);
  const moveRef = useRef(null);
  const endRef = useRef(null);
  const lastDragEnd = useRef(0);                       // 拖拽松手时间戳：250ms 内抑制行点击

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

  const selectedFeeds = feeds.filter((f) => selected.has(String(f.id)));
  // 批量「全选」只作用在当前筛选可见的频道：搜出 2 个却选中全部 50 个，
  // 紧接着「删除 / 关采集」会误伤看不见的频道。
  const visibleIds = displayGroups.reduce(
    (acc, g) => acc.concat((g.feeds || []).map((f) => String(f.id))), []);
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const hiddenSelected = fq
    ? selectedFeeds.filter((f) => visibleIds.indexOf(String(f.id)) < 0).length : 0;
  const sheetFeed = sheetId == null ? null : feeds.find((f) => String(f.id) === String(sheetId));
  let sheetOrder = 1;
  if (sheetFeed) {
    const g = groups.find((x) => x.feeds.some((f) => String(f.id) === String(sheetId)));
    if (g) sheetOrder = g.feeds.findIndex((f) => String(f.id) === String(sheetId)) + 1;
  }

  /* ---- 未保存改动：采集参数 + 新增地址草稿 + 组重命名编辑态 ----
   * 详情层里的输入都是失焦即提交，没有跨开关的草稿，不计入 dirty。 */
  const cfgDirty = cfgLoaded && !!savedCfg && JSON.stringify(cfg) !== savedCfg;
  const sourceDirty = cfgDirty || url.trim() !== '' || renamingGroup != null;
  useEffect(() => {
    if (onDirtyChange) onDirtyChange(sourceDirty);
  }, [sourceDirty, onDirtyChange]);

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
      const next = {
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
      };
      const applied = cfgGuard.apply(() => {
        setCfg(next);
        setSavedCfg(JSON.stringify(next));
      });
      // 用户已在回填前改过字段：保留输入，脏态基线按默认指纹算（与 ModelPane 同口径），
      // 这样改动不会被静默吃掉，「有未保存的更改」也会立刻出现。
      if (!applied) setSavedCfg((v) => v || JSON.stringify(CFG_DEFAULTS));
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

  /** 频道 PATCH 统一走这里。返回响应 JSON（改地址要用它带回的 probe 判断新地址能不能抓到）。 */
  const patchFeed = useCallback(async (id, patch, okMsg) => {
    const s = S();
    const key = String(id);
    setPendingIds((p) => { const n = new Set(p); n.add(key); return n; });
    try {
      const res = await s.apiFetch('/api/feeds/' + id, patchInit(patch));
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(s.errText(data, 'HTTP ' + res.status));
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

  /** 即改即生效 + 撤销：先按新值落库，toast 挂 6 秒撤销（按旧值再落一次）。
   *  失败时 bump 让受控控件回滚到服务端值。 */
  const patchWithUndo = useCallback(async (f, patch, prevPatch, okMsg) => {
    const s = S();
    try {
      await patchFeed(f.id, patch, null);
      s.toast(okMsg, true, {
        actionText: '撤销', ms: 6000,
        action: async () => {
          try { await patchFeed(f.id, prevPatch, '已撤销'); }
          catch (e) { s.toast('撤销失败：' + (e.message || e), false); }
        },
      });
    } catch (err) {
      bump();
      s.toast('保存失败：' + (err.message || err), false);
    }
  }, [patchFeed, bump]);

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
    if (!ctx || !ctx.moved) return;
    lastDragEnd.current = Date.now();   // 松手后短暂抑制行点击，避免误开详情层
    if (!ctx.target) return;
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
      setFeedsLoading(true);
      try {
        await S().loadFeeds();
        if (cancelled) return;
        setLoadError('');
      } catch (err) {
        if (!cancelled) {
          setLoadError(String((err && err.message) || err));
          setFeedsLoading(false);
        }
        return;
      }
      setFeedsLoading(false);
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

  // 分组重命名输入框：挂上即聚焦并全选
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
      // 30 秒兜底：添加订阅要等服务端去抓一次，遇到慢站或死站会一直挂着，
      // 按钮永远停在「添加中…」，用户既不知道还要等多久也不知道是不是卡了。
      const res = await s.apiFetch('/api/feeds', Object.assign(jsonPost({ url: u }), { signal: AbortSignal.timeout(30000) }));
      const data = await res.json();
      if (!res.ok) { setResult({ ok: false, msg: s.errText(data, '添加失败') }); return; }
      setUrl('');
      setResult({ ok: true, msg: `已添加「${s.shortFeedName(s.feedTitle(data.feed))}」，新增 ${data.added} 条` });
      s.toast('订阅已添加');
      await reloadFeeds();
      s.state.tag = null;
      if (s.loadPage) await s.loadPage(true);
    } catch (err) {
      const timedOut = !!(err && (err.name === 'TimeoutError' || err.name === 'AbortError'));
      setResult({ ok: false, msg: timedOut ? '抓取超时（30 秒）：这个地址可能太慢或没有响应' : '添加失败：' + (err.message || err) });
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
      if (!res.ok) throw new Error(s.errText(data, '导入失败'));
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
      if (!res.ok || !data.ok) throw new Error(s.errText((data.result && data.result.error) || data.error, '抓取失败'));
      s.toast(data.result.added ? `新增 ${data.result.added} 条` : '没有新内容');
      await reloadFeeds();
      if (s.loadPage) await s.loadPage(true);
    } catch (err) {
      s.toast('抓取失败：' + (err.message || err), false);
    } finally {
      setBusyFeed('');
    }
  };

  /** 删除撤销：按快照重建订阅（POST 会立即抓一次），再补回个性化字段。
   *  条目是重新抓的，已读 / 收藏状态回不来——确认框文案里已明说。 */
  const restoreFeed = useCallback(async (snap) => {
    const s = S();
    const res = await s.apiFetch('/api/feeds', jsonPost({
      url: snap.url, enabled: snap.enabled, cardEnabled: snap.cardEnabled, groupName: snap.groupName,
    }));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(s.errText(data, '恢复失败'));
    if (!data.existed && data.feed) {
      const extra = {};
      if (snap.fullText) extra.fullText = true;
      if (snap.refreshMinutes != null) extra.refreshMinutes = snap.refreshMinutes;
      if (snap.customTitle) extra.title = snap.customTitle;
      if (Object.keys(extra).length) await s.apiFetch('/api/feeds/' + data.feed.id, patchInit(extra));
    }
  }, []);

  const onDelete = async (f) => {
    const s = S();
    const name = s.shortFeedName(s.feedTitle(f));
    const ok = await s.confirm({
      title: `删除订阅「${name}」？`,
      desc: '该频道已抓取的条目会一并删除。撤销可恢复订阅，但条目需重新抓取，已读 / 收藏状态会丢失。',
      confirmText: '删除订阅',
      danger: true,
    });
    if (!ok) return;
    const snap = snapshotFeed(f);
    try {
      const res = await s.apiFetch('/api/feeds/' + f.id, { method: 'DELETE' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      if (sheetId != null && String(sheetId) === String(f.id)) setSheetId(null);
      await reloadFeeds();
      s.state.tag = null;
      if (s.loadPage) await s.loadPage(true);
      s.toast('订阅已删除', true, {
        actionText: '撤销', ms: 6000,
        action: async () => {
          try {
            await restoreFeed(snap);
            await reloadFeeds();
            if (s.loadPage) await s.loadPage(true);
            s.toast('已恢复订阅');
          } catch (e) { s.toast('撤销失败：' + (e.message || e), false); }
        },
      });
    } catch (err) {
      s.toast('删除失败：' + (err.message || err), false);
    }
  };

  const onSaveCfg = async () => {
    if (!cfgLoaded) { setResult({ ok: false, msg: '设置尚未加载完成，请稍后再试' }); return; }
    const s = S();
    setBusy('save');
    try {
      // v2 契约全是整数：输入框存的是字符串，提交前统一转数字（空串按 0，由服务端夹取）
      const num = (v) => Number(v) || 0;
      const res = await s.apiFetch('/api/config', jsonPost({
        source: {
          refreshMinutes: num(cfg.refreshMinutes),
          keepPerFeed: num(cfg.keepPerFeed),
          keepDays: num(cfg.keepDays),
          timeoutSeconds: num(cfg.timeoutSeconds),
          concurrency: num(cfg.concurrency),
          autoRefreshMinutes: num(cfg.autoRefreshMinutes),
          proxyUrl: cfg.proxyUrl,
          imgTtlDays: num(cfg.imgTtlDays),
          imgKeepDays: num(cfg.imgKeepDays),
          imgMaxDim: num(cfg.imgMaxDim),
          imgQuality: num(cfg.imgQuality),
          feedFailLimit: num(cfg.feedFailLimit),
        },
      }));
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setResult({ ok: false, msg: s.errText(data, '保存失败') }); return; }
      // 表单保存只用内联结果，不再叠一层 toast（列表级动作才用 toast）
      setResult({ ok: true, msg: '抓取设置已保存' });
      setSavedCfg(JSON.stringify(cfg));
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
      if (!res.ok) throw new Error(s.errText(data, 'HTTP ' + res.status));
      setImgStats({ count: 0, bytes: 0 });
      s.toast(`已清空 ${data.removed} 张缓存图片`);
    } catch (err) {
      s.toast('清空失败：' + (err.message || err), false);
    } finally {
      setBusy('');
    }
  };

  /* ---- 行级 / 详情层动作：即改即生效 + 撤销 ---- */
  const onToggle = async (f, key, next, okMsg) => {
    await patchWithUndo(f, { [key]: next }, { [key]: f[key] }, okMsg);
  };

  const onCommitName = useCallback(async (f, raw) => {
    const s = S();
    const val = String(raw == null ? '' : raw).trim().slice(0, 200);
    if (val === s.feedTitle(f)) return;          // 没变
    if (!val && !f.customTitle) return;          // 本来就是原标题，无需清空
    await patchWithUndo(f, { title: val }, { title: f.customTitle || '' },
      val ? '名称已更新' : '已恢复原标题');
  }, [patchWithUndo]);

  /* 改订阅地址：校验与「同用户 URL 唯一」判重都在后端（与新增共用 rss.assertFeedUrl）。
   * 服务端改完会按新地址当场试抓一次，结果走 probe 反馈；地址变更不做撤销（试抓有副作用）。 */
  const onCommitUrl = useCallback(async (f, raw) => {
    const s = S();
    const val = String(raw == null ? '' : raw).trim();
    if (!val || val === f.url) return;
    try {
      const data = await patchFeed(f.id, { url: val }, '订阅地址已更新');
      const probe = data && data.probe;
      if (!probe) return;
      if (!probe.ok) s.toast('新地址抓取失败：' + s.errText(probe, '未知错误') + '（地址已保存，下个周期自动重试）', false);
      else if (probe.added) s.toast('新地址可用：本次新增 ' + probe.added + ' 条');
    } catch (err) {
      bump();
      s.toast('地址未更新：' + (err.message || err), false);
    }
  }, [patchFeed, bump]);

  const onCommitGroup = useCallback(async (f, raw) => {
    const val = String(raw == null ? '' : raw).trim().slice(0, 40);
    if (val === (f.groupName || '')) return;
    await patchWithUndo(f, { groupName: val }, { groupName: f.groupName || '' },
      val ? `已归入「${val}」` : '已移出分组');
  }, [patchWithUndo]);

  /* ---- 分组重命名：一次改组 + 同步分组顺序 ----
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
        await s.apiFetch('/api/feeds/' + f.id, patchInit({ groupName: val }));
      }
      // 分组顺序里的旧名换新名（旧名不在顺序里就把新名追加到末尾）
      const order = (s.state.groupOrder || []).slice();
      const i = order.indexOf(oldName);
      if (i >= 0) order.splice(i, 1, val);
      else if (order.indexOf(val) < 0) order.push(val);
      s.state.groupOrder = order;
      await s.apiFetch('/api/prefs', jsonPost({ groupOrder: order }));
      // 展开态跟着旧名迁到新名：不然改完名分组会突然收起来
      if (openGroups.has(oldName)) {
        const nextOpen = new Set(openGroups);
        nextOpen.delete(oldName);
        nextOpen.add(val);
        setOpenGroups(nextOpen);
        if (s.setLayout) s.setLayout('srcGroupsOpen', [...nextOpen]);
      }
      s.toast(`分组已改名「${val}」${members.length ? `（${members.length} 个频道）` : ''}`);
      await reloadFeeds();
      if (s.renderReaderChannels) s.renderReaderChannels();
      if (s.renderFeedSelect) s.renderFeedSelect();
    } catch (err) {
      if (s && s.toast) s.toast('分组改名失败：' + String((err && err.message) || err), false);
      await reloadFeeds().catch(() => {});
    }
  }, [reloadFeeds, openGroups]);

  const onFreqChange = useCallback(async (f, next) => {
    const cur = f.refreshMinutes == null ? null : Number(f.refreshMinutes);
    if (cur === next) return;
    await patchWithUndo(f, { refreshMinutes: next }, { refreshMinutes: cur },
      next == null ? '已改为跟随全局频率' : `该频道已设为每 ${fmtMinutes(next)}抓取`);
  }, [patchWithUndo]);

  const onHeadClick = (ev, g) => {
    if (ev.target.closest('.drag-handle')) return;   // 手柄区域是拖拽，不触发折叠
    if (ev.target.closest('.feed-group-rename') || ev.target.closest('.feed-group-edit')) return;
    if (!g.name || bulk) return;                     // 未分组常开；批量模式下全部展开
    const next = new Set(openGroups);
    if (next.has(g.name)) next.delete(g.name); else next.add(g.name);
    setOpenGroups(next);
    const s = S();
    if (s.setLayout) s.setLayout('srcGroupsOpen', [...next]);
  };

  /* ---- 批量模式 ---- */
  const toggleSelect = (id) => setSelected((p) => {
    const n = new Set(p); const k = String(id);
    if (n.has(k)) n.delete(k); else n.add(k);
    return n;
  });
  const toggleSelectAll = () => setSelected((p) => {
    const n = new Set(p);
    for (const id of visibleIds) { if (allSelected) n.delete(id); else n.add(id); }
    return n;
  });
  const enterBulk = () => { setSheetId(null); setBulk(true); };
  const exitBulk = () => { setBulk(false); setSelected(new Set()); };

  /** 批量开关：只改与目标值不同的频道；撤销按原值（布尔取反）逐个还原 */
  const bulkPatch = async (key, next, label) => {
    const s = S();
    const targets = selectedFeeds.filter((f) => !!f[key] !== next);
    if (!targets.length) return;
    setBusy('bulk');
    try {
      for (const f of targets) await s.apiFetch('/api/feeds/' + f.id, patchInit({ [key]: next }));
      await reloadFeeds();
      s.state.tag = null;
      if (s.loadPage) await s.loadPage(true);
      s.toast(`已${label} ${targets.length} 个频道`, true, {
        actionText: '撤销', ms: 6000,
        action: async () => {
          try {
            for (const f of targets) await s.apiFetch('/api/feeds/' + f.id, patchInit({ [key]: !next }));
            await reloadFeeds();
            if (s.loadPage) await s.loadPage(true);
            s.toast('已撤销');
          } catch (e) { s.toast('撤销失败：' + (e.message || e), false); }
        },
      });
    } catch (err) {
      s.toast('批量保存失败：' + (err.message || err), false);
      await reloadFeeds().catch(() => {});
    } finally {
      setBusy('');
    }
  };

  const bulkMove = async () => {
    const s = S();
    if (!selectedFeeds.length) return;
    const val = await s.confirm({
      title: `移动 ${selectedFeeds.length} 个频道到分组`,
      desc: '输入分组名（不存在会自动创建），留空则移出分组。',
      input: { label: '分组名（留空移出分组）', placeholder: '未分组', required: false },
      confirmText: '移动',
    });
    if (val == null) return;
    const group = String(val).trim().slice(0, 40);
    const targets = selectedFeeds.filter((f) => (f.groupName || '') !== group);
    if (!targets.length) return;
    setBusy('bulk');
    try {
      for (const f of targets) await s.apiFetch('/api/feeds/' + f.id, patchInit({ groupName: group }));
      await reloadFeeds();
      s.toast(group ? `已移入「${group}」（${targets.length} 个频道）` : `已移出分组（${targets.length} 个频道）`, true, {
        actionText: '撤销', ms: 6000,
        action: async () => {
          try {
            for (const f of targets) await s.apiFetch('/api/feeds/' + f.id, patchInit({ groupName: f.groupName || '' }));
            await reloadFeeds();
            s.toast('已撤销');
          } catch (e) { s.toast('撤销失败：' + (e.message || e), false); }
        },
      });
    } catch (err) {
      s.toast('移动失败：' + (err.message || err), false);
      await reloadFeeds().catch(() => {});
    } finally {
      setBusy('');
    }
  };

  const bulkDelete = async () => {
    const s = S();
    if (!selectedFeeds.length) return;
    const ok = await s.confirm({
      title: `删除选中的 ${selectedFeeds.length} 个订阅？`,
      desc: '这些频道已抓取的条目会一并删除。撤销可恢复订阅，但条目需重新抓取，已读 / 收藏状态会丢失。',
      confirmText: '删除订阅',
      danger: true,
    });
    if (!ok) return;
    const snaps = selectedFeeds.map(snapshotFeed);
    const ids = selectedFeeds.map((f) => f.id);
    setBusy('bulk');
    try {
      for (const id of ids) {
        const res = await s.apiFetch('/api/feeds/' + id, { method: 'DELETE' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
      }
      exitBulk();
      await reloadFeeds();
      s.state.tag = null;
      if (s.loadPage) await s.loadPage(true);
      s.toast(`已删除 ${ids.length} 个订阅`, true, {
        actionText: '撤销', ms: 6000,
        action: async () => {
          try {
            for (const snap of snaps) await restoreFeed(snap);
            await reloadFeeds();
            if (s.loadPage) await s.loadPage(true);
            s.toast('已恢复订阅');
          } catch (e) { s.toast('撤销失败：' + (e.message || e), false); }
        },
      });
    } catch (err) {
      s.toast('批量删除失败：' + (err.message || err), false);
      await reloadFeeds().catch(() => {});
    } finally {
      setBusy('');
    }
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

  /* 紧凑行：整行命中开详情（批量模式下改为勾选）。
   * 桌面保留「采集 / 卡片」快捷开关；拖拽手柄 hover 显现。 */
  const renderRow = (f) => {
    const s = S();
    const pend = pendingIds.has(String(f.id));
    const name = s.shortFeedName(s.feedTitle(f));
    const sel = selected.has(String(f.id));
    const activate = () => {
      if (Date.now() - lastDragEnd.current < 250) return;   // 拖拽松手抑制
      if (bulk) toggleSelect(f.id);
      else setSheetId(f.id);
    };
    return (
      <div
        key={f.id}
        className={'feed-row' + (f.enabled ? '' : ' off') + (f.cardEnabled ? '' : ' no-card') + (sel ? ' selected' : '') + rowDropCls(f)}
        data-id={f.id}
        {...(bulk ? {} : { role: 'button', tabIndex: 0, 'aria-label': `查看「${name}」详情` })}
        onClick={activate}
        onKeyDown={(ev) => {
          if (ev.target !== ev.currentTarget) return;
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); activate(); }
        }}
      >
        {bulk ? (
          <input className="feed-check" type="checkbox" checked={sel}
            aria-label={`选择「${name}」`}
            onClick={(ev) => ev.stopPropagation()}
            onChange={() => toggleSelect(f.id)} />
        ) : (
          <span
            className="drag-handle"
            title="拖动排序：组内重排，或拖到其它分组"
            aria-label="拖动排序"
            onPointerDown={(ev) => onGripDown(ev, 'feed', { id: f.id })}
            onClick={(ev) => ev.stopPropagation()}
          >
            {GRIP}
          </span>
        )}
        <FeedAvatar icon={f.icon} name={name} />
        <div className="feed-info">
          <div className="feed-title" title={s.feedTitle(f)}>{name}</div>
          <div className="feed-stat">
            {feedStatusText(f)}{' '}
            {f.status === 'error' ? (
              <span className="err" title={s.errText(f.error)}><Ico name="alert" /> 抓取失败</span>
            ) : null}
          </div>
        </div>
        {!bulk && (
          <div className="feed-quick" onClick={(ev) => ev.stopPropagation()}>
            <label className="feed-sw" title="采集：开启后定时抓取这个频道的新条目">
              <span className="feed-sw-label">采集</span>
              <span className="switch">
                <input
                  type="checkbox"
                  data-toggle={f.id}
                  aria-label="采集"
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
                  aria-label="卡片"
                  checked={f.cardEnabled}
                  disabled={pend}
                  onChange={(ev) => onToggle(f, 'cardEnabled', ev.target.checked, ev.target.checked ? '已在卡片页展示' : '已从卡片页隐藏')}
                />
                <span className="switch-slider"></span>
              </span>
            </label>
          </div>
        )}
        {!bulk && <svg className="ico feed-caret" aria-hidden="true" focusable="false"><use href="#i-chevron-right" /></svg>}
      </div>
    );
  };

  const setCfgField = (k) => (ev) => { cfgGuard.mark(); setCfg((c) => Object.assign({}, c, { [k]: ev.target.value })); };

  const bulkDisabled = !selectedFeeds.length || busy === 'bulk';

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
              {busy === 'add' ? '添加中…' : '添加'}
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
          <Result id="feedResult" result={result} />
        </div>

        {/* 采集参数：设置一次就不常动，默认收起；收起时标题右侧直接显示当前值（仅管理员） */}
        {admin && (
          <EditSection secKey="src-params" title="采集参数" sub={paramsSub} subId="srcParamsSub"
            editText="修改采集参数">
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
                <b>保留规则</b>
                <br />条目受两个上限约束：每个频道最多保留「每频道保留」条，早于「最长保留」的一律清理。
                <br />「每频道保留」填 0 = 不限条数，只按时长清理；「最长保留」选「不限时长」= 只按条数清理。两项都设上限才会同时生效。
                <br />收藏的条目不受这两条限制，不会被清理。
                <br /><b>抓取与刷新</b>
                <br />「自动抓取」由服务端去源站取新内容；「页面自动刷新」只让打开的页面重读列表，不触发抓取。
                <br />每个频道可在详情层单独指定抓取频率，未设置的跟随全局。
                <br />「连续失败自动停用」：频道连续失败达到此次数就停止采集，不再每轮打扰源站。到「状态 → 异常频道」重试成功会自动恢复，手动重开采集开关也会清零计数。
                <br /><b>出网代理</b>
                <br />抓 RSS 与代理图片都走这里，支持 <code>http://</code>、<code>https://</code>、<code>socks5://</code>（含账号可写 <code>http://user:pass@host:port</code>）；留空走默认出网，保存后下次抓取生效。
                <br /><b>图片缓存</b>
                <br />全站图片（卡片图 / 阅读大图 / 频道头像 / 灯箱）统一代理、永久缓存在数据库。
                <br />「图片最长边」「图片质量」控制 WebP 压缩强度：越小越省空间，也越模糊。
                <br />「图片回源窗口」内的重复访问不再请求上游；超过窗口仍先返回旧图，后台静默刷新。
                <br />「图片保留」到期后由每日清理删除。
                <br />改动保存后对之后新缓存的图片生效；点「清空图片缓存」可按新参数立即重缓全部图片。
              </small>
          </EditSection>
        )}

        {/* 列表工具条：搜索 + 批量入口，吸顶 */}
        <div className="src-toolbar">
          <div className="feed-filter">
            <svg className="feed-filter-ico" aria-hidden="true" focusable="false"><use href="#i-search" /></svg>
            <input className="feed-filter-input" type="search" value={feedQuery}
              placeholder="搜索频道（名称 / 地址 / 分组）" aria-label="搜索频道"
              onChange={(ev) => setFeedQuery(ev.target.value)} {...NO_AUTOFILL_PROPS} />
          </div>
          <button className={'btn' + (bulk ? ' active' : '')} id="bulkToggleBtn" type="button"
            aria-pressed={bulk} onClick={bulk ? exitBulk : enterBulk}>
            {bulk ? '完成' : '批量'}
          </button>
        </div>
        <div className="src-list-hint hint" id="feedToolbarHint">
          {total
            ? `${total} 个频道${groupNames.length ? ` · ${groupNames.length} 个分组` : ''}`
              + `${ownFreqCount ? ` · ${ownFreqCount} 个单独设了频率` : ''}`
              + (bulk ? ' · 勾选后在底部统一操作' : ' · 点行编辑')
            : ''}
        </div>

        {/* 频道列表：紧凑行，点行开详情层 */}
        <div className="feed-list" id="feedList">
          {fq && !displayGroups.length ? <div className="hint pane-msg">没有匹配的频道</div> : null}
          {loadError ? (
            <div className="hint pane-msg lg">{`读取失败：${loadError}`}</div>
          ) : (feedsLoading && !feeds.length ? (
            <div className="hint pane-msg empty-tip">正在读取频道…</div>
          ) : (!feeds.length ? (
            <div className="hint pane-msg empty-tip">还没有订阅源，在上方粘贴一个 RSS 地址试试</div>
          ) : (
            displayGroups.map((g) => {
              // 命名分组默认收起；搜索命中 / 批量模式强制展开；未分组常开
              const isOpen = bulk || !g.name || openGroups.has(g.name) || !!fq;
              const isCollapsed = !isOpen;
              // 「未分组」标题只在确实存在命名分组时才渲染（否则一行标题挺突兀）
              const showHead = !!g.name || feeds.some((f) => String(f.groupName || '').trim());
              return (
                <React.Fragment key={g.name || '__ungrouped'}>
                  {showHead && (
                    <div
                      className={'feed-group-head' + (isCollapsed ? ' collapsed' : '') + headDropCls(g)}
                      data-group={g.name}
                      /* 分组头是可点开关，得让键盘和读屏也能用：补按钮语义与展开态。
                         重命名态下有 <input>，此时不能挂 role=button（button 套 input
                         语义不合法），退化成普通容器，输入框自己处理按键。 */
                      {...(renamingGroup === g.name ? {} : {
                        role: 'button',
                        tabIndex: 0,
                        'aria-expanded': isCollapsed ? 'false' : 'true',
                        'aria-label': (g.name || '未分组') + '，' + g.feeds.length + ' 个频道，' + (isCollapsed ? '已收起' : '已展开'),
                      })}
                      onClick={(ev) => onHeadClick(ev, g)}
                      onKeyDown={(ev) => {
                        if (ev.target !== ev.currentTarget) return;   // 手柄 / 重命名按钮 / 输入框各自处理
                        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onHeadClick(ev, g); }
                      }}
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
                  {isOpen && g.feeds.map((f) => renderRow(f))}
                </React.Fragment>
              );
            })
          )))}
        </div>
        {/* 分组名建议列表：给详情层里的分组输入框用 */}
        <datalist id="groupList">
          {groupNames.map((g) => <option key={g} value={g} />)}
        </datalist>

      </div>

      <PaneFoot dirty={sourceDirty} lead={bulk ? (
        <span className="hint bulk-lead">
          已选 <strong>{selectedFeeds.length}</strong>{` / ${total}`}
          {fq ? ` · 当前筛选 ${visibleIds.length} 个` : ''}
          {hiddenSelected ? ` · 其中 ${hiddenSelected} 个不在筛选结果内` : ''}
        </span>
      ) : (
        <span className="hint" id="settingsHint">
          {total ? (
            <>
              <strong>{onCount}</strong>{` / ${total} 个频道在定时采集 · `}
              <strong>{cardCount}</strong>{` 个在「卡片」页展示`}
              {groupNames.length ? ` · ${groupNames.length} 个分组` : ''}
            </>
          ) : '添加一个 RSS 地址即可开始'}
        </span>
      )}>
        {bulk ? (
          <>
            <button className="btn" type="button" onClick={toggleSelectAll}>
              {allSelected ? '全不选' : '全选'}
            </button>
            <button className="btn" type="button" disabled={bulkDisabled} onClick={() => bulkPatch('enabled', true, '开启采集')}>开采集</button>
            <button className="btn" type="button" disabled={bulkDisabled} onClick={() => bulkPatch('enabled', false, '停止采集')}>关采集</button>
            <button className="btn" type="button" disabled={bulkDisabled} onClick={() => bulkPatch('cardEnabled', true, '加入卡片页')}>开卡片</button>
            <button className="btn" type="button" disabled={bulkDisabled} onClick={() => bulkPatch('cardEnabled', false, '移出卡片页')}>关卡片</button>
            <button className="btn" type="button" disabled={bulkDisabled} onClick={bulkMove}>移组</button>
            <button className="btn btn-danger" type="button" disabled={bulkDisabled} onClick={bulkDelete}>删除</button>
          </>
        ) : (
          <>
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
              disabled={busy === 'save' || (cfgLoaded && !cfgDirty)}
              onClick={onSaveCfg}
            >
              {busy === 'save' ? '保存中…' : '保存设置'}
            </button>
          </>
        )}
      </PaneFoot>

      {sheetFeed && (
        <FeedSheet
          key={sheetId}
          feed={sheetFeed}
          order={sheetOrder}
          globalMins={globalMins}
          busyFeed={busyFeed}
          pending={pendingIds.has(String(sheetId))}
          onClose={() => setSheetId(null)}
          onToggle={onToggle}
          onFreq={onFreqChange}
          onOrder={applyNumericOrder}
          onName={onCommitName}
          onUrl={onCommitUrl}
          onGroup={onCommitGroup}
          onRefresh={onRefreshFeed}
          onDelete={onDelete}
        />
      )}
    </div>
  );
}
