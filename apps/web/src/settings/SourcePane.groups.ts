/* 数据源面板：分组折叠与分组重命名。从 SourcePane.controller.ts 抽出，逐字对齐。 */
import type * as React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FeedGroup } from './SourcePane.types.ts';
import { jsonPost, patchInit, S } from './SourcePane.utils.ts';

/** 分组展开态（按账号持久化）、组重命名编辑态、组头点击折叠。 */
export function useSourceGroups(opts: { reloadFeeds: () => Promise<void>; bulk: boolean }) {
  const { reloadFeeds, bulk } = opts;
  // A 方案：命名分组默认收起，这里记「显式展开」的组名（按账号持久化 srcGroupsOpen）
  const [openGroups, setOpenGroups] = useState<Set<string>>(
    () => new Set((S() && S().state && S().state.srcGroupsOpen) || []),
  );
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null); // 正在重命名的分组名
  const [renamingGroupDraft, setRenamingGroupDraft] = useState(''); // 组重命名草稿（提交式）
  const groupRenameInputRef = useRef<HTMLInputElement>(null);

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

  // 分组重命名输入框：挂上即聚焦并全选
  useEffect(() => {
    if (renamingGroup && groupRenameInputRef.current) {
      groupRenameInputRef.current.focus();
      groupRenameInputRef.current.select();
    }
  }, [renamingGroup]);

  return {
    openGroups,
    setOpenGroups,
    renamingGroup,
    setRenamingGroup,
    renamingGroupDraft,
    setRenamingGroupDraft,
    groupRenameInputRef,
    startGroupRename,
    commitGroupRename,
    onHeadClick,
  };
}
