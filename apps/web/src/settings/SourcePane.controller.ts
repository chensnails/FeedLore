/* 数据源面板的状态、Query、副作用与全部操作：从 SourcePane.tsx 抽出，逐字对齐。
 * 仅 onRefreshAll 与卸载收尾 effect 留在原文件（进度端点/定时器清理的源码守卫锚点）。 */

import { useQuery } from '@tanstack/react-query';
import type * as React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { EntityId, Feed } from '../core/types.ts';
import { qk } from '../kernel/query.ts';
import { useFormLoadGuard } from './primitives.tsx';
import { CFG_DEFAULTS, KEEP_DAYS_OPTIONS } from './SourcePane.constants.ts';
import type {
  Cfg,
  DragCtx,
  DragKind,
  DropTarget,
  FeedGroup,
  FeedPatch,
  FeedResult,
  FeedSnapshot,
  GripPayload,
  ToggleKey,
} from './SourcePane.types.ts';
import { fmtMinutes, jsonPost, patchInit, S, snapshotFeed } from './SourcePane.utils.ts';

export function useSourceController(admin: boolean, onDirtyChange?: (dirty: boolean) => void) {
  /* ---- 状态 ---- */
  const [_tick, setTick] = useState(0); // 原地改动后强制重绘（共享 state 是实时引用）
  const bump = useCallback(() => setTick((t) => t + 1), []);

  const [cfg, setCfg] = useState<Cfg>(CFG_DEFAULTS); // 采集参数表单（字符串，与旧 DOM .value 一致）
  const [savedCfg, setSavedCfg] = useState(''); // 上次落库的指纹，用来算「改过没」
  const [cfgLoaded, setCfgLoaded] = useState(false); // 复刻旧 srcFormReady
  const [loadError, setLoadError] = useState(''); // /api/feeds 拉取失败（列表区兜底）
  const [feedsLoading, setFeedsLoading] = useState(true); // 首屏列表未到，不该显示「还没有订阅源」
  const cfgGuard = useFormLoadGuard(); // 采集参数：异步回填不许盖掉用户已改的字段
  const [imgStats, setImgStats] = useState({ count: 0, bytes: 0 }); // 图片缓存统计（v2.4.0）

  const [url, setUrl] = useState('');
  const [result, setResult] = useState<FeedResult>(null); // { ok, msg } | null —— #feedResult
  // A 方案：命名分组默认收起，这里记「显式展开」的组名（按账号持久化 srcGroupsOpen）
  const [openGroups, setOpenGroups] = useState<Set<string>>(
    () => new Set((S() && S().state && S().state.srcGroupsOpen) || []),
  );
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null); // 正在重命名的分组名
  const [renamingGroupDraft, setRenamingGroupDraft] = useState(''); // 组重命名草稿（提交式）
  const [busyFeed, setBusyFeed] = useState<EntityId | ''>(''); // 单频道「立即抓取」中的 id
  const [busy, setBusy] = useState(''); // '' | 'add' | 'import' | 'all' | 'save' | 'imgclear' | 'bulk'
  const [refreshProgress, setRefreshProgress] = useState<{ done: number; total: number } | null>(
    null,
  ); // 刷新全部时的 { done, total }
  const progressTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  // 某个频道有保存中的请求时禁用该行控件（防重复提交）
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  const [drop, setDrop] = useState<DropTarget>(null); // 拖拽落点指示 { type, id, group, before }
  const [dragging, setDragging] = useState(false);
  const [feedQuery, setFeedQuery] = useState(''); // 频道搜索（本地过滤，应对大量频道）
  const [bulk, setBulk] = useState(false); // 批量模式
  const [selected, setSelected] = useState<Set<string>>(() => new Set()); // 批量选中的频道 id（字符串）
  const [sheetId, setSheetId] = useState<EntityId | null>(null); // 打开详情层的频道 id
  const paneRef = useRef<HTMLDivElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const groupRenameInputRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<DragCtx | null>(null);
  const moveRef = useRef<((ev: PointerEvent) => void) | null>(null);
  const endRef = useRef<(() => void) | null>(null);
  const lastDragEnd = useRef(0); // 拖拽松手时间戳：250ms 内抑制行点击

  /* ---- 实时读取共享 state（单一数据源） ---- */
  const st = S().state;
  const feeds = st.feedList || [];
  const meta = st.feedMeta;
  const groups = S() && S().groupFeeds ? S().groupFeeds(feeds) : [];

  // 频道搜索过滤：默认空串时 displayGroups === groups（零行为变化，拖拽/分组测试不受影响）
  const fq = feedQuery.trim().toLowerCase();
  const displayGroups: FeedGroup[] = fq
    ? groups
        .map((g) => ({
          name: g.name,
          feeds: (g.feeds || []).filter((f) =>
            `${f.title || ''} ${f.customTitle || ''} ${f.url || ''} ${f.groupName || ''}`
              .toLowerCase()
              .includes(fq),
          ),
        }))
        .filter((g) => (g.feeds || []).length)
    : groups;

  const total = meta?.total || 0;
  const onCount = meta?.enabled || 0;
  const cardCount = meta?.cardEnabled == null ? onCount : meta.cardEnabled;
  const groupNames = meta?.groups || [];
  const globalMins = meta?.refreshMinutes || 30;
  const ownFreqCount = feeds.filter((f) => f.refreshMinutes != null).length;

  const selectedFeeds = feeds.filter((f) => selected.has(String(f.id)));
  // 批量「全选」只作用在当前筛选可见的频道：搜出 2 个却选中全部 50 个，
  // 紧接着「删除 / 关采集」会误伤看不见的频道。
  const visibleIds = displayGroups.reduce<string[]>(
    (acc, g) => acc.concat((g.feeds || []).map((f) => String(f.id))),
    [],
  );
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const hiddenSelected = fq
    ? selectedFeeds.filter((f) => visibleIds.indexOf(String(f.id)) < 0).length
    : 0;
  const sheetFeed = sheetId == null ? null : feeds.find((f) => String(f.id) === String(sheetId));
  let sheetOrder = 1;
  if (sheetFeed) {
    const g = groups.find((x) => (x.feeds || []).some((f) => String(f.id) === String(sheetId)));
    if (g) sheetOrder = (g.feeds || []).findIndex((f) => String(f.id) === String(sheetId)) + 1;
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
    if (s && s.setSettingsSummary && s.getSettingsSummary)
      s.setSettingsSummary(s.getSettingsSummary());
  }, []);

  // V5：/api/config 交给 Query（仅管理员拉）；queryFn 走 core.apiFetch 端口，测试桩照常生效。
  // 图片缓存统计沿用原来的「跟随 config、失败不阻塞」语义，放在同一 queryFn 尾部。
  const configQuery = useQuery({
    queryKey: qk.config,
    enabled: !!admin,
    queryFn: async () => {
      const res = await S().apiFetch('/api/config');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      let img = null;
      try {
        const sres = await S().apiFetch('/api/image-cache');
        if (sres.ok) img = await sres.json();
      } catch (_) {
        /* 统计接口异常时保持兜底 */
      }
      return { data, img };
    },
    refetchOnMount: 'always',
    // 条件挂载面板每次进入都是干净加载（旧实现无跨实例缓存），卸载即弃缓存；
    // 否则重挂载时旧 data 会先回填，破坏「未加载完禁止保存」的守卫。
    gcTime: 0,
    retry: false,
  });

  // 回填仍走 cfgGuard：首包到达前用户改过字段就保留输入，脏态基线按默认指纹算。
  useEffect(() => {
    if (configQuery.isPending || !configQuery.data) return;
    const { data } = configQuery.data;
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
    if (!applied) setSavedCfg((v) => v || JSON.stringify(CFG_DEFAULTS));
    setCfgLoaded(true);
    const img = configQuery.data.img;
    if (img) setImgStats({ count: Number(img.count) || 0, bytes: Number(img.bytes) || 0 });
  }, [configQuery.data, configQuery.isPending]);

  // 拉取失败：保持兜底值 + 禁止保存（与旧实现一致）。
  useEffect(() => {
    if (!configQuery.isError) return;
    setCfgLoaded(false);
    const s = S();
    if (s && s.toast) {
      const err = configQuery.error;
      const msg = err instanceof Error ? err.message : String(err);
      s.toast('采集参数读取失败：' + msg, false);
    }
  }, [configQuery.isError, configQuery.error]);

  const reloadFeeds = useCallback(async () => {
    await S().loadFeeds();
    bump();
    pushSummary();
  }, [bump, pushSummary]);

  /** 频道 PATCH 统一走这里。返回响应 JSON（改地址要用它带回的 probe 判断新地址能不能抓到）。 */
  const patchFeed = useCallback(
    async (id: EntityId, patch: FeedPatch, okMsg: string | null) => {
      const s = S();
      const key = String(id);
      setPendingIds((p) => {
        const n = new Set(p);
        n.add(key);
        return n;
      });
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
        setPendingIds((p) => {
          const n = new Set(p);
          n.delete(key);
          return n;
        });
      }
    },
    [reloadFeeds],
  );

  /** 即改即生效 + 撤销：先按新值落库，toast 挂 6 秒撤销（按旧值再落一次）。
   *  失败时 bump 让受控控件回滚到服务端值。 */
  const patchWithUndo = useCallback(
    async (f: Feed, patch: FeedPatch, prevPatch: FeedPatch, okMsg: string) => {
      const s = S();
      try {
        await patchFeed(f.id, patch, null);
        s.toast(okMsg, true, {
          actionText: '撤销',
          ms: 6000,
          action: async () => {
            try {
              await patchFeed(f.id, prevPatch, '已撤销');
            } catch (e) {
              s.toast('撤销失败：' + (e.message || e), false);
            }
          },
        });
      } catch (err) {
        bump();
        s.toast('保存失败：' + (err.message || err), false);
      }
    },
    [patchFeed, bump],
  );

  // 按 groupOrder 把分组铺平为全局数组（组内保持相对顺序），并给每组重算 sort_order
  const flattenAndRenumber = useCallback((grouped: FeedGroup[]) => {
    const s = S();
    const order = s.state.groupOrder || [];
    const seq: FeedGroup[] = [];
    for (const n of order) {
      const g = grouped.find((x) => x.name === n);
      if (g) seq.push(g);
    }
    for (const g of grouped) if (order.indexOf(g.name) < 0) seq.push(g);
    const flat: Feed[] = [];
    let so = 0;
    for (const g of seq)
      for (const f of g.feeds || []) {
        f.sortOrder = so++;
        flat.push(f);
      }
    s.state.feedList = flat;
  }, []);

  const persistReorder = useCallback(async () => {
    const s = S();
    const items = (s.state.feedList || []).map((f) => ({
      id: f.id,
      sortOrder: f.sortOrder,
      groupName: f.groupName || '',
    }));
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
    } catch (e) {
      console.error('保存分组顺序失败', e);
    }
  }, []);

  const groupOfRow = useCallback((row: HTMLElement) => {
    const id = row.getAttribute('data-id');
    if (!id) return '';
    const f = (S().state.feedList || []).find((x) => String(x.id) === String(id));
    return f ? f.groupName || '' : '';
  }, []);

  const applyFeedReorder = useCallback(
    (ctx: DragCtx) => {
      const s = S();
      const dragId = ctx.id;
      const grouped: FeedGroup[] = s.groupFeeds(s.state.feedList || []);
      for (const g of grouped) {
        const feeds = g.feeds || [];
        const i = feeds.findIndex((f) => String(f.id) === String(dragId));
        if (i >= 0) {
          feeds.splice(i, 1);
          break;
        }
      }
      const t = ctx.target!;
      let gi = grouped.findIndex((g) => g.name === t.group);
      if (gi < 0) {
        grouped.push({ name: t.group || '', feeds: [] });
        gi = grouped.length - 1;
      }
      const targetFeeds = grouped[gi]!.feeds || [];
      grouped[gi]!.feeds = targetFeeds;
      let idx: number;
      if (t.type === 'head') idx = 0;
      else {
        const tid = t.id;
        idx = targetFeeds.findIndex((f) => String(f.id) === String(tid));
        if (idx < 0) idx = targetFeeds.length;
        else if (!t.before) idx += 1;
      }
      const dragFeed = (s.state.feedList || []).find((f) => String(f.id) === String(dragId));
      if (!dragFeed) return;
      dragFeed.groupName = t.group || '';
      targetFeeds.splice(idx, 0, dragFeed);
      flattenAndRenumber(grouped);
      bump();
      if (s.renderReaderChannels) s.renderReaderChannels();
      if (s.renderFeedSelect) s.renderFeedSelect();
      persistReorder();
    },
    [bump, flattenAndRenumber, persistReorder],
  );
  const applyGroupReorder = useCallback(
    (ctx: DragCtx) => {
      const s = S();
      const order = (s.state.groupOrder || []).slice();
      const i = order.indexOf(ctx.group);
      if (i >= 0) order.splice(i, 1);
      const t = ctx.target!;
      let j = order.indexOf(t.group);
      if (j < 0) j = order.length;
      else if (!t.before) j += 1;
      order.splice(j, 0, ctx.group);
      s.state.groupOrder = order;
      const grouped: FeedGroup[] = s.groupFeeds(s.state.feedList || []);
      flattenAndRenumber(grouped);
      bump();
      if (s.renderReaderChannels) s.renderReaderChannels();
      if (s.renderFeedSelect) s.renderFeedSelect();
      persistReorder();
      persistGroupOrder();
    },
    [bump, flattenAndRenumber, persistGroupOrder, persistReorder],
  );

  // 手动填序号：把某频道排到所在分组的第 N 位（1 基），与拖拽并存。
  // 只在「本组」内调整顺序；跨组仍用拖拽（拖拽会改 groupName）。
  const applyNumericOrder = useCallback(
    (id: EntityId, pos: number) => {
      const s = S();
      if (!Number.isFinite(pos) || pos < 1) {
        bump();
        return;
      } // 非法输入：恢复显示
      const grouped: FeedGroup[] = s.groupFeeds(s.state.feedList || []);
      let src: FeedGroup | null = null;
      for (const g of grouped) {
        const i = (g.feeds || []).findIndex((f) => String(f.id) === String(id));
        if (i >= 0) {
          src = g;
          break;
        }
      }
      if (!src) return;
      const feeds = src.feeds || [];
      src.feeds = feeds;
      const i = feeds.findIndex((f) => String(f.id) === String(id));
      const feed = feeds.splice(i, 1)[0];
      if (!feed) return;
      const p = Math.min(Math.max(1, Math.floor(pos)), feeds.length + 1);
      feeds.splice(p - 1, 0, feed);
      flattenAndRenumber(grouped); // 重算全局 sort_order（组内顺序由它决定）
      bump();
      if (s.renderReaderChannels) s.renderReaderChannels();
      if (s.renderFeedSelect) s.renderFeedSelect();
      persistReorder();
    },
    [bump, flattenAndRenumber, persistReorder],
  );

  /* ---- 拖拽（Pointer 事件，移植自旧实现） ---- */
  const onDragMove = useCallback(
    (ev: PointerEvent) => {
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
      if (!under) {
        ctx.target = null;
        setDrop(null);
        return;
      }
      if (ctx.kind === 'feed') {
        const row = under.closest('.feed-row');
        const head = under.closest('.feed-group-head');
        let elm = null,
          before = true,
          group = '';
        if (row && ctx.el && !row.contains(ctx.el)) {
          const r = row.getBoundingClientRect();
          before = ev.clientY < r.top + r.height / 2;
          elm = row;
          group = groupOfRow(row as HTMLElement);
        } else if (head && ctx.el && !head.contains(ctx.el)) {
          elm = head;
          group = head.getAttribute('data-group') || '';
          before = true;
        }
        if (!elm) {
          ctx.target = null;
          setDrop(null);
          return;
        }
        ctx.target = {
          type: elm === head ? 'head' : 'row',
          id: elm.getAttribute('data-id') || '',
          group,
          before,
        };
        setDrop(ctx.target);
      } else {
        const head = under.closest('.feed-group-head');
        let elm = null,
          before = true;
        if (head && ctx.el && !head.contains(ctx.el)) {
          const r = head.getBoundingClientRect();
          before = ev.clientY < r.top + r.height / 2;
          elm = head;
        }
        if (!elm) {
          ctx.target = null;
          setDrop(null);
          return;
        }
        ctx.target = {
          type: 'group',
          id: '',
          group: elm.getAttribute('data-group') || '',
          before,
        };
        setDrop(ctx.target);
      }
    },
    [groupOfRow],
  );

  const onDragEnd = useCallback(() => {
    const mv = moveRef.current;
    if (mv) document.removeEventListener('pointermove', mv);
    const ed = endRef.current;
    if (ed) {
      document.removeEventListener('pointerup', ed);
      document.removeEventListener('pointercancel', ed);
    }
    document.body.classList.remove('is-dragging-feeds');
    const ctx = dragRef.current;
    dragRef.current = null;
    setDragging(false);
    setDrop(null);
    if (ctx && ctx.el) ctx.el.style.pointerEvents = '';
    if (!ctx || !ctx.moved) return;
    lastDragEnd.current = Date.now(); // 松手后短暂抑制行点击，避免误开详情层
    if (!ctx.target) return;
    if (ctx.kind === 'feed') applyFeedReorder(ctx);
    else applyGroupReorder(ctx);
  }, [applyFeedReorder, applyGroupReorder]);

  moveRef.current = onDragMove;
  endRef.current = onDragEnd;

  const onGripDown = (
    ev: React.PointerEvent<HTMLElement>,
    kind: DragKind,
    payload: GripPayload,
  ) => {
    if (ev.button != null && ev.button !== 0) return;
    if (kind === 'group' && payload.group === '') return; // 「未分组」不可拖动（仍可作放置目标）
    const el = (ev.target as HTMLElement).closest(
      kind === 'feed' ? '.feed-row' : '.feed-group-head',
    );
    if (!el) return;
    ev.preventDefault();
    dragRef.current = {
      kind,
      id: payload.id == null ? '' : String(payload.id),
      group: payload.group || '',
      el: el as HTMLElement,
      x0: ev.clientX,
      y0: ev.clientY,
      moved: false,
      target: null,
    };
    const mv = moveRef.current;
    if (mv) document.addEventListener('pointermove', mv, { passive: false });
    const ed = endRef.current;
    if (ed) {
      document.addEventListener('pointerup', ed);
      document.addEventListener('pointercancel', ed);
    }
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
    return () => {
      cancelled = true;
    };
  }, [bump, pushSummary]);

  // 采集参数改由 configQuery.enabled=admin 驱动（普通用户不发 /api/config）；
  // 切回管理员时 SourcePane 重新挂载，refetchOnMount:'always' 补拉配置。

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

  /* ---- 动作 ---- */
  const onAdd = async () => {
    const u = url.trim();
    if (!u) {
      setResult({ ok: false, msg: '请先填入 RSS 地址' });
      if (urlRef.current) urlRef.current.focus();
      return;
    }
    const s = S();
    setBusy('add');
    setResult(null);
    try {
      // 30 秒兜底：添加订阅要等服务端去抓一次，遇到慢站或死站会一直挂着，
      // 按钮永远停在「添加中…」，用户既不知道还要等多久也不知道是不是卡了。
      const res = await s.apiFetch(
        '/api/feeds',
        Object.assign(jsonPost({ url: u }), { signal: AbortSignal.timeout(30000) }),
      );
      const data = await res.json();
      if (!res.ok) {
        setResult({ ok: false, msg: s.errText(data, '添加失败') });
        return;
      }
      setUrl('');
      setResult({
        ok: true,
        msg: `已添加「${s.shortFeedName(s.feedTitle(data.feed))}」，新增 ${data.added} 条`,
      });
      s.toast('订阅已添加');
      await reloadFeeds();
      s.state.tag = null;
      if (s.loadPage) await s.loadPage(true);
    } catch (err) {
      const timedOut = !!(err && (err.name === 'TimeoutError' || err.name === 'AbortError'));
      setResult({
        ok: false,
        msg: timedOut
          ? '抓取超时（30 秒）：这个地址可能太慢或没有响应'
          : '添加失败：' + (err.message || err),
      });
    } finally {
      setBusy('');
    }
  };

  const onImport = async (ev: React.ChangeEvent<HTMLInputElement>) => {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = ''; // 允许重新选择同一文件
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

  const onRefreshFeed = async (id: EntityId) => {
    const s = S();
    setBusyFeed(id);
    try {
      const res = await s.apiFetch('/api/feeds/' + id + '/refresh', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.ok)
        throw new Error(s.errText((data.result && data.result.error) || data.error, '抓取失败'));
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
  const restoreFeed = useCallback(async (snap: FeedSnapshot) => {
    const s = S();
    const res = await s.apiFetch(
      '/api/feeds',
      jsonPost({
        url: snap.url,
        enabled: snap.enabled,
        cardEnabled: snap.cardEnabled,
        groupName: snap.groupName,
      }),
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(s.errText(data, '恢复失败'));
    if (!data.existed && data.feed) {
      const extra: FeedPatch = {};
      if (snap.fullText) extra.fullText = true;
      if (snap.refreshMinutes != null) extra.refreshMinutes = snap.refreshMinutes;
      if (snap.customTitle) extra.title = snap.customTitle;
      if (Object.keys(extra).length)
        await s.apiFetch('/api/feeds/' + data.feed.id, patchInit(extra));
    }
  }, []);

  const onDelete = async (f: Feed) => {
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
        actionText: '撤销',
        ms: 6000,
        action: async () => {
          try {
            await restoreFeed(snap);
            await reloadFeeds();
            if (s.loadPage) await s.loadPage(true);
            s.toast('已恢复订阅');
          } catch (e) {
            s.toast('撤销失败：' + (e.message || e), false);
          }
        },
      });
    } catch (err) {
      s.toast('删除失败：' + (err.message || err), false);
    }
  };

  const onSaveCfg = async () => {
    if (!cfgLoaded) {
      setResult({ ok: false, msg: '设置尚未加载完成，请稍后再试' });
      return;
    }
    const s = S();
    setBusy('save');
    try {
      // v2 契约全是整数：输入框存的是字符串，提交前统一转数字（空串按 0，由服务端夹取）
      const num = (v: unknown) => Number(v) || 0;
      const res = await s.apiFetch(
        '/api/config',
        jsonPost({
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
        }),
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setResult({ ok: false, msg: s.errText(data, '保存失败') });
        return;
      }
      // 表单保存只用内联结果，不再叠一层 toast（列表级动作才用 toast）
      setResult({ ok: true, msg: '抓取设置已保存' });
      setSavedCfg(JSON.stringify(cfg));
      if (s.scheduleAutoRefresh) s.scheduleAutoRefresh(); // 立刻按新的「页面自动刷新」间隔重排
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
  const onToggle = async (f: Feed, key: ToggleKey, next: boolean, okMsg: string) => {
    await patchWithUndo(f, { [key]: next }, { [key]: f[key] }, okMsg);
  };

  const onCommitName = useCallback(
    async (f: Feed, raw: string) => {
      const s = S();
      const val = String(raw == null ? '' : raw)
        .trim()
        .slice(0, 200);
      if (val === s.feedTitle(f)) return; // 没变
      if (!val && !f.customTitle) return; // 本来就是原标题，无需清空
      await patchWithUndo(
        f,
        { title: val },
        { title: f.customTitle || '' },
        val ? '名称已更新' : '已恢复原标题',
      );
    },
    [patchWithUndo],
  );

  /* 改订阅地址：校验与「同用户 URL 唯一」判重都在后端（与新增共用 rss.assertFeedUrl）。
   * 服务端改完会按新地址当场试抓一次，结果走 probe 反馈；地址变更不做撤销（试抓有副作用）。 */
  const onCommitUrl = useCallback(
    async (f: Feed, raw: string) => {
      const s = S();
      const val = String(raw == null ? '' : raw).trim();
      if (!val || val === f.url) return;
      try {
        const data = await patchFeed(f.id, { url: val }, '订阅地址已更新');
        const probe = data && data.probe;
        if (!probe) return;
        if (!probe.ok)
          s.toast(
            '新地址抓取失败：' + s.errText(probe, '未知错误') + '（地址已保存，下个周期自动重试）',
            false,
          );
        else if (probe.added) s.toast('新地址可用：本次新增 ' + probe.added + ' 条');
      } catch (err) {
        bump();
        s.toast('地址未更新：' + (err.message || err), false);
      }
    },
    [patchFeed, bump],
  );

  const onCommitGroup = useCallback(
    async (f: Feed, raw: string) => {
      const val = String(raw == null ? '' : raw)
        .trim()
        .slice(0, 40);
      if (val === (f.groupName || '')) return;
      await patchWithUndo(
        f,
        { groupName: val },
        { groupName: f.groupName || '' },
        val ? `已归入「${val}」` : '已移出分组',
      );
    },
    [patchWithUndo],
  );

  /* ---- 分组重命名：一次改组 + 同步分组顺序 ----
   * 语义：把组内所有频道改到新组名；新名与已有组同名时相当于「合并分组」。
   * 逐个 PATCH（每组频道数有限），不新增批量接口。 */
  const startGroupRename = (g: FeedGroup) => {
    setRenamingGroupDraft(g.name);
    setRenamingGroup(g.name);
  };
  const commitGroupRename = useCallback(
    async (g: FeedGroup, rawNext: string) => {
      const s = S();
      setRenamingGroup(null);
      const oldName = String(g.name || '');
      const val = String(rawNext == null ? '' : rawNext)
        .trim()
        .slice(0, 40);
      if (!val || val === oldName) return;
      const members = (s.state.feedList || []).filter(
        /** @param {*} [f] */ (f) => String(f.groupName || '').trim() === oldName,
      );
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
    },
    [reloadFeeds, openGroups],
  );

  const onFreqChange = useCallback(
    async (f: Feed, next: number | null) => {
      const cur = f.refreshMinutes == null ? null : Number(f.refreshMinutes);
      if (cur === next) return;
      await patchWithUndo(
        f,
        { refreshMinutes: next },
        { refreshMinutes: cur },
        next == null ? '已改为跟随全局频率' : `该频道已设为每 ${fmtMinutes(next)}抓取`,
      );
    },
    [patchWithUndo],
  );

  const onHeadClick = (
    ev: React.MouseEvent<HTMLElement> | React.KeyboardEvent<HTMLElement>,
    g: FeedGroup,
  ) => {
    const target = ev.target as HTMLElement;
    if (target.closest('.drag-handle')) return; // 手柄区域是拖拽，不触发折叠
    if (target.closest('.feed-group-rename') || target.closest('.feed-group-edit')) return;
    if (!g.name || bulk) return; // 未分组常开；批量模式下全部展开
    const next = new Set(openGroups);
    if (next.has(g.name)) next.delete(g.name);
    else next.add(g.name);
    setOpenGroups(next);
    const s = S();
    if (s.setLayout) s.setLayout('srcGroupsOpen', [...next]);
  };

  /* ---- 批量模式 ---- */
  const toggleSelect = (id: EntityId) =>
    setSelected((p) => {
      const n = new Set(p);
      const k = String(id);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const toggleSelectAll = () =>
    setSelected(
      /** @param {*} [p] */ (p) => {
        const n = new Set(p);
        for (const id of visibleIds) {
          if (allSelected) n.delete(id);
          else n.add(id);
        }
        return n;
      },
    );
  const enterBulk = () => {
    setSheetId(null);
    setBulk(true);
  };
  const exitBulk = () => {
    setBulk(false);
    setSelected(new Set());
  };

  /** 批量开关：只改与目标值不同的频道；撤销按原值（布尔取反）逐个还原 */
  const bulkPatch = async (key: 'enabled' | 'cardEnabled', next: boolean, label: string) => {
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
        actionText: '撤销',
        ms: 6000,
        action: async () => {
          try {
            for (const f of targets)
              await s.apiFetch('/api/feeds/' + f.id, patchInit({ [key]: !next }));
            await reloadFeeds();
            if (s.loadPage) await s.loadPage(true);
            s.toast('已撤销');
          } catch (e) {
            s.toast('撤销失败：' + (e.message || e), false);
          }
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
      input: { placeholder: '分组名（留空移出分组，未分组）' },
      confirmText: '移动',
    });
    if (val == null) return;
    const group = String(val).trim().slice(0, 40);
    const targets = selectedFeeds.filter(
      /** @param {*} [f] */ (f) => (f.groupName || '') !== group,
    );
    if (!targets.length) return;
    setBusy('bulk');
    try {
      for (const f of targets)
        await s.apiFetch('/api/feeds/' + f.id, patchInit({ groupName: group }));
      await reloadFeeds();
      s.toast(
        group
          ? `已移入「${group}」（${targets.length} 个频道）`
          : `已移出分组（${targets.length} 个频道）`,
        true,
        {
          actionText: '撤销',
          ms: 6000,
          action: async () => {
            try {
              for (const f of targets)
                await s.apiFetch('/api/feeds/' + f.id, patchInit({ groupName: f.groupName || '' }));
              await reloadFeeds();
              s.toast('已撤销');
            } catch (e) {
              s.toast('撤销失败：' + (e.message || e), false);
            }
          },
        },
      );
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
    const ids = selectedFeeds.map(/** @param {*} [f] */ (f) => f.id);
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
        actionText: '撤销',
        ms: 6000,
        action: async () => {
          try {
            for (const snap of snaps) await restoreFeed(snap);
            await reloadFeeds();
            if (s.loadPage) await s.loadPage(true);
            s.toast('已恢复订阅');
          } catch (e) {
            s.toast('撤销失败：' + (e.message || e), false);
          }
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
    const keepDaysText =
      keepDays > 0
        ? (KEEP_DAYS_OPTIONS.find(/** @param {*} arr */ ([v]) => v === keepDays) || [
            null,
            `${keepDays} 天`,
          ])[1]
        : '不限时长';
    const auto = Number(cfg.autoRefreshMinutes || 0);
    const keepN = Number(cfg.keepPerFeed || 0);
    const keepNText = keepN > 0 ? `${keepN} 条` : '不限条数';
    const proxy = String(cfg.proxyUrl || '').trim();
    const proxyText = proxy ? ` · 代理 ${proxy.replace(/\/\/[^@]*@/, '//***@')}` : '';
    return (
      `每 ${fmtMinutes(cfg.refreshMinutes)}抓取 · 保留 ${keepNText}` +
      ` · ${keepDaysText}` +
      (auto ? ` · 页面刷新 ${fmtMinutes(auto)}` : '') +
      proxyText
    );
  })();

  const setCfgField = (k: keyof Cfg) => (ev: React.ChangeEvent<HTMLInputElement>) => {
    cfgGuard.mark();
    setCfg((c) => Object.assign({}, c, { [k]: ev.target.value }));
  };
  // 自绘 Dropdown 的 onChange 直接给值（不是 event），与 input 的 setCfgField 分开。
  const setCfgVal = (k: keyof Cfg) => (v: string | number) => {
    cfgGuard.mark();
    setCfg((c) => Object.assign({}, c, { [k]: String(v) }));
  };

  const bulkDisabled = !selectedFeeds.length || busy === 'bulk';

  return {
    paneRef,
    admin,
    cfg,
    cfgLoaded,
    cfgDirty,
    cfgGuard,
    sourceDirty,
    loadError,
    feedsLoading,
    feeds,
    meta,
    groups,
    displayGroups,
    fq,
    total,
    onCount,
    cardCount,
    groupNames,
    globalMins,
    ownFreqCount,
    imgStats,
    paramsSub,
    url,
    setUrl,
    result,
    setResult,
    urlRef,
    openGroups,
    setOpenGroups,
    renamingGroup,
    setRenamingGroup,
    renamingGroupDraft,
    setRenamingGroupDraft,
    groupRenameInputRef,
    busyFeed,
    busy,
    setBusy,
    refreshProgress,
    setRefreshProgress,
    progressTimer,
    pendingIds,
    drop,
    setDrop,
    dragging,
    feedQuery,
    setFeedQuery,
    bulk,
    setBulk,
    selected,
    setSelected,
    sheetId,
    setSheetId,
    sheetFeed,
    sheetOrder,
    selectedFeeds,
    visibleIds,
    allSelected,
    hiddenSelected,
    lastDragEnd,
    dragRef,
    moveRef,
    endRef,
    onGripDown,
    onHeadClick,
    startGroupRename,
    commitGroupRename,
    onToggle,
    toggleSelect,
    reloadFeeds,
    onAdd,
    onImport,
    onSaveCfg,
    onClearImgCache,
    onRefreshFeed,
    onDelete,
    onFreqChange,
    applyNumericOrder,
    onCommitName,
    onCommitUrl,
    onCommitGroup,
    toggleSelectAll,
    enterBulk,
    exitBulk,
    bulkPatch,
    bulkMove,
    bulkDelete,
    bulkDisabled,
    setCfgField,
    setCfgVal,
  };
}

export type SourceController = ReturnType<typeof useSourceController>;
