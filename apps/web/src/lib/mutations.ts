import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  AccountBody,
  Appearance,
  ConfigPatchBody,
  EntriesListResponse,
  EntryDetail,
  FeedCreateBody,
  FeedPatchBody,
  LlmConfig,
  PrefsPatchBody,
  ReadAllBody,
  UserCreateBody,
  UserPatchBody,
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

/**
 * 按当前关注/屏蔽规则**重算历史条目**。
 *
 * 为什么需要它：规则只在抓取时对新条目生效（`fetcher` 里打标）。用户改完规则
 * 回头看列表，旧条目还是老样子，会以为规则没保存。legacy 有这个按钮，切到 v2 不能丢。
 *
 * 服务端用的是**同一个 classify()**，所以「重算结果」和「新条目打标」不会分叉。
 */
export function useApplyWatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.entries.applyWatch(),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: qk.entries });
      useUi
        .getState()
        .notify(`已重算历史条目：关注 ${r.watching} 条 · 屏蔽 ${r.blocked} 条（清除旧标记 ${r.cleared} 条）`);
    },
    onError: (e) => useUi.getState().notify(`重算失败：${errText(e)}`, 'error'),
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

      /* P5 起新增频道会**立即抓一次**，所以 added 是真的。
       * 三种结果要分开说：本来就有 / 抓到了 / 加了但源站报错——
       * 最后一种最容易让人误会（频道出现了却没内容），必须把源站的原因说出来。 */
      if (r.existed) {
        useUi.getState().notify(`这个地址已经在订阅列表里：${r.feed.title}`);
      } else if (r.feed.status === 'error') {
        useUi.getState().notify(`已添加，但源站报错：${r.feed.error ?? '未知错误'}`, 'error');
      } else if (r.added > 0) {
        useUi.getState().notify(`已添加「${r.feed.title || r.feed.url}」，抓取 ${r.added} 条`);
      } else {
        useUi.getState().notify(`已添加「${r.feed.title || r.feed.url}」，源站暂无新内容`);
      }
    },
    onError: (e) => useUi.getState().notify(`添加失败：${errText(e)}`, 'error'),
  });
}

/**
 * OPML 批量导入。
 *
 * 与单条添加的区别：一次可能来几十个频道，逐个通知会把 toast 刷屏，所以只报三个数字
 * （新增 / 已存在 / 跳过）和分组名。新导入的频道由服务端排队抓取，本请求**不等**抓取结果 ——
 * 这点必须说出来，否则用户看到「导入成功」却发现列表是空的会以为失败。
 */
export function useImportOpml() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (opml: string) => api.feeds.importOpml(opml),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: qk.feeds });
      void qc.invalidateQueries({ queryKey: qk.entries });
      const parts = [`新增 ${r.added} 个`];
      if (r.duplicated) parts.push(`已存在 ${r.duplicated} 个`);
      if (r.skipped) parts.push(`跳过 ${r.skipped} 个`);
      if (r.groups.length) parts.push(`分组：${r.groups.slice(0, 3).join('/')}${r.groups.length > 3 ? '…' : ''}`);
      useUi
        .getState()
        .notify(`导入完成：${parts.join('，')}（内容在后台陆续抓取）`, r.added ? 'ok' : 'error');
    },
    onError: (e) => useUi.getState().notify(`导入失败：${errText(e)}`, 'error'),
  });
}

/** 刷新全部开启采集的频道。会真的回源，可能耗时几十秒。 */
export function useRefreshAll() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.feeds.refreshAll(),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: qk.feeds });
      void qc.invalidateQueries({ queryKey: qk.entries });
      const parts = [`新增 ${r.added} 条`];
      if (r.filtered) parts.push(`过滤 ${r.filtered} 条`);
      if (r.failed.length) parts.push(`${r.failed.length} 个源失败`);
      if (r.autoDisabled) parts.push(`${r.autoDisabled} 个已自动停用`);
      useUi
        .getState()
        .notify(`刷新完成：${parts.join('，')}`, r.failed.length ? 'error' : 'ok');
    },
    onError: (e) => useUi.getState().notify(`刷新失败：${errText(e)}`, 'error'),
  });
}

/** 刷新单个频道（源站报错时 HTTP 仍 200，靠 ok/result.error 判断）。 */
export function useRefreshFeed() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.feeds.refreshOne(id),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: qk.feeds });
      void qc.invalidateQueries({ queryKey: qk.entries });
      const name = r.feed.title || r.feed.url;
      if (!r.ok) {
        useUi.getState().notify(`「${name}」抓取失败：${r.result.error ?? '未知错误'}`, 'error');
      } else if (r.result.added) {
        useUi.getState().notify(`「${name}」新增 ${r.result.added} 条`);
      } else {
        useUi.getState().notify(`「${name}」没有新内容`);
      }
    },
    onError: (e) => useUi.getState().notify(`刷新失败：${errText(e)}`, 'error'),
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

