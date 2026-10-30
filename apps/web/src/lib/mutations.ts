import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  Appearance,
  EntriesListResponse,
  EntryDetail,
  FeedCreateBody,
  FeedPatchBody,
  PrefsPatchBody,
  ReadAllBody,
} from '@feedlore/contract';
import { api } from './api';
import { applyAppearance } from './appearance';
import { qk } from './query';
import { useUi } from '../store/ui';

/**
 * 写操作的唯一入口。
 *
 * 三条纪律（照抄 v1.x 的病根反思）：
 * 1. **组件里不直接调 `api.xxx`**：写操作要伴随缓存失效、乐观更新、错误提示，
 *    散在组件里必然出现「这里失效了那里没失效」——v1.x 的 `window.dispatchEvent` 就是这种散。
 * 2. **能乐观更新的才乐观**：已读/收藏是「点了立刻该变」的，用缓存改写；
 *    增删频道会改变列表结构，直接 invalidate，不做假象。
 * 3. 失败**必须回滚并重新拉取**：乐观更新过的缓存不能留着，否则界面会一直显示没保存成功的样子。
 */

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 就地改写条目缓存（列表里所有页 + 已打开的详情）。 */
function patchEntryCache(qc: QueryClient, id: string, patch: Partial<EntryDetail>): void {
  qc.setQueriesData<EntriesListResponse>({ queryKey: qk.entries }, (old) => {
    if (!old) return old;
    return { ...old, entries: old.entries.map((e) => (e.id === id ? { ...e, ...patch } : e)) };
  });
  qc.setQueriesData<EntryDetail>({ queryKey: qk.entry }, (old) =>
    old && old.id === id ? { ...old, ...patch } : old,
  );
}

/* ============================ 条目标记 ============================ */

/** 已读 / 未读。乐观更新，失败回滚并重取。 */
export function useSetRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, isRead }: { id: string; isRead: boolean }) =>
      api.entries.flagPatch(id, { isRead }),
    onMutate: async ({ id, isRead }) => {
      await qc.cancelQueries({ queryKey: qk.entries });
      patchEntryCache(qc, id, { isRead });
    },
    onError: (e) => {
      void qc.invalidateQueries({ queryKey: qk.entries });
      void qc.invalidateQueries({ queryKey: qk.entry });
      useUi.getState().notify(`标记已读失败：${errText(e)}`, 'error');
    },
    // 徽标计数在 feeds 里，标完要刷新
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.feeds });
    },
  });
}

/** 收藏 / 取消收藏。 */
export function useSetFavorite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, isFavorite }: { id: string; isFavorite: boolean }) =>
      api.entries.flagPatch(id, { isFavorite }),
    onMutate: async ({ id, isFavorite }) => {
      await qc.cancelQueries({ queryKey: qk.entries });
      patchEntryCache(qc, id, { isFavorite });
    },
    onError: (e) => {
      void qc.invalidateQueries({ queryKey: qk.entries });
      void qc.invalidateQueries({ queryKey: qk.entry });
      useUi.getState().notify(`收藏失败：${errText(e)}`, 'error');
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.feeds });
    },
  });
}

/** 按当前筛选条件全部已读。 */
export function useReadAll() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ReadAllBody) => api.entries.readAll(body),
    onSuccess: (r) => {
      useUi.getState().notify(r.updated > 0 ? `已标记 ${r.updated} 条为已读` : '没有未读条目');
      void qc.invalidateQueries({ queryKey: qk.entries });
      void qc.invalidateQueries({ queryKey: qk.feeds });
    },
    onError: (e) => useUi.getState().notify(`全部已读失败：${errText(e)}`, 'error'),
  });
}

/* ============================ 频道 ============================ */

export function useCreateFeed() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: FeedCreateBody) => api.feeds.create(body),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: qk.feeds });
      void qc.invalidateQueries({ queryKey: qk.entries });
      /* 抓取器未接入（P5）：频道能建但还不会有条目，必须如实告诉用户，
       * 否则「加了频道却什么都没有」会被当成 bug。 */
      useUi.getState().notify(
        r.existed
          ? `这个地址已经在订阅列表里：${r.feed.title}`
          : `已添加「${r.feed.title || r.feed.url}」，等待首次抓取`,
      );
    },
    onError: (e) => useUi.getState().notify(`添加失败：${errText(e)}`, 'error'),
  });
}

export function usePatchFeed() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: FeedPatchBody }) => api.feeds.patch(id, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.feeds });
      // 卡片开关会改变条目列表的范围，必须一起失效
      void qc.invalidateQueries({ queryKey: qk.entries });
    },
    onError: (e) => {
      void qc.invalidateQueries({ queryKey: qk.feeds });
      useUi.getState().notify(`保存频道失败：${errText(e)}`, 'error');
    },
  });
}

export function useDeleteFeed() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.feeds.remove(id),
    onSuccess: (_r, id) => {
      // 删掉的正是当前选中的频道 → 回到「全部频道」，否则列表会停在已删除的范围上
      if (useUi.getState().feedId === id) useUi.getState().setFeedId(null);
      void qc.invalidateQueries({ queryKey: qk.feeds });
      void qc.invalidateQueries({ queryKey: qk.entries });
      useUi.getState().notify('频道已删除');
    },
    onError: (e) => useUi.getState().notify(`删除失败：${errText(e)}`, 'error'),
  });
}

/* ============================ 偏好 ============================ */

/**
 * 外观保存（主题 / 主色 / 字号 / 密度）。
 * 先落到 DOM（点击即见效果）再提交；失败时用服务端值覆盖回来，不留假象。
 */
export function useSaveAppearance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<Appearance>) => api.prefs.update({ appearance: patch }),
    onMutate: (patch) => {
      const cur = qc.getQueryData<Awaited<ReturnType<typeof api.prefs.get>>>(qk.prefs);
      if (cur) applyAppearance({ ...cur.appearance, ...patch });
      return { prev: cur?.appearance };
    },
    onSuccess: (r) => {
      applyAppearance(r.appearance);
      qc.setQueryData(qk.prefs, (old: Awaited<ReturnType<typeof api.prefs.get>> | undefined) =>
        old ? { ...old, appearance: r.appearance } : old,
      );
    },
    onError: (e, _p, ctx) => {
      if (ctx?.prev) applyAppearance(ctx.prev);
      void qc.invalidateQueries({ queryKey: qk.prefs });
      useUi.getState().notify(`外观保存失败：${errText(e)}`, 'error');
    },
  });
}

/** 其它偏好（布局 / 过滤 / 关注 / webhook / 日报 / 模型）。 */
export function useSavePrefs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: PrefsPatchBody) => api.prefs.update(patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.prefs });
      useUi.getState().notify('已保存');
    },
    onError: (e) => useUi.getState().notify(`保存失败：${errText(e)}`, 'error'),
  });
}
