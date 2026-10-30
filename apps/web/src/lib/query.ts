import { QueryClient } from '@tanstack/react-query';
import type { EntriesList } from './types';
import type { EntryCard } from './types';
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

/** 无限滚动的缓存形状。写在这里是为了让「谁在读缓存」都从这个函数过一遍。 */
export interface EntriesPages {
  pages: EntriesList[];
  pageParams: unknown[];
}

/**
 * 把缓存里的条目拍平成一维数组。
 *
 * 列表改成无限滚动后，缓存里存的是 `{ pages: [...] }`，但「上一条/下一条」、
 * 自动刷新、「本页未读」这些逻辑都只关心「用户看到的连续序列」。让它们各自
 * 记住 cache 长什么样，改一次分页策略就要改四处 —— 所以统一走这里。
 */
export function flattenEntries(data: EntriesList | EntriesPages | undefined): EntryCard[] {
  if (!data) return [];
  if ('pages' in data) return data.pages.flatMap((p) => p.entries);
  return data.entries;
}

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
