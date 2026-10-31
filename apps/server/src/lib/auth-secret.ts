/**
 * 零配置鉴权：AUTH_SECRET 缺失时自动生成一枚并持久化到 v2 库（settings.authSecret）。
 *
 * 1.x 用户根本不知道 AUTH_SECRET 是什么，要求他们先编辑 .env 就谈不上「无感升级」。
 * 存库而不是存文件，是因为容器里没有可写卷；同一站点的每次重建共用同一枚，
 * 已登录用户的会话才不会每次升级都被踢掉。
 *
 * 显式设置了环境变量时永远以环境变量为准（存库的那枚只作兜底）。
 */

import { randomBytes } from 'node:crypto';
import { createPool } from '@feedlore/db';

const SECRET_KEY = 'authSecret';

export async function ensureAuthSecret(targetUrl: string): Promise<void> {
  if (process.env.AUTH_SECRET?.trim()) return;

  const pool = createPool(targetUrl);
  try {
    const t = await pool.query(
      `select 1 from information_schema.tables where table_schema = 'public' and table_name = 'settings'`,
    );
    if (!t.rowCount) {
      console.warn('[auth] AUTH_SECRET 未设置，目标库还没有 settings 表：跳过自动生成');
      return;
    }

    const read = async (): Promise<string> => {
      const r = await pool.query<{ value: unknown }>('select value from settings where key = $1', [SECRET_KEY]);
      const v = r.rows[0]?.value;
      return typeof v === 'string' ? v : '';
    };

    let secret = await read();
    if (secret) {
      console.log('[auth] AUTH_SECRET：未配置环境变量，沿用库中已保存的那一枚');
    } else {
      const candidate = randomBytes(32).toString('hex');
      await pool.query(
        `insert into settings (key, value, updated_at) values ($1, to_jsonb($2::text), now())
         on conflict (key) do nothing`,
        [SECRET_KEY, candidate],
      );
      // 并发启动时另一实例可能先写入：以库里最终那枚为准
      secret = (await read()) || candidate;
      console.log('[auth] AUTH_SECRET：未配置环境变量，已自动生成并保存到 v2 库（settings.authSecret）');
    }
    process.env.AUTH_SECRET = secret;
  } finally {
    await pool.end().catch(() => {});
  }
}
