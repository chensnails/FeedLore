import { createApiClient } from '@feedlore/client';

/**
 * 单例客户端。baseUrl 取当前源：开发态由 vite 代理 /api → 3000，
 * 生产态由 Hono 同源托管，两种情况都不需要改代码，也不需要 CORS。
 */
export const api = createApiClient(window.location.origin, {
  credentials: 'same-origin',
});

export { ApiError, ContractError } from '@feedlore/client';
