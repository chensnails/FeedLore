/**
 * 初始管理员的一次性密码：加密落库 + 24 小时查询窗口。
 *
 * 背景：空站点首次启动会随机生成管理员口令。旧行为只在启动日志 warn 一行，
 * 而 compose 的 json-file 日志会把它长期留住 —— 任何能看 docker logs 的人
 * 都能反复读到一枚可能还没被改掉的口令。
 *
 * 现在分两件事做，互不混淆：
 * - **口令本身**一直有效（直到管理员自己改密），不影响正常首次登录；
 * - **查询窗口**只有 24 小时：过期后 CLI 不再回吐口令，只能走管理员重置。
 *   日志横幅里虽然完整打印了一次，但它的可读价值被窗口限制住了。
 *
 * 落库用 packages/ai 的 AEAD（与模型 Key 同一套 cryptoSecret），
 * 所以库被拖走也读不到明文；密钥变更时 decryptSecret 返回空串，
 * 这里按「没有可用凭据」处理，不会拿半截口令去登录。
 *
 * 存储位置：settings 表 `initialAdminCredential` 键（jsonb，无新迁移）。
 */

import { eq } from 'drizzle-orm';
import { settings, type Db } from '@feedlore/db';
import { decryptSecret, encryptSecret, getCryptoSecret } from '@feedlore/ai';

const KEY = 'initialAdminCredential';

/** 查询窗口：生成后 24 小时内可用 CLI 取回，过期即拒。 */
export const QUERY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface InitialAdminCredential {
  username: string;
  password: string;
  generatedAt: string;
  expiresAt: string;
}

/** settings.value 里的实际形状 —— 明文口令绝不入库，只有密文。 */
interface StoredCredential {
  username: string;
  encrypted: string;
  generatedAt: string;
  expiresAt: string;
}

/* 用 node:crypto 的随机源；单独一层是为了让单测能替掉随机源。 */
import { randomBytes as nodeRandomBytes } from 'node:crypto';
let randomSource: (n: number) => Uint8Array = (n) => nodeRandomBytes(n);
function requireRandomBytes(n: number): Uint8Array {
  return randomSource(n);
}
/** 测试用：替换随机源。 */
export function setRandomSourceForTest(fn: ((n: number) => Uint8Array) | null): void {
  randomSource = fn ?? ((n) => nodeRandomBytes(n));
}

/** 生成一次性口令（12 字节随机 → 16 字符 base64url，与旧行为一致）。 */
export function newOneTimePassword(): string {
  return Buffer.from(requireRandomBytes(12)).toString('base64url');
}

/**
 * 保存初始凭据（仅随机生成时需要；显式配了 ADMIN_PASS 的走不到这里）。
 * 用 upsert 而不是 insert：容器重启时 bootstrap 只在空站点跑，正常不会覆盖，
 * 但万一并发启动也不该因为主键冲突把启动流程打断。
 */
export async function saveInitialAdmin(
  db: Db,
  username: string,
  password: string,
  nowMs = Date.now(),
): Promise<InitialAdminCredential> {
  const secret = await getCryptoSecret(db);
  const stored: StoredCredential = {
    username,
    encrypted: encryptSecret(password, secret),
    generatedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + QUERY_WINDOW_MS).toISOString(),
  };
  await db
    .insert(settings)
    .values({ key: KEY, value: stored as unknown as Record<string, unknown> })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: stored as unknown as Record<string, unknown>, updatedAt: new Date(nowMs) },
    });
  return {
    username,
    password,
    generatedAt: stored.generatedAt,
    expiresAt: stored.expiresAt,
  };
}

/**
 * 纯函数：把 settings.value 解成可回显的凭据。
 * 过期 / 形状不对 / 密钥变过（解密失败）都返回 null —— 调用方统一按「不可查」处理。
 * 把这段拆出来是为了单测不用连库。
 */
export function decodeInitialAdmin(
  value: unknown,
  cryptoSecret: string,
  nowMs = Date.now(),
): InitialAdminCredential | null {
  if (!value || typeof value !== 'object') return null;
  const s = value as Partial<StoredCredential>;
  if (typeof s.username !== 'string' || typeof s.encrypted !== 'string') return null;
  if (typeof s.expiresAt !== 'string' || typeof s.generatedAt !== 'string') return null;

  const expires = Date.parse(s.expiresAt);
  if (!Number.isFinite(expires) || nowMs >= expires) return null;

  const password = decryptSecret(s.encrypted, cryptoSecret);
  if (!password) return null;

  return {
    username: s.username,
    password,
    generatedAt: s.generatedAt,
    expiresAt: s.expiresAt,
  };
}

/** 从库里读取当前可查的初始凭据；无记录 / 过期 / 解不开都返回 null。 */
export async function readInitialAdmin(db: Db, nowMs = Date.now()): Promise<InitialAdminCredential | null> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, KEY)).limit(1);
  if (!row) return null;
  const secret = await getCryptoSecret(db);
  return decodeInitialAdmin(row.value, secret, nowMs);
}

/** 管理员改密或重置后主动清除，避免留着一条已经失效的口令。 */
export async function clearInitialAdmin(db: Db): Promise<void> {
  await db.delete(settings).where(eq(settings.key, KEY));
}

/** 给 CLI / 横幅用的剩余时间文案（精确到分钟，超过 1 小时只显示小时）。 */
export function formatRemaining(expiresAt: string, nowMs = Date.now()): string {
  const ms = Date.parse(expiresAt) - nowMs;
  if (!Number.isFinite(ms) || ms <= 0) return '已过期';
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins} 分钟`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
}
