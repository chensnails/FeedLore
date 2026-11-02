/**
 * 登录尝试限流（固定窗口、按客户端 IP 分桶）。
 *
 * 为什么不直接用 better-auth 自带的限流：它拿不到可信 IP 时会退化成
 * 「no-trusted-ip」全站共享桶，sign-in 的特殊规则是 3 次/10 秒 —— 一个人连错
 * 三次，所有人都登不进去。这里在 `/api/login` 外层显式按 IP 计数，直连
 * `/api/auth/sign-in/*` 已在 app.ts 拒绝，登录入口只剩这一个。
 */

import { isIP } from 'node:net';
import type { Context } from 'hono';
import type { AppEnv } from '../middleware/auth';

const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 10;
const MAX_KEYS = 20_000;

interface Bucket {
  count: number;
  resetAt: number;
}

const attempts = new Map<string, Bucket>();

/** `::ffff:1.2.3.4` 与 `1.2.3.4` 必须是同一个桶。 */
export function normalizeIp(raw: string): string {
  const v = raw.trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v);
  return mapped ? mapped[1]! : v;
}

/**
 * 取客户端 IP。
 *
 * - `TRUST_PROXY=1`：只认反代写来的 `X-Real-IP` / `X-Forwarded-For` 最后一跳。
 *   反代通常在链尾追加真实客户端地址，取最后一跳可以忽略客户端自己伪造的前缀。
 * - 否则：只信 TCP 对端地址，客户端带来的 XFF 一律不采信。
 */
export function pickClientIp(input: {
  trustProxy: boolean;
  forwardedFor?: string | null;
  realIp?: string | null;
  remoteAddress?: string | null;
}): string {
  if (input.trustProxy) {
    const real = input.realIp?.trim() ?? '';
    if (real && isIP(real)) return normalizeIp(real);

    const chain = (input.forwardedFor ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    for (let i = chain.length - 1; i >= 0; i--) {
      if (isIP(chain[i]!)) return normalizeIp(chain[i]!);
    }
  }

  const remote = input.remoteAddress?.trim() ?? '';
  if (remote && isIP(remote)) return normalizeIp(remote);
  return 'unknown';
}

export function clientIpOf(c: Context<AppEnv>): string {
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  return pickClientIp({
    trustProxy: process.env.TRUST_PROXY === '1',
    forwardedFor: c.req.header('x-forwarded-for'),
    realIp: c.req.header('x-real-ip'),
    remoteAddress: incoming?.socket?.remoteAddress,
  });
}

/** 计一次登录尝试；超限时返回还需要等待的秒数。 */
export function takeLoginAttempt(
  key: string,
  now = Date.now(),
): { allowed: true } | { allowed: false; retryAfter: number } {
  const existing = attempts.get(key);
  if (!existing || now >= existing.resetAt) {
    if (attempts.size >= MAX_KEYS) prune(now);
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true };
  }

  existing.count += 1;
  if (existing.count > MAX_ATTEMPTS) {
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)) };
  }
  return { allowed: true };
}

function prune(now: number): void {
  for (const [key, bucket] of attempts) {
    if (now >= bucket.resetAt) attempts.delete(key);
  }
  if (attempts.size < MAX_KEYS) return;
  // 极端情况（大量不同 IP 在窗口内同时尝试）：至少保证内存有上限
  let drop = attempts.size - MAX_KEYS + 1;
  for (const key of attempts.keys()) {
    attempts.delete(key);
    if (--drop <= 0) break;
  }
}

/** 测试用：清空计数，避免用例之间互相影响。 */
export function resetLoginAttempts(): void {
  attempts.clear();
}

export const LOGIN_RATE_LIMIT = { windowMs: WINDOW_MS, maxAttempts: MAX_ATTEMPTS } as const;
