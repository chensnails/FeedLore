/* 服务端状态引擎（V4.2 / TanStack Query）。
 *
 * 背景：core 层历史上用「命令式 apiFetch → 手写 loading/error 标志 → 派发 tick」
 * 管理服务端数据，缓存、去重、失效、竞态全部自研。这里引入 TanStack Query 作为
 * 唯一的服务端状态真源：GET 走 queryClient.fetchQuery（带 key 去重与 stale 缓存），
 * 变更后 invalidate 相关 key，让下一次读取自动刷新。
 *
 * 关键约束（渐进绞杀的兼容面）：
 *  - core 对外的方法签名与 state 写入语义不变 —— 组件、测试桩照旧调用 core.loadFeeds()；
 *  - queryFn 内部仍走 core/util.ts#apiFetch，保留弱网超时 / 幂等重试 / 401 处理；
 *  - 因此 UI 行为测试用的桩 core 完全隔离，本模块只在真实 core 加载时被求值。
 *
 * 配置取向：RSS 阅读器的列表数据「读多写少 + 写后立刻想看到」，故
 *  - staleTime 很短（30s）：切视图回来可接受一次后台刷新；
 *  - retry 交给 apiFetch（它已按 GET/写分别处理），Query 层不再叠加；
 *  - refetchOnWindowFocus 关掉：避免标签页切回时悄悄重拉一整页条目。
 */
import { QueryClient } from '@tanstack/react-query';

/** 全局单例：core 数据层与组件层共享同一份缓存与失效通道。 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      retry: false, // 弱网重试在 apiFetch 内做，避免两层指数退避叠加
      refetchOnWindowFocus: false,
    },
    mutations: { retry: false },
  },
});

/** query key 工厂：集中登记，避免各处散写字符串导致失效漏网。 */
export const qk = Object.freeze({
  session: ['session'] as const,
  feeds: ['feeds'] as const,
  entries: (scope: any, extra: any) => ['entries', scope, extra] as const,
  readerBody: (id: any) => ['readerBody', String(id)] as const,
  status: ['status'] as const,
  config: ['config'] as const,
});

/** 失效一组 key（写操作后调用）。保留 core 的 tick 机制，Query 只补缓存一致性。 */
export function invalidate(...keys: ReadonlyArray<readonly any[]>) {
  return Promise.all(keys.map((k) => queryClient.invalidateQueries({ queryKey: k as any })));
}

/**
 * 写后立即重新取数：清掉缓存再让调用方重新 fetchQuery。
 * 与 invalidate 的区别：invalidate 只标脏（fetchQuery 仍先返回旧值再后台刷新），
 * 而订阅源增删改后 UI 必须立刻反映新状态，不能先闪一帧旧数据。
 */
export function drop(...keys: ReadonlyArray<readonly any[]>) {
  return Promise.all(keys.map((k) => queryClient.removeQueries({ queryKey: k as any })));
}

/** 读缓存快照（同步），供需要「先旧后新」渲染的地方取数。 */
export function peek<T = any>(key: readonly any[]): T | undefined {
  return queryClient.getQueryData<T>(key as any);
}

/**
 * 受 Query 管理的 GET：queryFn 返回解析后的数据（不是 Response —— Response 的 body
 * 只能消费一次，缓存它会在并发命中时抛 "body stream already read"）。
 *
 * 调用方的 state 写入逻辑保持逐字不变：这里只替换「发请求 + 判 ok + 解析 json」这一段，
 * 返回结构与各 load* 函数原本拿到的 data 一致。去重 / stale / 失效由 Query 负责，
 * 弱网超时与幂等重试仍在 apiFetch 内（queryFn 里照常调用它）。
 * @param {*} key
 * @param {*} loader  返回已解析数据的异步函数
 */
export function cachedGet(key: readonly any[], loader: () => Promise<any>): Promise<any> {
  return queryClient.fetchQuery({ queryKey: key as any, queryFn: loader }).then(clone);
}

/** 返回副本：core 的 state.feedList / feedMeta 会被组件原地修改，
 * 若直接把 Query 缓存里的对象交出去，原地写会污染缓存，下一次命中就是脏数据。 */
function clone(v: any): any {
  if (v == null || typeof v !== 'object') return v;
  try {
    return typeof structuredClone === 'function'
      ? structuredClone(v)
      : JSON.parse(JSON.stringify(v));
  } catch (_) {
    return v;
  }
}
