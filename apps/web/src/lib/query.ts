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

export const qk = {
  session: ['session'] as const,
  feeds: ['feeds'] as const,
};
