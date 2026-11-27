/* 灯箱 → 原图地址归一（纯函数，无 DOM 依赖）。
 *
 * 正文图 / 缩略图走的都是 /api/img 压缩代理（最长边 1280 + WebP），不是字节级原图。
 * 「查看原图 / 下载原图 / 新标签页打开原图」统一改走 /api/img/raw：
 * 仍由服务端做 SSRF 校验与防盗链重试，但不重编码；dl=1 时带 Content-Disposition。
 */

const PROXY = '/api/img?';
const RAW = '/api/img/raw?';

/** 从任意灯箱 src 还原原图地址；data URI / 非 http(s) 地址没有可用的原图链接。 */
export function originalImageSrc(cur: string): string {
  const s = String(cur ?? '').trim();
  if (!s || /^data:/i.test(s)) return '';
  if (s.startsWith(RAW)) {
    const u = new URLSearchParams(s.slice(RAW.length)).get('u');
    return u ? RAW + 'u=' + encodeURIComponent(u) : '';
  }
  if (s.startsWith(PROXY)) {
    // 代理地址的 u 是 encodeURIComponent 过的；w / r 等档位与重试参数都不属于原图
    const u = new URLSearchParams(s.slice(PROXY.length)).get('u');
    return u ? RAW + 'u=' + encodeURIComponent(u) : '';
  }
  if (/^https?:\/\//i.test(s)) return RAW + 'u=' + encodeURIComponent(s);
  return '';
}

/** 下载原图：服务端按 dl=1 设 attachment 并提供文件名，前端不硬编码下载名。 */
export function originalImageDownloadSrc(cur: string): string {
  const s = originalImageSrc(cur);
  return s ? s + '&dl=1' : '';
}
