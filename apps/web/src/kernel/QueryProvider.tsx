/* Query 的 React 装配层：把 queryClient 单例注入组件树。
 *
 * 生产：main.tsx 用它包住根组件；测试：各 mount 入口也用它包住被测组件，
 * 于是组件可以真用 useQuery/useMutation，而 queryFn 内部走 core.apiFetch —— 测试桩
 * 替换这个 I/O 端口（@core 别名 → stub-core），行为断言完全不受影响。
 *
 * 这是标准的「端口 + 适配器」结构：Query 管缓存/去重/失效（应用层），
 * core.apiFetch 是网络端口，桩是测试适配器。不是挂名门面。 */
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { queryClient } from './query.ts';

export function QueryProvider({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
