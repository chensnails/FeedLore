import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { EntriesListQuery } from '@feedlore/client';
import { api } from './api';

/**
 * 页面自动刷新（对齐 v1 的 `core/autorefresh.js`）。
 *
 * 为什么不能直接给列表 query 挂 `refetchInterval`：
 * 那样到点就把新数据**套用**到界面上，用户正在读第十条，列表在他眼皮底下整体位移 ——
 * v1 为此专门做过「N 条新内容」浮标，就是解决这一件事。
 *
 * 所以这里的流程是「先探测、再决定」：
 * 1. 到点调一次 `api.entries.list()`，**不写缓存**（直接调 api，不经过 queryClient）→
 *    数据只在内存里比一下，界面完全不动；
 * 2. 用户停在顶部（本来就在等新内容）→ 直接 invalidate，等效于刷新；
 * 3. 已经滚下去了 → 只挂一个浮标，点它才套用。
 *
 * 三个容易被漏掉的行为（都在 v1 里验证过）：
 * - **收藏视图跳过**：新条目默认都不是收藏，探测必然返回 0 条，纯属浪费一次请求；
 * - **搜索态跳过**：搜索是「我在找特定的东西」，此时冒出一条「N 条新内容」只会打断；
 * - **回到前台补一次**：手机锁屏 / 切标签页期间定时器会被节流甚至停摆，
 *   不补的话「早上打开电脑，列表还是昨晚的」。
 */
export interface FreshHint {
  n: number;
}

export function useAutoRefresh({
  query,
  queryKey,
  minutes,
  headIds,
  skip = false,
  onApply,
}: {
  query: EntriesListQuery;
  /** 当前列表的 queryKey。切换条件后浮标要清掉 —— 它对应的是上一批结果 */
  queryKey: readonly unknown[];
  /** 服务端 `settings.source.autoRefreshMinutes`，0 = 关闭 */
  minutes: number;
  /** 当前首屏条目的 id（用来判断「多出来的」是哪几条） */
  headIds: string[];
  skip?: boolean;
  onApply?: () => void;
}): { fresh: FreshHint | null; apply: () => void; dismiss: () => void } {
  const qc = useQueryClient();
  const [fresh, setFresh] = useState<FreshHint | null>(null);

  /* 全部用 ref 保存：定时器闭包活在很久以前的那一帧里，直接读 props 会拿到旧的查询条件
   * （用户在 15 分钟里换了三次频道，回调还在探第一个频道）。 */
  const queryRef = useRef(query);
  queryRef.current = query;
  const headRef = useRef(headIds);
  headRef.current = headIds;
  const keyRef = useRef(queryKey);
  keyRef.current = queryKey;
  const busyRef = useRef(false);
  const lastAtRef = useRef(0);

  const keySig = JSON.stringify(queryKey);

  // 换条件（频道/筛选/排序/搜索）后旧的浮标必须消失
  useEffect(() => {
    setFresh(null);
  }, [keySig]);

  const probe = useCallback(async (): Promise<void> => {
    if (busyRef.current) return; // 上一轮还没回来（慢网 + 短间隔），别叠加
    busyRef.current = true;
    try {
      const next = await api.entries.list(queryRef.current);
      const head = next.entries.slice(0, 30);
      if (!head.length) return;

      const known = new Set(headRef.current);
      // 从新数据头部开始数「连续不在旧头部里」的条数 = 真正新增的数量
      let n = 0;
      for (const e of head) {
        if (known.has(e.id)) break;
        n += 1;
      }
      if (!n) return;

      const list = document.querySelector('.list');
      const atTop = !list || list.scrollTop < 40;
      if (atTop) {
        /* 在顶部：列表本来就要从第一条开始重画，直接套用不会打断任何阅读位置。
         * 这里**不弹浮标**——多一次点击才能看到新内容，纯属添乱。 */
        await qc.invalidateQueries({ queryKey: keyRef.current });
      } else {
        setFresh({ n });
      }
    } catch {
      // 探测失败静默：源站/网络抖一下不该弹错误提示，下一轮会再试
    } finally {
      busyRef.current = false;
    }
  }, [qc]);

  useEffect(() => {
    const mins = Math.max(0, minutes);
    if (!mins || skip) return;
    const ms = mins * 60_000;
    const id = window.setInterval(() => {
      // 后台标签页不做无用功（浏览器已经会节流，这里只是省掉一次请求）
      if (document.visibilityState === 'hidden') return;
      lastAtRef.current = Date.now();
      void probe();
    }, ms);
    return () => window.clearInterval(id);
  }, [minutes, skip, probe]);

  useEffect(() => {
    const mins = Math.max(0, minutes);
    if (!mins || skip) return;
    const onVis = (): void => {
      if (document.visibilityState !== 'visible') return;
      /* 只有「离开够久」才补：频繁切标签页时每次都拉一次，等于把间隔配置架空 */
      if (Date.now() - lastAtRef.current < mins * 60_000) return;
      lastAtRef.current = Date.now();
      void probe();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [minutes, skip, probe]);

  const apply = useCallback((): void => {
    setFresh(null);
    void qc.invalidateQueries({ queryKey: keyRef.current });
    document.querySelector('.list')?.scrollTo({ top: 0, behavior: 'smooth' });
    onApply?.();
  }, [qc, onApply]);

  const dismiss = useCallback((): void => setFresh(null), []);

  return { fresh, apply, dismiss };
}
