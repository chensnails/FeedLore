/**
 * 服务端环境变量（配置单一入口 / V3.0）。
 *
 * 分层原则（改动前必读）：
 *  - **启动期固定值**：在本文件顶层固化为常量，业务代码一律 import 使用，禁止散落 process.env。
 *  - **运行时会被改写 / 测试会动态写入的值**： DATABASE_URL、AUTH_SECRET、ALLOW_SIGNUP、
 *    ALLOW_PRIVATE_HOSTS、AUTH_BASE_URL、WEB_ROOT 等，必须保留动态读取（getter 或原地读），
 *    否则会破坏两类既有语义：
 *      1. bootstrap.ts 会在运行时把 DATABASE_URL 从旧库名改写到 feedlore_v2（库名兼容兜底，
 *         2.5.4/2.5.5 反复修的那条）；auth-secret.ts 会写入 AUTH_SECRET。固化成常量会让兜底失效。
 *      2. 集成测试在运行时写这些变量来切换场景（如 ALLOW_SIGNUP），固化后测试无法注入。
 *    这些变量在本文件以 get* 函数集中读取，业务代码调用 getter，不裸读 process.env ——
 *    既保持单一入口，又保留动态语义。
 *
 * 校验：validateConfig() 是纯函数（只读传入的 env 快照，不连库、不抛错），供 main() 在启动时
 * 做 fail-fast，也便于单测覆盖。DB 可达性校验另在启动链路里做（见 index.ts#probeDatabase）。
 */

import { createRequire } from 'node:module';

/** 字符串环境的归一化：去空白，空串视为缺失。 */
function num(v: string | undefined, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/* ========================= 启动期固定值（固化常量） ========================= */

export const HOST = process.env.HOST ?? '0.0.0.0';
export const PORT = num(process.env.PORT, 3000);

/**
 * 前端构建产物目录（`apps/web/dist`）。为空表示不托管静态资源（本地开发用 vite dev server）。
 * 容器里由 Dockerfile 设为 `/app/apps/web/dist`。
 */
export const WEB_ROOT = process.env.WEB_ROOT ?? '';

/** 站点级采集参数：P5 前用环境变量默认值，之后改从 settings 表读取（管理员可调）。 */
export const DEFAULT_REFRESH_MINUTES = num(process.env.REFRESH_MINUTES, 30);
export const DEFAULT_KEEP_DAYS = num(process.env.KEEP_DAYS, 90);

/** 单次出网抓取的超时（毫秒）。订阅源挂死时不能拖住整轮抓取。 */
export const FETCH_TIMEOUT_MS = num(process.env.RSS_TIMEOUT_MS, 25000);
/** 同上，按「秒」表达（settings 表与界面用的单位，legacy 的 `timeoutSeconds`）。 */
export const RSS_TIMEOUT_SECONDS = num(
  process.env.RSS_TIMEOUT_SECONDS,
  Math.round(FETCH_TIMEOUT_MS / 1000),
);
/** 并发抓取的 URL 组数（同 URL 的多个订阅合并成一组，只回源一次）。 */
export const REFRESH_CONCURRENCY = Math.min(10, Math.max(1, num(process.env.REFRESH_CONCURRENCY, 3)));
/** 连续失败多少次自动停用采集（clamp 2~20，与 legacy 一致）。 */
export const FEED_FAIL_LIMIT = Math.min(20, Math.max(2, num(process.env.FEED_FAIL_LIMIT, 5)));
/** 每个频道最多保留多少条（按发布时间倒序裁剪）。0 = 不限。 */
export const KEEP_PER_FEED = Math.max(0, num(process.env.KEEP_PER_FEED, 300));
/** 定时抓取开关：本地调试/迁移期可置 0 只用手动刷新。 */
export const SCHEDULER_ENABLED = process.env.REFRESH_DISABLED !== '1';

/** MCP 开关：置 0 关闭 /mcp 端点。 */
export const MCP_ENABLED = process.env.MCP_ENABLED !== '0';
/** GitHub 更新检查的仓库（状态页用）。 */
export const GITHUB_REPO = process.env.GITHUB_REPO ?? 'chensnails/FeedLore';

/**
 * 严格启动开关（V3.0）：
 *  - 默认（未设或 0）：配置格式错误、DB 不可达仍 fail-fast；但「结构迁移失败」只告警继续 ——
 *    外部托管库常无 DDL 权限，直接崩会把本来能跑的站点弄成起不来（2.x 刻意的宽容）。
 *  - 置 1：结构迁移失败也 fail-fast，用于自托管有 DDL 权限、要求「启动即一致」的部署。
 */
export const STRICT_BOOT = process.env.STRICT_BOOT === '1';

/**
 * 应用版本号。
 *
 * **单一真源是根 `package.json`**（镜像里一定会拷进去，pnpm install 需要它）。
 * 读不到时退回 `0.0.0-dev` 而不是编一个像正式版的号 —— 假版本号比没有版本号更坏。
 * `APP_VERSION` 环境变量仍可覆盖（CI 出镜像时打 tag 用）。
 */
function readPackageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    // apps/server/src/env.ts → 根目录
    const pkg = require('../../../package.json') as { version?: string };
    return pkg.version?.trim() || '0.0.0-dev';
  } catch {
    return '0.0.0-dev';
  }
}
export const APP_VERSION = process.env.APP_VERSION ?? readPackageVersion();