/* ============================ 管理端 ============================ */

/**
 * 保存采集参数。
 * 服务端会把越界值**夹回区间**而不是报错，所以保存成功后要用服务端返回值刷新界面，
 * 否则界面还显示着用户刚敲的 9999，让人以为真的存进去了。
 */
export function useSaveSourceConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (source: ConfigPatchBody['source']) => api.admin.saveConfig({ source }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.adminConfig });
      void qc.invalidateQueries({ queryKey: qk.adminStatus });
      void qc.invalidateQueries({ queryKey: qk.feeds });
      useUi.getState().notify('采集参数已保存（越界值会自动夹回合法区间）');
    },
    onError: (e) => useUi.getState().notify(`保存失败：${errText(e)}`, 'error'),
  });
}

export function useCreateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UserCreateBody) => api.admin.users.create(body),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: qk.adminUsers });
      void qc.invalidateQueries({ queryKey: qk.adminStatus });
      useUi.getState().notify(`已创建用户「${r.user.username}」`);
    },
    onError: (e) => useUi.getState().notify(`创建失败：${errText(e)}`, 'error'),
  });
}

/**
 * 改角色 / 重置密码。
 * ⚠️ 重置密码会**把该用户踢下线**吗：不会。better-auth 只换哈希，
 * 已有会话继续有效（要踢人得删用户或手动清 sessions）。
 */
export function usePatchUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UserPatchBody }) => api.admin.users.patch(id, body),
    onSuccess: (r, { body }) => {
      void qc.invalidateQueries({ queryKey: qk.adminUsers });
      useUi.getState().notify(body.password ? `已重置「${r.user.username}」的密码` : `「${r.user.username}」已设为${r.user.role === 'admin' ? '管理员' : '普通用户'}`);
    },
    onError: (e) => useUi.getState().notify(`修改失败：${errText(e)}`, 'error'),
  });
}

export function useDeleteUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.admin.users.remove(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.adminUsers });
      void qc.invalidateQueries({ queryKey: qk.adminStatus });
      useUi.getState().notify('用户及其订阅已删除');
    },
    onError: (e) => useUi.getState().notify(`删除失败：${errText(e)}`, 'error'),
  });
}

export function useClearImageCache() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.admin.clearImageCache(),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: qk.adminImageCache });
      void qc.invalidateQueries({ queryKey: qk.adminStatus });
      useUi.getState().notify(`已清空图片缓存 ${r.removed} 条`);
    },
    onError: (e) => useUi.getState().notify(`清空失败：${errText(e)}`, 'error'),
  });
}

/** 改自己的密码 / 用户名。成功后用户名可能变了，会话信息要重取。 */
export function useSaveAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AccountBody) => api.account(body),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: qk.session });
      useUi.getState().notify(`已更新账号：${r.username}`);
    },
    onError: (e) => useUi.getState().notify(`更新失败：${errText(e)}`, 'error'),
  });
}

/* ============================ 日报 ============================ */

/**
 * 生成日报。
 *
 * ⚠️ 这是个**慢**操作（模型单轮可能几十秒，走 map-reduce 时按批数累加），
 * 所以界面必须在 pending 期间明确显示「正在生成」，并禁用重复点击 ——
 * 否则用户会以为没反应，连点三次就是把额度烧三遍。
 */
export function useGenerateDigest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { date?: string; force?: boolean } = {}) => api.ai.generate(body),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: qk.digestDates });
      void qc.invalidateQueries({ queryKey: qk.digest });
      const d = r.digest;
      if (d.fallback) {
        // 降级不是成功：用户需要知道「这份是规则摘要，不是模型写的」
        useUi.getState().notify(`已生成规则摘要（${d.stats.kept}/${d.stats.collected} 条）：${d.error ?? '模型不可用'}`, 'error');
      } else {
        useUi.getState().notify(`日报已生成：${d.stats.kept}/${d.stats.collected} 条，${d.stats.feeds} 个频道`);
      }
    },
    onError: (e) => useUi.getState().notify(`生成失败：${errText(e)}`, 'error'),
  });
}

/**
 * 测试模型连通性。
 *
 * 注意接口**失败也返回 200**（`ok:false`），所以这里不能靠 onError 报错，
 * 要在 onSuccess 里看 `ok` —— 否则「Key 错了」会被静默当成成功。
 */
export function useTestLlm() {
  return useMutation({
    mutationFn: (llm: LlmConfig) => api.ai.testLlm(llm),
    onSuccess: (r) => {
      if (r.ok) useUi.getState().notify(`模型连接正常：${r.reply ?? 'OK'}`);
      else useUi.getState().notify(`模型不可用：${r.error ?? '未知原因'}`, 'error');
    },
    onError: (e) => useUi.getState().notify(`测试失败：${errText(e)}`, 'error'),
  });
}
