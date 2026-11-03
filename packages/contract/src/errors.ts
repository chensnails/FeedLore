import { z } from 'zod';

/**
 * @feedlore/contract — API 错误码
 *
 * 错误响应固定为 `{ error, message?, status }`：
 * - `error`：稳定的机器可读码（本表中的值）。前端按码查自己的语言词典，码一旦发布不再改名。
 * - `message`：英文原文。没有对应码时（如上游异常透传）前端直接显示它。
 * - `status`：HTTP 状态码。
 *
 * 新增一条对外可见的错误时，先在这里登记，再补前端词典；两边都要有，否则界面会掉到英文。
 */
export const API_ERROR_CODES = [
  // ---- 就绪状态 ----
  'E_DB_NOT_READY',
  'E_SERVICE_NOT_READY',
  'E_AUTH_NOT_READY',
  'E_DB_URL_UNSET',

  // ---- 鉴权与权限 ----
  'E_UNAUTHORIZED',
  'E_ADMIN_ONLY',
  'E_READONLY_CONFIG',
  'E_READONLY_CREDENTIAL',
  'E_READONLY_RULES',
  'E_CSRF_ORIGIN_MISSING',
  'E_CSRF_UNTRUSTED_ORIGIN',
  'E_SIGNUP_DISABLED',
  'E_LOGIN_VIA_API',
  'E_RATE_LIMITED',
  'E_BAD_CREDENTIALS',

  // ---- 账号管理 ----
  'E_USERNAME_TAKEN',
  'E_USER_NOT_FOUND',
  'E_LAST_ADMIN',
  'E_CANNOT_DELETE_SELF',
  'E_PASSWORD_TOO_SHORT',
  'E_NEW_PASSWORD_TOO_SHORT',
  'E_CURRENT_PASSWORD_WRONG',
  'E_NOTHING_TO_UPDATE',
  'E_USER_CREATE_FAILED',
  'E_USER_NOT_PERSISTED',
  'E_PASSWORD_UPDATE_FAILED',

  // ---- 订阅源与条目 ----
  'E_FEED_NOT_FOUND',
  'E_FEED_CREATE_FAILED',
  'E_FEED_URL_DUPLICATE',
  'E_ENTRY_NOT_FOUND',
  'E_NO_FLAGS_TO_UPDATE',
  'E_EMPTY_OPML',
  'E_OPML_NO_FEEDS',
  'E_UNEXPECTED_OPML',

  // ---- 抓取与 URL ----
  'E_FETCH_FAILED',
  'E_FETCH_TIMEOUT',
  'E_FETCH_TOO_LARGE',
  'E_FETCH_NOT_FEED',
  'E_FETCH_HTTP_STATUS',
  'E_URL_INVALID',
  'E_URL_SCHEME_UNSUPPORTED',
  'E_URL_MISSING_HOST',
  'E_DNS_FAILED',
  'E_PRIVATE_HOST_BLOCKED',
  'E_TOO_MANY_REDIRECTS',
  'E_RSS_URL_INVALID',
  'E_RSS_URL_SCHEME_UNSUPPORTED',
  'E_RSS_URL_HOST_INVALID',

  // ---- 图片 ----
  'E_IMAGE_DATA_URI_REJECTED',
  'E_IMAGE_UPSTREAM_ERROR',
  'E_IMAGE_FETCH_FAILED',

  // ---- AI 与日报 ----
  'E_DATE_INVALID',
  'E_DIGEST_DISABLED',
  'E_MODEL_INCOMPLETE',
  'E_MODEL_URL_UNREACHABLE',

  // ---- Webhook 与更新通道 ----
  'E_WEBHOOK_URL_UNREACHABLE',
  'E_UPDATE_CHANNEL_UNSET',
  'E_UPDATE_CHANNEL_URL_BAD',
  'E_UPDATE_TRIGGER_FAILED',
  'E_UPDATE_NO_RELEASE',

  // ---- 通用请求错误 ----
  'E_NO_FIELDS_TO_SAVE',
  'E_BAD_REQUEST',
  'E_CONTRACT_VIOLATION',
  'E_ROUTE_NOT_FOUND',
  'E_INTERNAL',
] as const;

export const ApiErrorCodeSchema = z.enum(API_ERROR_CODES);

