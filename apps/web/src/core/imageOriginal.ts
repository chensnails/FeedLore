/* 灯箱 → 原图地址归一（纯函数，无 DOM 依赖）。
 *
 * 正文图 / 缩略图走的都是 /api/img 压缩代理（最长边 1280 + WebP），不是字节级原图。
 * 「查看原图 / 下载原图 / 新标签页打开原图」统一改走 /api/img/raw：
 * 仍由服务端做 SSRF 校验与防盗链重试，但不重编码；dl=1 时带 Content-Disposition。
 */

/** 灯箱里拿到的 currentSrc 是**绝对地址**（http://host/api/img?u=…），
 *  历史数据 / 测试桩里也可能是相对地址；两种都要认，否则会把整个代理地址当成外链再包一层。 */
const PROXY = /^(?:https?:\/\/[^/]+)?\/api\/img\?/i;
const RAW = /^(?:https?:\/\/[^/]+)?\/api\/img\/raw\?/i;
const RAW_PATH = '/api/img/raw?';

/** 从任意灯箱 src 还原原图地址；data URI / 非 http(s) 地址没有可用的原图链接。 */
export function originalImageSrc(cur: string): string {
  const s = String(cur ?? '').trim();
  if (!s || /^data:/i.test(s)) return '';
  if (RAW.test(s)) {
    const u = new URLSearchParams(s.replace(RAW, '')).get('u');
    return u ? RAW_PATH + 'u=' + encodeURIComponent(u) : '';
  }
  if (PROXY.test(s)) {
    // 代理地址的 u 是 encodeURIComponent 过的；w / r 等档位与重试参数都不属于原图
    const u = new URLSearchParams(s.replace(PROXY, '')).get('u');
    return u ? RAW_PATH + 'u=' + encodeURIComponent(u) : '';
  }
  if (/^https?:\/\//i.test(s)) return RAW_PATH + 'u=' + encodeURIComponent(s);
  return '';
}

/** 下载原图：服务端按 dl=1 设 attachment 并提供文件名，前端不硬编码下载名。 */
export function originalImageDownloadSrc(cur: string): string {
  const s = originalImageSrc(cur);
  return s ? s + '&dl=1' : '';
}
