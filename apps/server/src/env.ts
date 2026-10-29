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
 * 测试期开关：置 1 时跳过会话校验，用固定开发身份放行受保护端点。
 * ⚠️ 仅供 v2 测试容器使用；P4 接入 better-auth 后必须移除该分支。
 */
export const AUTH_DISABLED = process.env.V2_AUTH_DISABLED === '1';

/** 站点级采集参数：P4 前用默认值，之后改从 settings 表读取。 */
export const DEFAULT_REFRESH_MINUTES = num(process.env.REFRESH_MINUTES, 30);
export const DEFAULT_KEEP_DAYS = num(process.env.KEEP_DAYS, 90);

export const APP_VERSION = process.env.APP_VERSION ?? '2.0.0-p3';
