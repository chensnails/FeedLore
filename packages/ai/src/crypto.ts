/**
 * 敏感字段加密（模型 API Key 落库前加密）。
 *
 * 与 legacy `apps/legacy/lib/crypto.js` **字节级兼容**：同样的 scrypt 参数
 * （salt = `feedlore.secret.v1`）、同样的 AES-256-GCM、同样的
 * `enc.v1.<iv>.<tag>.<ciphertext>`（base64url）格式。
 *
 * 兼容不是洁癖，是迁移的硬要求：切换时 `user_llm.encrypted_key` 是直接搬过去的，
 * 只要 cryptoSecret 还是同一个，老密文在 v2 里就能解出明文；否则每个用户都要
 * 重新填一次 Key（而且他们多半已经忘了自己填的是哪一枚）。
 *
 * 说清楚边界：cryptoSecret 本身也在库里，所以这**不是**用来防「拿到库的人」——
 * 它防的是「备份 / 日志 / 截图 / 误导出被拖走」时直接读到一枚可用的凭据，
 * 同时让接口不再回吐明文（前端只看到掩码）。
 */

import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { settings, type Db } from '@feedlore/db';

export const ENCRYPTED_PREFIX = 'enc.v1.';
const ENC_PREFIX = ENCRYPTED_PREFIX;
const ENC_SALT = 'feedlore.secret.v1';
/** settings 表里存 cryptoSecret 的键名（与 legacy 同名，迁移时直接沿用）。 */
const SECRET_KEY = 'cryptoSecret';

/** 从 cryptoSecret 派生 32 字节主密钥。参数不可改：改了老密文就解不开。 */
export function secretKey(cryptoSecret: string): Buffer {
  return crypto.scryptSync(String(cryptoSecret || ''), ENC_SALT, 32);
}

/** 明文 → `enc.v1.<iv>.<tag>.<密文>`；空值或加密失败返回空串（不抛，调用方按「没设置」处理）。 */
export function encryptSecret(plain: string, cryptoSecret: string): string {
  const text = String(plain ?? '');
  if (!text) return '';
  try {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', secretKey(cryptoSecret), iv);
    const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return (
      ENC_PREFIX +
      [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.')
    );
  } catch (e) {
    console.error('[crypto] 加密失败：' + ((e as Error)?.message ?? e));
    return '';
  }
}

/**
 * 密文 → 明文；格式不对或密钥变过（GCM 认证失败）时返回空串。
 *
 * ⚠️ 返回空串而不是抛异常是刻意的：调用方据此判定「这个账号没有可用 Key」，
 * 于是要么让用户重填、要么直接走规则降级摘要。半截凭据去请求上游只会拿到 401。
 */
export function decryptSecret(enc: string | null | undefined, cryptoSecret: string): string {
  const s = String(enc ?? '');
  if (!s.startsWith(ENC_PREFIX)) return '';
  const parts = s.slice(ENC_PREFIX.length).split('.');
  if (parts.length !== 3 || parts.some((x) => !x)) return '';
  try {
    const d = crypto.createDecipheriv(
      'aes-256-gcm',
      secretKey(cryptoSecret),
      Buffer.from(parts[0] as string, 'base64url'),
    );
    d.setAuthTag(Buffer.from(parts[1] as string, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(parts[2] as string, 'base64url')), d.final()]).toString('utf8');
  } catch (e) {
    console.error('[crypto] 解密失败（cryptoSecret 是否变过？）：' + ((e as Error)?.message ?? e));
    return '';
  }
}

/** 只露头尾：`sk-••••••wxyz`。用于前端回显「已保存的是哪一枚」。 */
export function maskSecret(s: string | null | undefined): string {
  const t = String(s ?? '');
  if (!t) return '';
  if (t.length <= 8) return '•'.repeat(t.length);
  return t.slice(0, 3) + '•'.repeat(Math.min(12, t.length - 7)) + t.slice(-4);
}

/* ============================ cryptoSecret 的持久化 ============================ */

/**
 * 进程内缓存。cryptoSecret 一秒钟要被读几十次（每条偏好回显都要解掩码），
 * 而它本身**永远不变**（变了老密文全废），所以缓存到进程退出没有一致性风险。
 */
let cached: string | null = null;

/**
 * 读（或首次生成）站点加密主密钥。
 *
 * 与 legacy 同键同名：迁移时 v2 直接读到 legacy 生成的那一枚，密文原样可用。
 * 新部署时生成 32 字节 hex 并回写 —— 不回写的话下次重启会换一枚，
 * 刚存好的 Key 立刻全解不开（legacy 也踩过这个，所以它同样做了回写）。
 */
export async function getCryptoSecret(db: Db): Promise<string> {
  if (cached) return cached;

  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, SECRET_KEY)).limit(1);
  const stored = row?.value;
  if (typeof stored === 'string' && stored) {
    cached = stored;
    return stored;
  }

  const fresh = crypto.randomBytes(32).toString('hex');
  await db
    .insert(settings)
    .values({ key: SECRET_KEY, value: fresh as unknown as Record<string, unknown> })
    .onConflictDoUpdate({ target: settings.key, set: { value: fresh as unknown as Record<string, unknown> } });
  cached = fresh;
  return fresh;
}

/** 测试用：清掉进程内缓存（改了库里的 secret 之后要能重新读）。 */
export function resetCryptoSecretCache(): void {
  cached = null;
}
