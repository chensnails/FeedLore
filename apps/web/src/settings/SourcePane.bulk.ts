/* 数据源面板：批量模式——选择集、可见性派生、四个动作（开关 / 移动 / 删除，均带撤销）。 */
import type { Dispatch, SetStateAction } from 'react';
import { useState } from 'react';
import type { EntityId, Feed } from '../core/types.ts';
import { undoWindowMs } from '../core/util.toast.ts';
import type { FeedGroup, FeedSnapshot } from './SourcePane.types.ts';
import { patchInit, S, snapshotFeed } from './SourcePane.utils.ts';

/** 并发跑一批恢复动作，失败不中断其它项；返回失败项供「重试剩余」用。 */
async function parallelWithFailures<T>(
  items: readonly T[],
  run: (item: T) => Promise<void>,
): Promise<T[]> {
  const settled = await Promise.all(
    items.map(async (item) => {
      try {
        await run(item);
        return true;
      } catch {
        return false;
      }
    }),
  );
  return items.filter((_item, i) => !settled[i]);
}

/** 撤销结果反馈：全成给成功提示；部分失败给中文失败数并挂「重试剩余」动作。 */
function reportUndoResult(
  s: ReturnType<typeof S>,
  failed: number,
  total: number,
  okText: string,
  retry: () => Promise<void>,
) {
  if (!failed) {
    // v3.0.1：成功也给出数量，让批量操作的确定性可感知；文案前缀保持不变，
    // 既有「已撤销」「已恢复订阅」的语义与读屏播报都不变，只是尾部补一项计数。
    s.toast(`${okText} · ${total} 项`);
    return;
  }
  s.toast(`已撤销 ${total - failed} 项，${failed} 项未成功`, false, {
    actionText: '重试剩余',
    ms: undoWindowMs(failed),
    action: retry,
  });
}

/** 批量选择相关的状态、派生与动作。feeds/displayGroups 由主 controller 传入。 */
export function useSourceBulk(opts: {
  feeds: Feed[];
  displayGroups: FeedGroup[];
  fq: string;
  busy: string;
  setBusy: Dispatch<SetStateAction<string>>;
  setSheetId: Dispatch<SetStateAction<EntityId | null>>;
  reloadFeeds: () => Promise<void>;
  restoreFeed: (snap: FeedSnapshot) => Promise<void>;
}) {
  const { feeds, displayGroups, fq, busy, setBusy, setSheetId, reloadFeeds, restoreFeed } = opts;
  const [bulk, setBulk] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

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
  const bulkDisabled = !selectedFeeds.length || busy === 'bulk';

  const toggleSelect = (id: EntityId) =>
    setSelected((p) => {
      const n = new Set(p);
      const k = String(id);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const toggleSelectAll = () =>
    setSelected((p) => {
      const n = new Set(p);
      for (const id of visibleIds) {
        if (allSelected) n.delete(id);
        else n.add(id);
      }
      return n;
    });
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
        ms: undoWindowMs(targets.length),
        action: async () => {
          const failed = await parallelWithFailures(targets, (f) =>
            s.apiFetch('/api/feeds/' + f.id, patchInit({ [key]: !next })).then((res) => {
              if (!res.ok) throw new Error('HTTP ' + res.status);
            }),
          );
          await reloadFeeds().catch(() => {});
          if (s.loadPage) await s.loadPage(true);
          reportUndoResult(s, failed.length, targets.length, '已撤销', async () => {
            const left = await parallelWithFailures(failed, (f) =>
              s.apiFetch('/api/feeds/' + f.id, patchInit({ [key]: !next })).then((res) => {
                if (!res.ok) throw new Error('HTTP ' + res.status);
              }),
            );
            await reloadFeeds().catch(() => {});
            s.toast(left.length ? `仍有 ${left.length} 个未撤销` : '已撤销剩余项', left.length > 0);
          });
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
    const targets = selectedFeeds.filter((f) => (f.groupName || '') !== group);
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
          ms: undoWindowMs(targets.length),
          action: async () => {
            const run = (f: Feed) =>
              s
                .apiFetch('/api/feeds/' + f.id, patchInit({ groupName: f.groupName || '' }))
                .then((res) => {
                  if (!res.ok) throw new Error('HTTP ' + res.status);
                });
            const failed = await parallelWithFailures(targets, run);
            await reloadFeeds().catch(() => {});
            reportUndoResult(s, failed.length, targets.length, '已撤销', async () => {
              const left = await parallelWithFailures(failed, run);
              await reloadFeeds().catch(() => {});
              s.toast(
                left.length ? `仍有 ${left.length} 个未撤销` : '已撤销剩余项',
                left.length > 0,
              );
            });
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
        actionText: '撤销',
        ms: undoWindowMs(ids.length),
        action: async () => {
          const failed = await parallelWithFailures(snaps, restoreFeed);
          await reloadFeeds().catch(() => {});
          if (s.loadPage) await s.loadPage(true);
          reportUndoResult(s, failed.length, snaps.length, '已恢复订阅', async () => {
            const left = await parallelWithFailures(failed, restoreFeed);
            await reloadFeeds().catch(() => {});
            if (s.loadPage) await s.loadPage(true);
            s.toast(
              left.length ? `仍有 ${left.length} 个未恢复` : '已恢复剩余订阅',
              left.length > 0,
            );
          });
        },
      });
    } catch (err) {
      s.toast('批量删除失败：' + (err.message || err), false);
      await reloadFeeds().catch(() => {});
    } finally {
      setBusy('');
    }
  };

  return {
    bulk,
    setBulk,
    selected,
    setSelected,
    selectedFeeds,
    visibleIds,
    allSelected,
    hiddenSelected,
    bulkDisabled,
    toggleSelect,
    toggleSelectAll,
    enterBulk,
    exitBulk,
    bulkPatch,
    bulkMove,
    bulkDelete,
  };
}
