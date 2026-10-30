/**
 * @feedlore/client —— 前后端共用的类型化 API 客户端（P4+）。
 *
 * 两层保障，各管一件事，不要混为一谈：
 *
 * 1) **编译期（hc < AppType>）**：路径、方法、路径参数、请求体字段由服务端路由类型推导。
 *    改了 `/api/feeds` 或把它挪走、把 GET 改成 POST，前端在这里直接 `tsc` 报错——
 *    这正是 v1.x「字符串 URL + 全局 state」时代最贵的一类 bug（拼错路径、调错方法、
 *    字段名对不上，都要等线上白屏才发现）。
 * 2) **运行期（contract 的 Zod）**：服务端虽已用 `assertResponse` 兜底，客户端仍再解一次。
 *    理由是部署可能版本错配（前端新、后端旧），此时宁可抛 `ContractError` 并指明字段，
 *    也不要把 `undefined` 塞进 UI 让它在别处炸。
 *
 * 用法：
 * ```ts
 * const api = createApiClient('https://feedlore.example.com');
 * await api.login({ username, password });
 * const { feeds, flags } = await api.feeds.list();
 * ```
 */

import { hc } from 'hono/client';
import type { AppType } from '@feedlore/server';
import type { z } from 'zod';
import {
  HealthSchema,
  SessionSchema,
  OkSchema,
  admin as adminEndpoints,
  auth as authEndpoints,
  entries as entriesEndpoints,
  feeds as feedsEndpoints,
  prefs as prefsEndpoints,
  entriesListResponse,
  EntryDetailSchema,
  EntryFlagsSchema,
  feedsListResponse,
  prefsResponse,
  type AccountBody,
  type AdminUser,
  type ConfigGetResponse,
  type ConfigPatchBody,
  type EntryDetail,
  type EntryFlags,
  type EntriesListResponse,
  type EntryFlagPatchBody,
  type FeedPatchBody,
  type FeedCreateBody,
  type FeedReorderBody,
  type Health,
  type LoginBody,
  type PrefsPatchBody,
  type PrefsResponse,
  type ReadAllBody,
  type Session,
  type FeedsListResponse,
  type DigestGenerateBody,
  type LlmConfig,
  ai as aiEndpoints,
  type UserCreateBody,
  type UserPatchBody,
  type VersionCheck,
  type VersionInfo,
} from '@feedlore/contract';

/**
 * 列表查询参数的类型**直接取自 hc**，而不是手抄：
 * 服务端 `zValidator('query', entriesQuery)` 的输入形态经 Hono 的 ValidationTargets
 * 与 HTTP 查询串（只有字符串）交叉后才是客户端真正该传的类型。
 * 手写一份必然漂移（`z.coerce.number()` 的 z.input 是 unknown，抄过来对不上）。
 */
type HcClient = ReturnType<typeof hc<AppType>>;
export type EntriesListQuery = NonNullable<Parameters<HcClient['api']['entries']['$get']>[0]>['query'];

/* ============================ 错误类型 ============================ */

/** HTTP 层失败（4xx/5xx）。`body` 保留原始响应，便于页面展示服务端文案。 */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, message: string, body: unknown = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/** 响应能拿到，但结构不符合契约（通常是前后端版本错配）。 */
export class ContractError extends Error {
  readonly issues: unknown;
  constructor(what: string, issues: unknown) {
    super(`响应不符合契约：${what}`);
    this.name = 'ContractError';
    this.issues = issues;
  }
}

/* ============================ 内部工具 ============================ */

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function messageOf(body: unknown, fallback: string): string {
  if (body && typeof body === 'object' && 'error' in body) {
    const m = (body as { error?: unknown }).error;
    if (typeof m === 'string' && m) return m;
  }
  return fallback;
}

