/**
 * 图片回源的请求头策略（纯函数，可单测）。
 *
 * 旧实现只试两次：不带 Referer、403 时带 origin。仍有相当一部分图床要求
 * 「像浏览器一样」的 UA + Referer 才放行。这里扩成三次，且只在 403 时逐级升级，
 * 正常图片一次请求就够，不会因为放宽策略把回源量翻三倍。
 */

/** 更完整的浏览器 UA，仅用于防盗链重试；默认仍用项目自己的 bot UA。 */
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const IMAGE_FETCH_ATTEMPTS = 3;

/**
 * @param url 已经过 assertPublicHost 的绝对地址
 * @param attempt 0=默认、1=带 Referer、2=浏览器 UA + Referer
 * @param ua 默认的 FeedLore UA（由调用方传，避免在纯函数里读 env）
 */
export function imageFetchHeaders(
  url: string,
  attempt: number,
  ua: string,
): Record<string, string> {
  const base: Record<string, string> = {
    'User-Agent': String(ua || 'FeedLore'),
    Accept: 'image/avif,image/webp,image/*,*/*;q=0.8',
  };
  if (!Number.isFinite(attempt) || attempt <= 0) return base;

  let origin = '';
  try {
    origin = new URL(url).origin + '/';
  } catch {
    return base;
  }
  const out: Record<string, string> = { ...base, Referer: origin };
  if (attempt >= 2) {
    out['User-Agent'] = BROWSER_UA;
    out['Accept-Language'] = 'zh-CN,zh;q=0.9,en;q=0.8';
  }
  return out;
}
