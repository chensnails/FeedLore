/**
 * 服务端环境变量（集中读取，禁止业务代码散落 process.env）。
 */

function num(v: string | undefined, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

export const HOST = process.env.HOST ?? '0.0.0.0';
export const PORT = num(process.env.PORT, 3000);

/**
 * 数据库连接串。缺失时服务仍会启动（/api/health 报 db.ready=false），
 * 便于容器先起来再用健康检查定位问题，而不是 CrashLoopBackOff。
 */
export const DATABASE_URL = process.env.DATABASE_URL ?? '';

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
/** 并发抓取的 URL 组数（同 URL 的多个订阅合并成一组，只回源一次）。 */
export const REFRESH_CONCURRENCY = Math.min(10, Math.max(1, num(process.env.REFRESH_CONCURRENCY, 3)));
/** 连续失败多少次自动停用采集（clamp 2~20，与 legacy 一致）。 */
export const FEED_FAIL_LIMIT = Math.min(20, Math.max(2, num(process.env.FEED_FAIL_LIMIT, 5)));
/** 每个频道最多保留多少条（按发布时间倒序裁剪）。0 = 不限。 */
export const KEEP_PER_FEED = Math.max(0, num(process.env.KEEP_PER_FEED, 300));
/** 定时抓取开关：本地调试/迁移期可置 0 只用手动刷新。 */
export const SCHEDULER_ENABLED = process.env.REFRESH_DISABLED !== '1';

export const APP_VERSION = process.env.APP_VERSION ?? '2.0.0-p4';
