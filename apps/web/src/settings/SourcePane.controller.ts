/* 数据源面板的装配：状态、派生值、基础回调、副作用，以及各职责子 hook 的组合。
 * 行为逐字对齐原 1239 行单体实现；onRefreshAll 与卸载收尾 effect 留在 SourcePane.tsx
 * （进度端点/定时器清理的源码守卫锚点）。 */
import { useCallback, useRef, useState } from 'react';
import type { EntityId, Feed } from '../core/types.ts';
import { useFormLoadGuard } from './primitives.tsx';
import { useSourceActions } from './SourcePane.actions.ts';
import { useSourceBulk } from './SourcePane.bulk.ts';
import { useSourceConfigQuery } from './SourcePane.config.ts';
import { CFG_DEFAULTS } from './SourcePane.constants.ts';
import { useSourceDrag } from './SourcePane.drag.ts';
import { useSourcePanelEffects } from './SourcePane.effects.ts';
import { useSourceGroups } from './SourcePane.groups.ts';
import type { Cfg, FeedGroup } from './SourcePane.types.ts';
import { paramsSummary, patchInit, S } from './SourcePane.utils.ts';

export function useSourceController(admin: boolean, onDirtyChange?: (dirty: boolean) => void) {
  /* ---- 状态 ---- */
  const [_tick, setTick] = useState(0); // 原地改动后强制重绘（共享 state 是实时引用）
  const bump = useCallback(() => setTick((t) => t + 1), []);
  const [cfg, setCfg] = useState<Cfg>(CFG_DEFAULTS);
  const [savedCfg, setSavedCfg] = useState('');
  const [cfgLoaded, setCfgLoaded] = useState(false);
  const cfgGuard = useFormLoadGuard();
  const [imgStats, setImgStats] = useState({ count: 0, bytes: 0 });
  const [refreshProgress, setRefreshProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  const progressTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  const [feedQuery, setFeedQuery] = useState('');
  const [sheetId, setSheetId] = useState<EntityId | null>(null);
  const paneRef = useRef<HTMLDivElement>(null);

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

  const sheetFeed = sheetId == null ? null : feeds.find((f) => String(f.id) === String(sheetId));
  let sheetOrder = 1;
  if (sheetFeed) {
    const g = groups.find((x) => (x.feeds || []).some((f) => String(f.id) === String(sheetId)));
    if (g) sheetOrder = (g.feeds || []).findIndex((f) => String(f.id) === String(sheetId)) + 1;
  }

  /* ---- 稳定回调 ---- */
  const pushSummary = useCallback(() => {
    const s = S();
    if (s && s.setSettingsSummary && s.getSettingsSummary)
      s.setSettingsSummary(s.getSettingsSummary());
  }, []);

  // 配置 Query（仅管理员拉）+ 回填 + 统计，副作用自洽
  useSourceConfigQuery({ admin, cfgGuard, setCfg, setSavedCfg, setCfgLoaded, setImgStats });

  const reloadFeeds = useCallback(async () => {
    await S().loadFeeds();
    bump();
    pushSummary();
  }, [bump, pushSummary]);

  /** 频道 PATCH 统一走这里。返回响应 JSON（改地址要用它带回的 probe 判断新地址能不能抓到）。 */
  const patchFeed = useCallback(
    async (id: EntityId, patch: Record<string, unknown>, okMsg: string | null) => {
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
    async (
      f: Feed,
      patch: Record<string, unknown>,
      prevPatch: Record<string, unknown>,
      okMsg: string,
    ) => {
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

  /* ---- 职责子 hook ---- */
  const actions = useSourceActions({
    cfg,
    cfgLoaded,
    setCfg,
    setSavedCfg,
    cfgGuard,
    imgStats,
    setImgStats,
    sheetId,
    setSheetId,
    reloadFeeds,
    patchFeed,
    patchWithUndo,
    bump,
  });
  const drag = useSourceDrag({ bump });
  const bulk = useSourceBulk({
    feeds,
    displayGroups,
    fq,
    busy: actions.busy,
    setBusy: actions.setBusy,
    setSheetId,
    reloadFeeds,
    restoreFeed: actions.restoreFeed,
  });
  const grp = useSourceGroups({ reloadFeeds, bulk: bulk.bulk });

  /* ---- 未保存改动：采集参数 + 新增地址草稿 + 组重命名编辑态 ----
   * 详情层里的输入都是失焦即提交，没有跨开关的草稿，不计入 dirty。 */
  const cfgDirty = cfgLoaded && !!savedCfg && JSON.stringify(cfg) !== savedCfg;
  const sourceDirty = cfgDirty || actions.url.trim() !== '' || grp.renamingGroup != null;
  const { loadError, feedsLoading } = useSourcePanelEffects({
    admin,
    bump,
    pushSummary,
    paneRef,
    sourceDirty,
    onDirtyChange,
  });

  const paramsSub = paramsSummary(cfg);

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
    url: actions.url,
    setUrl: actions.setUrl,
    result: actions.result,
    setResult: actions.setResult,
    urlRef: actions.urlRef,
    openGroups: grp.openGroups,
    setOpenGroups: grp.setOpenGroups,
    renamingGroup: grp.renamingGroup,
    setRenamingGroup: grp.setRenamingGroup,
    renamingGroupDraft: grp.renamingGroupDraft,
    setRenamingGroupDraft: grp.setRenamingGroupDraft,
    groupRenameInputRef: grp.groupRenameInputRef,
    busyFeed: actions.busyFeed,
    busy: actions.busy,
    setBusy: actions.setBusy,
    refreshProgress,
    setRefreshProgress,
    progressTimer,
    pendingIds,
    drop: drag.drop,
    setDrop: drag.setDrop,
    dragging: drag.dragging,
    feedQuery,
    setFeedQuery,
    bulk: bulk.bulk,
    setBulk: bulk.setBulk,
    selected: bulk.selected,
    setSelected: bulk.setSelected,
    sheetId,
    setSheetId,
    sheetFeed,
    sheetOrder,
    selectedFeeds: bulk.selectedFeeds,
    visibleIds: bulk.visibleIds,
    allSelected: bulk.allSelected,
    hiddenSelected: bulk.hiddenSelected,
    lastDragEnd: drag.lastDragEnd,
    dragRef: drag.dragRef,
    moveRef: drag.moveRef,
    endRef: drag.endRef,
    onGripDown: drag.onGripDown,
    onHeadClick: grp.onHeadClick,
    startGroupRename: grp.startGroupRename,
    commitGroupRename: grp.commitGroupRename,
    onToggle: actions.onToggle,
    toggleSelect: bulk.toggleSelect,
    reloadFeeds,
    onAdd: actions.onAdd,
    onImport: actions.onImport,
    onSaveCfg: actions.onSaveCfg,
    onClearImgCache: actions.onClearImgCache,
    onRefreshFeed: actions.onRefreshFeed,
    onDelete: actions.onDelete,
    onFreqChange: actions.onFreqChange,
    applyNumericOrder: drag.applyNumericOrder,
    onCommitName: actions.onCommitName,
    onCommitUrl: actions.onCommitUrl,
    onCommitGroup: actions.onCommitGroup,
    toggleSelectAll: bulk.toggleSelectAll,
    enterBulk: bulk.enterBulk,
    exitBulk: bulk.exitBulk,
    bulkPatch: bulk.bulkPatch,
    bulkMove: bulk.bulkMove,
    bulkDelete: bulk.bulkDelete,
    bulkDisabled: bulk.bulkDisabled,
    setCfgField: actions.setCfgField,
    setCfgVal: actions.setCfgVal,
  };
}

export type SourceController = ReturnType<typeof useSourceController>;
