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

/** 站点级采集参数：P4 前用默认值，之后改从 settings 表读取。 */
export const DEFAULT_REFRESH_MINUTES = num(process.env.REFRESH_MINUTES, 30);
export const DEFAULT_KEEP_DAYS = num(process.env.KEEP_DAYS, 90);

export const APP_VERSION = process.env.APP_VERSION ?? '2.0.0-p4';
