/**
 * MCP 接口令牌（`flm_` 前缀的 Bearer token）。
 *
 * 设计要点：
 * - 明文只在「创建」那一刻返回一次，库里只存 SHA-256；
 * - `prefix` 存明文前 12 字符（`flm_` + 8 hex），设置页与日志靠它辨认归属；
 * - lookup 走 token_hash 的 UNIQUE 索引，验证成本是一次索引点查；
 * - scope 两档：`read`（P1 全部工具）/ `write`（预留给写工具）。
 *
 * 本文件只放纯函数；带数据库的验证与限流在 middleware/mcpAuth.ts。
 */

import { createHash, randomBytes } from 'node:crypto';

export const MCP_TOKEN_PREFIX = 'flm_';

/** 单账号 token 上限：设置页要能一眼看清，且泄露面有界。 */
export const MCP_TOKENS_MAX_PER_USER = 20;

/** `flm_` + 32 hex（24 字节熵）。暴力枚举不可行，泄露只能靠吊销兜底。 */
export function generateMcpToken(): { secret: string; hash: string; prefix: string } {
  const secret = MCP_TOKEN_PREFIX + randomBytes(24).toString('hex');
  return { secret, hash: hashMcpToken(secret), prefix: secret.slice(0, 12) };
}

export function hashMcpToken(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** 从 Authorization 头取 Bearer token；不是 Bearer 形态返回 null。 */
export function bearerFromHeader(header: string | undefined | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header.trim());
  return m ? m[1]! : null;
}

/* ---------------- 限流（固定窗口，按 token id 分桶） ---------------- */

const WINDOW_MS = 60_000;
/** 每 token 每分钟；AI 客户端一次任务十几连调够用，防的是失控循环。 */
const MAX_PER_WINDOW = 120;
const MAX_BUCKETS = 5_000;

const buckets = new Map<string, { count: number; resetAt: number }>();

/**
 * 命中返回剩余等待秒数（>0 表示被限），未命中返回 0 并计数。
 * 桶数有上限：达到上限时整表清空（token 数有界，正常永远走不到）。
 */
export function mcpRateLimit(tokenId: string, now: number = Date.now()): number {
  const b = buckets.get(tokenId);
  if (!b || b.resetAt <= now) {
    if (buckets.size >= MAX_BUCKETS) buckets.clear();
    buckets.set(tokenId, { count: 1, resetAt: now + WINDOW_MS });
    return 0;
  }
  b.count += 1;
  if (b.count > MAX_PER_WINDOW) return Math.ceil((b.resetAt - now) / 1000);
  return 0;
}

export function mcpRateLimitResetForTest(): void {
  buckets.clear();
}
