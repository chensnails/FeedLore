'use strict';

/**
 * 笺川 · 敏感字段加密（模型 API Key 落库前加密）
 *
 * 主密钥由 cryptoSecret 经 scrypt 派生，AES-256-GCM 加密，格式 `enc.v1.<iv>.<tag>.<密文>`（base64url）。
 *
 * 说清楚边界：cryptoSecret 本身也在库里，所以这**不是**用来防「拿到库的人」——
 * 它防的是「备份 / 日志 / 截图 / 误导出被拖走」时直接读到一枚可用的凭据，
 * 同时让接口不再回吐明文（前端只看到掩码）。
 *
 * v2.2.0 起抽出到 lib/：密钥由调用方传入（原本直接读模块级 settings），
 * 于是可以在 node:test 里真跑一遍加解密往返，而不必连库。
 */

const crypto = require('crypto');

const ENC_PREFIX = 'enc.v1.';
const ENC_SALT = 'shiyue.secret.v1';

const logErr = (...a) => console.error(...a);

/** 从 cryptoSecret 派生 32 字节主密钥 */
function secretKey(cryptoSecret) {
  return crypto.scryptSync(String(cryptoSecret || ''), ENC_SALT, 32);
}

/** 明文 → "enc.v1.<iv>.<tag>.<密文>"（base64url）；空值返回空串；失败也返回空串 */
function encryptSecret(plain, cryptoSecret) {
  const text = String(plain == null ? '' : plain);
  if (!text) return '';
  try {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', secretKey(cryptoSecret), iv);
    const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
    return ENC_PREFIX + [
      iv.toString('base64url'),
      c.getAuthTag().toString('base64url'),
      body.toString('base64url'),
    ].join('.');
  } catch (e) {
    logErr('[crypto] 加密失败：' + ((e && e.message) || e));
    return '';
  }
}

/** 密文 → 明文；格式不对或密钥变过（认证失败）时返回空串 */
function decryptSecret(enc, cryptoSecret) {
  const s = String(enc == null ? '' : enc);
  if (!s.startsWith(ENC_PREFIX)) return '';
  const parts = s.slice(ENC_PREFIX.length).split('.');
  if (parts.length !== 3 || parts.some((x) => !x)) return '';
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', secretKey(cryptoSecret), Buffer.from(parts[0], 'base64url'));
    d.setAuthTag(Buffer.from(parts[1], 'base64url'));
    return Buffer.concat([d.update(Buffer.from(parts[2], 'base64url')), d.final()]).toString('utf8');
  } catch (e) {
    logErr('[crypto] 解密失败（cryptoSecret 是否变过？）：' + ((e && e.message) || e));
    return '';
  }
}

/** 只露头尾：sk-ab••••••••wxyz。用于前端回显「已保存的是哪一枚」 */
function maskSecret(s) {
  const t = String(s || '');
  if (!t) return '';
  if (t.length <= 8) return '•'.repeat(t.length);
  return t.slice(0, 3) + '•'.repeat(Math.min(12, t.length - 7)) + t.slice(-4);
}

/** 口令哈希：scrypt，salt 由调用方提供 */
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

/** 定长比较（避免时序侧信道）；长度不等直接 false */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

module.exports = { ENC_PREFIX, secretKey, encryptSecret, decryptSecret, maskSecret, hashPassword, safeEqual };