/** 错误码 → 英文默认文案；也是服务端调用 `apiError()` 时的参数表。 */
export const API_ERROR_DEFAULTS = {
  E_DB_NOT_READY: { status: 503, message: 'Database is not ready' },
  E_SERVICE_NOT_READY: { status: 503, message: 'Service is not ready' },
  E_AUTH_NOT_READY: { status: 503, message: 'Auth service is not ready' },
  E_DB_URL_UNSET: { status: 503, message: 'DATABASE_URL is not configured' },

  E_UNAUTHORIZED: { status: 401, message: 'Not signed in' },
  E_ADMIN_ONLY: { status: 403, message: 'Admin privileges required' },
  E_READONLY_CONFIG: {
    status: 403,
    message: 'Read-only accounts cannot change settings, ask an administrator',
  },
  E_READONLY_CREDENTIAL: {
    status: 403,
    message: 'Read-only accounts cannot change username or password, ask an administrator',
  },
  E_READONLY_RULES: {
    status: 403,
    message: 'Read-only accounts cannot change rules, models or digest settings',
  },
  E_CSRF_ORIGIN_MISSING: {
    status: 403,
    message: 'No valid Origin/Referer header, write request rejected',
  },
  E_CSRF_UNTRUSTED_ORIGIN: { status: 403, message: 'Untrusted origin, cross-site write rejected' },
  E_SIGNUP_DISABLED: { status: 403, message: 'Sign-up is disabled' },
  E_LOGIN_VIA_API: { status: 403, message: 'Sign in through /api/login' },
  E_RATE_LIMITED: { status: 429, message: 'Too many login attempts' },
  E_BAD_CREDENTIALS: { status: 401, message: 'Wrong username or password' },

  E_USERNAME_TAKEN: { status: 409, message: 'Username already exists' },
  E_USER_NOT_FOUND: { status: 404, message: 'User not found' },
  E_LAST_ADMIN: { status: 400, message: 'At least one administrator must remain' },
  E_CANNOT_DELETE_SELF: { status: 400, message: 'The signed-in account cannot be deleted' },
  E_PASSWORD_TOO_SHORT: { status: 400, message: 'Password must be at least 4 characters' },
  E_NEW_PASSWORD_TOO_SHORT: { status: 400, message: 'New password must be at least 4 characters' },
  E_CURRENT_PASSWORD_WRONG: { status: 400, message: 'Current password is incorrect' },
  E_NOTHING_TO_UPDATE: { status: 400, message: 'Provide a username or a new password' },
  E_USER_CREATE_FAILED: { status: 400, message: 'Failed to create the user' },
  E_USER_NOT_PERSISTED: { status: 500, message: 'Failed to create the user: it is not in the database' },
  E_PASSWORD_UPDATE_FAILED: { status: 400, message: 'Failed to change the password' },

  E_FEED_NOT_FOUND: { status: 404, message: 'Feed not found' },
  E_FEED_CREATE_FAILED: { status: 500, message: 'Failed to create the feed' },
  E_FEED_URL_DUPLICATE: { status: 409, message: 'This URL is already one of your feeds' },
  E_ENTRY_NOT_FOUND: { status: 404, message: 'Entry not found' },
  E_NO_FLAGS_TO_UPDATE: { status: 400, message: 'Nothing to change: set isRead or isFavorite' },
  E_EMPTY_OPML: { status: 400, message: 'No OPML content received' },
  E_OPML_NO_FEEDS: { status: 400, message: 'The OPML file contains no feed URLs' },
  E_UNEXPECTED_OPML: { status: 400, message: 'The file does not look like OPML' },

  E_FETCH_FAILED: { status: 502, message: 'Fetch failed' },
  E_FETCH_TIMEOUT: { status: 504, message: 'Fetch timed out' },
  E_FETCH_TOO_LARGE: { status: 502, message: 'Response body is too large' },
  E_FETCH_NOT_FEED: { status: 422, message: 'Not recognizable RSS / Atom content' },
  E_FETCH_HTTP_STATUS: { status: 502, message: 'The site returned an error status' },
  E_URL_INVALID: { status: 400, message: 'Invalid address' },
  E_URL_SCHEME_UNSUPPORTED: { status: 400, message: 'Only http:// and https:// addresses are supported' },
  E_URL_MISSING_HOST: { status: 400, message: 'The address has no hostname' },
  E_DNS_FAILED: { status: 400, message: 'DNS lookup failed, check the address spelling' },
  E_PRIVATE_HOST_BLOCKED: {
    status: 400,
    message: 'Private or loopback addresses are not allowed (set ALLOW_PRIVATE_HOSTS=1 on the server to allow them)',
  },
  E_TOO_MANY_REDIRECTS: { status: 502, message: 'Too many redirects' },
  E_RSS_URL_INVALID: { status: 400, message: 'Invalid RSS address' },
  E_RSS_URL_SCHEME_UNSUPPORTED: {
    status: 400,
    message: 'The RSS address must start with http:// or https://',
  },
  E_RSS_URL_HOST_INVALID: { status: 400, message: 'The RSS address host name looks invalid' },

  E_IMAGE_DATA_URI_REJECTED: { status: 400, message: 'data: URLs do not need the image proxy' },
  E_IMAGE_UPSTREAM_ERROR: { status: 502, message: 'The image source returned an error' },
  E_IMAGE_FETCH_FAILED: { status: 502, message: 'Failed to fetch the image' },

  E_DATE_INVALID: { status: 400, message: 'Invalid date, expected a real YYYY-MM-DD' },
  E_DIGEST_DISABLED: {
    status: 400,
    message: 'Digest is turned off for this account, re-enable it in Settings - Digest',
  },
  E_MODEL_INCOMPLETE: {
    status: 400,
    message: 'Model is not configured: base URL, API key and model name are all required',
  },
  E_MODEL_URL_UNREACHABLE: { status: 400, message: 'Model base URL is not reachable' },

  E_WEBHOOK_URL_UNREACHABLE: { status: 400, message: 'Webhook URL is not reachable' },
  E_UPDATE_CHANNEL_UNSET: {
    status: 501,
    message: 'No update channel configured (UPDATE_WEBHOOK_URL / UPDATE_WEBHOOK_TOKEN)',
  },
  E_UPDATE_CHANNEL_URL_BAD: { status: 400, message: 'The update channel URL has an invalid scheme' },
  E_UPDATE_TRIGGER_FAILED: { status: 502, message: 'Failed to trigger the update' },
  E_UPDATE_NO_RELEASE: { status: 502, message: 'No releases published on GitHub yet' },

  E_NO_FIELDS_TO_SAVE: { status: 400, message: 'No field to save' },
  E_BAD_REQUEST: { status: 400, message: 'Malformed request' },
  E_CONTRACT_VIOLATION: { status: 500, message: 'Response does not match the API contract' },
  E_ROUTE_NOT_FOUND: { status: 404, message: 'Endpoint not found' },
  E_INTERNAL: { status: 500, message: 'Internal server error' },
} as const satisfies Record<ApiErrorCode, { status: number; message: string }>;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** 词典插值参数：文案里需要数字/名称的错误码通过它结构化下发。 */
export type ApiErrorParams = Record<string, string | number>;

