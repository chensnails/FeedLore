/**
 * API 错误：把「稳定错误码 + 英文说明」组装成统一响应体。
 *
 * 约定（见 packages/contract/src/errors.ts）：
 * - 响应里的 `error` 是错误码，界面文案由前端词典负责；
 * - `message` 永远是英文，供日志与排查；
 * - 需要插值的数字/名称走 `params`，不要让前端去解析文案。
 */

import { HTTPException } from 'hono/http-exception';
import type { Context, Env } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  API_ERROR_CODES,
  API_ERROR_DEFAULTS,
  type ApiErrorCode,
  type ApiErrorParams,
} from '@feedlore/contract';

export interface ApiErrorInit {
  /** 覆盖默认英文说明（例如把上游异常原文带出来）。 */
  message?: string;
  /** 追加在英文说明后面、并同时下发给前端插值的补充信息（上游异常原文、冲突频道名等）。 */
  detail?: string | number;
  /** 覆盖默认状态码。 */
  status?: number;
  params?: ApiErrorParams;
}

export function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === 'string' && (API_ERROR_CODES as readonly string[]).includes(value);
}

export type ApiErrorResponseBody = {
  error: string;
  message: string;
  status: number;
  params?: ApiErrorParams;
};

export function apiErrorBody(code: ApiErrorCode, init: ApiErrorInit = {}): ApiErrorResponseBody {
  const defaults = API_ERROR_DEFAULTS[code];
  const detail = init.detail === undefined ? undefined : String(init.detail);
  const message =
    init.message ?? (detail ? `${defaults.message}: ${detail}` : defaults.message);
  const body: ApiErrorResponseBody = {
    error: code as string,
    message,
    status: init.status ?? defaults.status,
  };
  if (detail !== undefined || init.params) {
    body.params = { ...(detail === undefined ? undefined : { detail }), ...init.params };
  }
  return body;
}

/** 直接返回响应：`return apiError(c, 'E_FEED_NOT_FOUND')`。 */
export function apiError<E extends Env>(c: Context<E>, code: ApiErrorCode, init: ApiErrorInit = {}) {
  const body = apiErrorBody(code, init);
  return c.json(body, body.status as ContentfulStatusCode);
}

/** 抛出后由 `app.ts` 的 onError 序列化成同一个形状。 */
export class ApiException extends HTTPException {
  readonly code: ApiErrorCode;
  readonly apiParams?: ApiErrorParams;

  constructor(code: ApiErrorCode, init: ApiErrorInit = {}) {
    const body = apiErrorBody(code, init);
    super(body.status as ContentfulStatusCode, { message: body.message });
    this.name = 'ApiException';
    this.code = code;
    this.apiParams = body.params;
  }
}

/**
 * 落库 / 透传给界面的错误标识：有码就存 `E_CODE`（带补充信息时 `E_CODE:补充信息`），
 * 没码就存英文原文。前端 `src/core/errorText.js` 认得出码就出中文，认不出原样显示。
 */
export function apiErrorKey(err: unknown, maxLen = 300): string {
  const e = err as { code?: unknown; apiParams?: unknown; detail?: unknown; message?: unknown };
  if (!isApiErrorCode(e?.code)) {
    return String((e?.message ?? err) as unknown).slice(0, maxLen);
  }
  const params = e.apiParams as { detail?: unknown } | undefined;
  const raw = params?.detail === undefined || params?.detail === null ? e.detail : params.detail;
  const detail = raw === undefined || raw === null ? '' : String(raw);
  return `${e.code}${detail ? `:${detail}` : ''}`;
}

