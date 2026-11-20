/* 图片代理地址的宽度变体。
 *
 * 服务端 `/api/img` 支持 `w=320|640|960`（白名单，独立缓存、按档位压缩）。
 * 生产环境的 e.image 已经是 `/api/img?u=…`；测试桩 / 历史数据里可能是外链原图，
 * 这里一并兜住，其它协议（data: / javascript:）不参与变体。
 * ============================================================ */

const PROXY = '/api/img?';

/** 代理地址（src 允许 null/undefined，来自 DTO 的可选字段）。 */
export function widthVariant(src: unknown, w: number): string {
  const s = String(src || '');
  if (!s || /^data:/i.test(s)) return '';
  if (s.startsWith(PROXY)) return s + '&w=' + w;
  if (/^https?:\/\//i.test(s)) return PROXY + 'u=' + encodeURIComponent(s) + '&w=' + w;
  return '';
}

/** 拼 srcset；拿不到任何代理变体时返回 undefined，<img> 就只发 src 一张。 */
export function widthSrcSet(src: unknown, widths: number[]): string | undefined {
  const list: string[] = [];
  for (const w of widths) {
    const u = widthVariant(src, w);
    if (u) list.push(u + ' ' + w + 'w');
  }
  return list.length ? list.join(', ') : undefined;
}