/** 统一出口：非 2xx 抛 ApiError，结构不符抛 ContractError，否则返回契约类型。 */
async function unwrap<S extends z.ZodType>(
  res: Response,
  schema: S,
  what: string,
): Promise<z.infer<S>> {
  const body = await readBody(res);
  if (!res.ok) {
    throw new ApiError(res.status, messageOf(body, `${what} 失败（HTTP ${res.status}）`), body);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ContractError(what, parsed.error.issues);
  return parsed.data as z.infer<S>;
}

/* ============================ 选项 ============================ */

export interface ApiClientOptions {
  /** 自定义 fetch（Node 下传 createCookieJarFetch()，测试时可传桩）。 */
  fetch?: typeof fetch;
  /** 额外请求头，或返回请求头的函数（便于每次取最新 token）。 */
  headers?: Record<string, string> | (() => Record<string, string>);
  /** 浏览器端默认 same-origin 会带 Cookie；跨域部署时传 'include'。 */
  credentials?: RequestCredentials;
}

/* ============================ 客户端 ============================ */

export function createApiClient(baseUrl: string, options: ApiClientOptions = {}) {
  // 显式标注返回类型：否则 `options.headers ?? {}` 会让 TS 推成「联合类型」，
  // 与 hc 期望的「函数或对象」不兼容。
  const rawHeaders = options.headers;
  const headers: () => Record<string, string> =
    typeof rawHeaders === 'function' ? rawHeaders : () => rawHeaders ?? {};

  const raw = hc<AppType>(baseUrl, {
    ...(options.fetch ? { fetch: options.fetch as typeof fetch } : {}),
    headers,
    init: { credentials: options.credentials ?? 'same-origin' },
  });

  return {
    /** 逃生口：契约已声明但本客户端尚未封装端点的，可走 `raw.api.xxx.$get()`。 */
    raw,
    baseUrl,

    /* ---------------- 鉴权 / 会话 ---------------- */

    /** 探活。db 未就绪时服务端返回 503，这里不抛错，由调用方读 db.ready。 */
    async health(): Promise<Health> {
      const res = await raw.api.health.$get();
      return unwrap(res, HealthSchema, 'GET /api/health');
    },

    async session(): Promise<Session> {
      const res = await raw.api.session.$get();
      return unwrap(res, SessionSchema, 'GET /api/session');
    },

    async login(body: LoginBody): Promise<z.infer<typeof authEndpoints.login.response>> {
      const res = await raw.api.login.$post({ json: body });
      return unwrap(res, authEndpoints.login.response, 'POST /api/login');
    },

    async logout(): Promise<{ ok: boolean }> {
      const res = await raw.api.logout.$post();
      return unwrap(res, authEndpoints.logout.response, 'POST /api/logout');
    },

    /* ---------------- 频道 ---------------- */

    feeds: {
      async list(): Promise<FeedsListResponse> {
        const res = await raw.api.feeds.$get();
        return unwrap(res, feedsListResponse, 'GET /api/feeds');
      },

      /** 新增订阅。地址会先过服务端的归一化与出网校验（内网地址直接 400）。 */
      async create(body: FeedCreateBody) {
        const res = await raw.api.feeds.$post({ json: body });
        return unwrap(res, feedsEndpoints.create.response, 'POST /api/feeds');
      },

      /** 改开关 / 分组 / 名称 / 频率 / 地址；地址撞车返回 409。 */
      async patch(id: string | number, body: FeedPatchBody) {
        const res = await raw.api.feeds[':id'].$patch({ param: { id: String(id) }, json: body });
        return unwrap(res, feedsEndpoints.patchOne.response, 'PATCH /api/feeds/:id');
      },

      /** 删除频道（条目随外键级联删除）。 */
      async remove(id: string | number): Promise<{ ok: boolean }> {
        const res = await raw.api.feeds[':id'].$delete({ param: { id: String(id) } });
        return unwrap(res, OkSchema, 'DELETE /api/feeds/:id');
      },

      /** 批量重排 / 跨组移动。 */
      async reorder(body: FeedReorderBody) {
        const res = await raw.api.feeds.reorder.$post({ json: body });
        return unwrap(res, feedsEndpoints.reorder.response, 'POST /api/feeds/reorder');
      },

      /** 刷新全部开启采集的频道（会真的回源，耗时从秒到几十秒不等）。 */
      async refreshAll() {
        const res = await raw.api.feeds.refresh.$post();
        return unwrap(res, feedsEndpoints.refresh.response, 'POST /api/feeds/refresh');
      },

      /** 刷新单个频道。源站报错时 `ok:false` 且 `result.error` 有原因，HTTP 仍是 200。 */
      async refreshOne(id: string | number) {
        const res = await raw.api.feeds[':id'].refresh.$post({ param: { id: String(id) } });
        return unwrap(res, feedsEndpoints.refreshOne.response, 'POST /api/feeds/:id/refresh');
      },

      /** OPML 批量导入。新导入的频道由服务端在后台抓取，本请求不等它。 */
      async importOpml(opml: string) {
        const res = await raw.api.feeds.import.$post({ json: { opml } });
        return unwrap(res, feedsEndpoints.import.response, 'POST /api/feeds/import');
      },
    },

    /* ---------------- 条目 ---------------- */

    entries: {
      /**
       * 列表。查询参数类型来自服务端的 zValidator（z.input，所以数字字段也接受字符串，
       * 与 URL 查询串的实际形态一致），不用在前端再抄一份。
       */
      async list(query: EntriesListQuery = {}): Promise<EntriesListResponse> {
        const res = await raw.api.entries.$get({ query });
        return unwrap(res, entriesListResponse, 'GET /api/entries');
      },

      async detail(id: string | number): Promise<EntryDetail> {
        const res = await raw.api.entries[':id'].$get({ param: { id: String(id) } });
        return unwrap(res, EntryDetailSchema, 'GET /api/entries/:id');
      },

      async flags(): Promise<EntryFlags> {
        const res = await raw.api.entries.flags.$get();
        return unwrap(res, EntryFlagsSchema, 'GET /api/entries/flags');
      },

      /** 单条标记：只改传进来的字段，没传的保持原样。 */
      async flagPatch(id: string | number, body: EntryFlagPatchBody) {
        const res = await raw.api.entries[':id'].$patch({ param: { id: String(id) }, json: body });
        return unwrap(res, entriesEndpoints.flagPatch.response, 'PATCH /api/entries/:id');
      },

      /** 按当前筛选条件批量标为已读（条件与 list 一致）。 */
      async readAll(body: ReadAllBody) {
        const res = await raw.api.entries['read-all'].$post({ json: body });
        return unwrap(res, entriesEndpoints.readAll.response, 'POST /api/entries/read-all');
      },

      /**
       * 改完关注/屏蔽规则后回溯已有条目（清空 → 重新判定 → 回写）。
       * 抓取器只对新条目打标，没有这一步「加了屏蔽旧条目还在」就是必然的。
       */
      async applyWatch() {
        const res = await raw.api.watch.apply.$post();
        return unwrap(res, entriesEndpoints.watchApply.response, 'POST /api/watch/apply');
      },
    },

    /* ---------------- 偏好 ---------------- */

    prefs: {
      async get(): Promise<PrefsResponse> {
        const res = await raw.api.prefs.$get();
        return unwrap(res, prefsResponse, 'GET /api/prefs');
      },

      /** 保存偏好。appearance/layout 按现有值合并，filters/watchRules 整组替换。 */
      async update(body: PrefsPatchBody) {
        const res = await raw.api.prefs.$post({ json: body });
        return unwrap(res, prefsEndpoints.update.response, 'POST /api/prefs');
      },
    },

    /* ---------------- 账号（改自己的） ---------------- */

    /**
     * 改密码 / 用户名。⚠️ `currentPassword` 必须正确，否则 400「当前密码不正确」。
     * 改密不会踢掉当前会话（只改哈希），其他设备上的会话也保持（`revokeOtherSessions: false`）。
     */
    async account(body: AccountBody) {
      const res = await raw.api.account.$post({ json: body });
      return unwrap(res, adminEndpoints.account.response, 'POST /api/account');
    },

    /* ---------------- 版本 ---------------- */

    version: {
      async info(): Promise<VersionInfo> {
        const res = await raw.api.version.$get();
        return unwrap(res, authEndpoints.version.response, 'GET /api/version');
      },

      /** 检查更新：服务端缓存 10 分钟。GitHub 不可达时仍是 200 + `ok:false`。 */
      async check(): Promise<VersionCheck> {
        const res = await raw.api.version.check.$post();
        return unwrap(res, authEndpoints.versionCheck.response, 'POST /api/version/check');
      },

      /** 一键更新（镜像模式，POST watchtower）。未配置更新通道返回 501。 */
      async update(): Promise<{ ok: boolean }> {
        const res = await raw.api.update.$post();
        return unwrap(res, OkSchema, 'POST /api/update');
      },
    },

    /* ---------------- 管理端 ---------------- */

    admin: {
      /** 状态页聚合。⚠️ 数据库挂了也是 200，读 `db.ready` / `db.error` 判断。 */
      async status(): Promise<Status> {
        const res = await raw.api.status.$get();
        return unwrap(res, authEndpoints.status.response, 'GET /api/status');
      },

      async config(): Promise<ConfigGetResponse> {
        const res = await raw.api.config.$get();
        return unwrap(res, adminEndpoints.configGet.response, 'GET /api/config');
      },

      /** 保存采集参数。越界值会被服务端夹回区间（不是报错），保存后立即生效。 */
      async saveConfig(body: ConfigPatchBody) {
        const res = await raw.api.config.$post({ json: body });
        return unwrap(res, adminEndpoints.configPost.response, 'POST /api/config');
      },

      async imageCache() {
        const res = await raw.api['image-cache'].$get();
        return unwrap(res, adminEndpoints.imageCacheGet.response, 'GET /api/image-cache');
      },

      /** 清空图片缓存（库 + 内存一起清）。 */
      async clearImageCache() {
        const res = await raw.api['image-cache'].clear.$post();
        return unwrap(res, adminEndpoints.imageCacheClear.response, 'POST /api/image-cache/clear');
      },

      users: {
        async list(): Promise<AdminUser[]> {
          const res = await raw.api.users.$get();
          const data = await unwrap(res, adminEndpoints.usersList.response, 'GET /api/users');
          return data.users;
        },

        async create(body: UserCreateBody) {
          const res = await raw.api.users.$post({ json: body });
          return unwrap(res, adminEndpoints.userCreate.response, 'POST /api/users');
        },

        async patch(id: string, body: UserPatchBody) {
          const res = await raw.api.users[':id'].$patch({ param: { id }, json: body });
          return unwrap(res, adminEndpoints.userPatch.response, 'PATCH /api/users/:id');
        },

        async remove(id: string): Promise<{ ok: boolean }> {
          const res = await raw.api.users[':id'].$delete({ param: { id } });
          return unwrap(res, OkSchema, 'DELETE /api/users/:id');
        },
      },
    },

    ai: {
      /** 连通性测试：**失败也返回 200**（ok:false + error），别当前端异常处理。 */
      async testLlm(llm?: LlmConfig): Promise<{ ok: boolean; error?: string; reply?: string }> {
        const res = await raw.api.digest['test-llm'].$post({ json: { llm } });
        return unwrap(res, aiEndpoints.testLlm.response, 'POST /api/digest/test-llm');
      },

      /** 有日报的日期（倒序）。 */
      async dates(): Promise<string[]> {
        const res = await raw.api.digests.$get();
        const data = await unwrap(res, aiEndpoints.dates.response, 'GET /api/digests');
        return data.dates;
      },

      /** 某天的日报；不传 date 取今天（上海时区）。 */
      async get(date?: string) {
        const res = await raw.api.digest.$get({ query: date ? { date } : {} });
        return unwrap(res, aiEndpoints.get.response, 'GET /api/digest');
      },

      /**
       * 生成日报。force 才会绕过缓存重跑（比如换了模型想重新生成一次）。
       * 模型不可用时不报错，返回 fallback=true 的规则摘要。
       */
      async generate(body: DigestGenerateBody = {}) {
        const res = await raw.api.digest.generate.$post({ json: body });
        return unwrap(res, aiEndpoints.generate.response, 'POST /api/digest/generate');
      },
    },
  };
}

/** 状态页响应类型（契约推导，不手抄一份）。 */
export type Status = z.infer<typeof authEndpoints.status.response>;

export type ApiClient = ReturnType<typeof createApiClient>;