/* ========================= 动态值（getter，保持运行时语义） ========================= */

/** 数据库连接串。bootstrap 可能运行时改写（旧库名兜底），故必须动态读。 */
export const getDatabaseUrl = (): string => process.env.DATABASE_URL?.trim() ?? '';
/** 对外访问地址（首启横幅用）。 */
export const getPublicUrl = (): string => process.env.PUBLIC_URL?.trim() ?? '';
/** better-auth 的 baseURL 配置值（未配时由请求 origin 兜底，见 routes/auth.ts）。 */
export const getAuthBaseUrl = (): string => process.env.AUTH_BASE_URL?.trim() ?? '';
/** 可信来源白名单原始串（逗号分隔）。集成测试会写入，必须 getter。 */
export const getAuthTrustedOrigins = (): string => process.env.AUTH_TRUSTED_ORIGINS ?? '';
/** 允许开放注册。集成测试会动态切换，必须 getter。 */
export const isSignupAllowed = (): boolean => process.env.ALLOW_SIGNUP === '1';
/** 内网出网逃生口。集成测试会动态切换，必须 getter。 */
export const isPrivateHostsAllowed = (): boolean => process.env.ALLOW_PRIVATE_HOSTS === '1';
/** 是否信任反向代理的 X-Forwarded-* 头。 */
export const isTrustProxy = (): boolean => process.env.TRUST_PROXY === '1';
/** 是否对 Cookie 强制 Secure 属性。 */
export const isAuthSecureCookies = (): boolean => process.env.AUTH_SECURE_COOKIES === '1';
/** 初始管理员用户名。 */
export const getAdminUser = (): string => process.env.ADMIN_USER?.trim() || 'admin';
/** 初始管理员自定义密码（未设用固定公开值）。 */
export const getAdminPass = (): string | undefined => process.env.ADMIN_PASS?.trim() || undefined;
/** web 根目录（static-headers.test.ts 会动态写入测试夹具路径，必须 getter）。 */
export const getWebRoot = (): string => process.env.WEB_ROOT ?? '';

/** 出网代理初始值（lib/net.ts 会据此建立 ProxyAgent；settings 表可覆盖）。 */
export const getProxyUrl = (): string => String(process.env.PROXY_URL ?? '').trim();

