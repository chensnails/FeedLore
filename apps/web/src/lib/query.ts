import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api';

/**
 * 服务端状态统一走 TanStack Query（缓存/去重/失效/重试），
 * **不要**再像 v1.x 那样把接口数据塞进全局可变 state —— 那正是
 * 「视图读到过期/不存在字段」类 bug 的温床。
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      // 4xx 是「你请求错了/没权限」，重试没有意义，只会拖慢错误暴露。
      retry: (count, err) => (err instanceof ApiError && err.status < 500 ? false : count < 2),
    },
    mutations: { retry: false },
  },
});

/** 查询键集中登记：散在组件里的字符串键迟早写错一个字母，然后那块缓存就再也不失效。 */
export const qk = {
  session: ['session'] as const,
  feeds: ['feeds'] as const,
  entries: ['entries'] as const,
  entry: ['entry'] as const,
  prefs: ['prefs'] as const,
  /** 管理端：以 `admin` 为前缀，权限变化时可一次全清。 */
  adminStatus: ['admin', 'status'] as const,
  adminConfig: ['admin', 'config'] as const,
  adminUsers: ['admin', 'users'] as const,
  adminImageCache: ['admin', 'image-cache'] as const,
  adminVersion: ['admin', 'version'] as const,
  /** 日报：日期列表与单日内容分开缓存（切日期不该重拉列表）。 */
  digestDates: ['digest', 'dates'] as const,
  digest: ['digest', 'one'] as const,
};