/** 站点参数的环境默认值（sourceDefaults 用；管理员可在设置页覆盖并落库）。 */
export const getAutoRefreshMinutes = (): string | undefined => process.env.AUTO_REFRESH_MINUTES;
export const getImgTtlDays = (): string | undefined => process.env.IMG_TTL_DAYS;
export const getImgKeepDays = (): string | undefined => process.env.IMG_KEEP_DAYS;
export const getImgMaxDim = (): string | undefined => process.env.IMG_MAX_DIM;
export const getImgWebpQuality = (): string | undefined => process.env.IMG_WEBP_QUALITY;

/** GitHub 更新检查的可选 token（提高 rate limit）。 */
export const getGithubToken = (): string => process.env.GITHUB_TOKEN?.trim() ?? '';
/** 一键更新的 webhook 目标与令牌（两个都配才启用）。 */
export const getUpdateWebhookUrl = (): string => process.env.UPDATE_WEBHOOK_URL ?? '';
export const getUpdateWebhookToken = (): string => process.env.UPDATE_WEBHOOK_TOKEN ?? '';

/* ========================= 启动期校验（纯函数） ========================= */

export interface ConfigIssue {
  key: string;
  message: string;
}

/**
 * 校验环境变量的格式与取值区间。纯函数：只读传入快照，不连库、不抛错、不写 process.env。
 *
 * 只校验「配错了会导致运行期诡异行为」的项；可选变量缺失不算错误。DB 是否存在/可达
 * 不在这里判（那需要连库），由 index.ts#probeDatabase 在启动链路里做。
 *
 * @param env 环境变量快照，默认取 process.env。测试可传入自定义对象覆盖边界。
 */
export function validateConfig(env: Record<string, string | undefined> = process.env): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const trimmed = (k: string): string => env[k]?.trim() ?? '';

  // PORT：合法 TCP 端口。
  if (trimmed('PORT')) {
    const p = Number(trimmed('PORT'));
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      issues.push({ key: 'PORT', message: `必须是 1~65535 的整数，收到 "${trimmed('PORT')}"` });
    }
  }

  // DATABASE_URL：给了就必须是合法 postgres/postgresql URL（缺库名也算了，连库时会报）。
  const dbUrl = trimmed('DATABASE_URL');
  if (dbUrl) {
    try {
      const u = new URL(dbUrl);
      if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
        issues.push({ key: 'DATABASE_URL', message: `协议必须是 postgres:// 或 postgresql://，收到 "${u.protocol}"` });
      }
      if (!u.hostname) {
        issues.push({ key: 'DATABASE_URL', message: '缺少主机名' });
      }
    } catch {
      issues.push({ key: 'DATABASE_URL', message: '不是合法的 URL' });
    }
  }

  // 数值型配置：给了就必须是有限数，且落在 clamp 之外的明显非法值要报出来。
  const numeric: Array<[string, number, number]> = [
    ['REFRESH_MINUTES', 1, 1440],
    ['KEEP_DAYS', 0, 3650],
    ['RSS_TIMEOUT_MS', 1000, 300000],
    ['REFRESH_CONCURRENCY', 1, 10],
    ['FEED_FAIL_LIMIT', 2, 20],
    ['KEEP_PER_FEED', 0, 5000],
    ['PG_POOL_MAX', 1, 200],
  ];
  for (const [key, min, max] of numeric) {
    const raw = trimmed(key);
    if (!raw) continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min || n > max) {
      issues.push({ key, message: `需在 ${min}~${max} 之间，收到 "${raw}"` });
    }
  }

  // 布尔型配置：只认 0/1（或留空），其它值通常是手误。
  const bools = [
    'STRICT_BOOT', 'MCP_ENABLED', 'ALLOW_SIGNUP', 'ALLOW_PRIVATE_HOSTS',
    'AUTH_SECURE_COOKIES', 'TRUST_PROXY', 'REFRESH_DISABLED',
  ];
  for (const key of bools) {
    const raw = trimmed(key);
    if (raw && raw !== '0' && raw !== '1') {
      issues.push({ key, message: `布尔开关只接受 0 或 1，收到 "${raw}"` });
    }
  }

  return issues;
}
