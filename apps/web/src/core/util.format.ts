/* 纯格式化工具：计数压缩 / 时间 / HTML 转义 / 频道名 / 链接标签 / 动效偏好。
 * 从 util.ts 抽出（深度重组），util.ts 通过 export * 保持外部链不变。 */

import type { Feed } from './types.ts';

/** 侧栏计数徽标：用 k / w / 亿 压缩，不封顶。
 *
 *  计数会随文章无限增长，直接显示会把频道行撑变形。不足 1000 原样显示；
 *  之后按量级换单位，并保留一位小数（四舍五入；到 10 个单位以上只用整数），
 *  例如 1234 → 1.2k、9999 → 10k、12345 → 1.2w。精确值仍放在 tooltip 里。
 */
function compactUnit(v: number, unit: number): string {
  const tenths = Math.round(v / (unit / 10));
  if (tenths >= 100) return String(Math.round(tenths / 10));
  return (tenths / 10).toFixed(1).replace(/\.0$/, '');
}

export function fmtBadge(n: number): string {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  if (v < 1000) return String(v);
  if (v >= 100000000) return compactUnit(v, 100000000) + '亿';
  if (v >= 10000) return compactUnit(v, 10000) + 'w';
  return compactUnit(v, 1000) + 'k';
}

/** 完整时间戳，用于 title 提示与展开体的发布时间 */
export function fmtFull(ts: string | number | null | undefined): string {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 文章日期：始终显示到分钟。今天/昨天给「今天 HH:mm」，同年给「MM-DD HH:mm」，跨年补上年份 */
export function fmtDate(ts: string | number | null | undefined): string {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now.getTime() - 86400000).toDateString() === d.toDateString();
  if (sameDay) return `今天 ${hm}`;
  if (yesterday) return `昨天 ${hm}`;
  if (d.getFullYear() === now.getFullYear())
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
}

export function escapeHtml(s: unknown): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function shortFeedName(n: unknown): string {
  return String(n || '')
    .replace(/\s*-\s*Telegram Channel\s*$/i, '')
    .trim();
}

/** 频道的展示名：自定义名优先，否则抓取来的标题，再否则 url */
export function feedTitle(f: unknown): string {
  if (!f || typeof f !== 'object') return '';
  const o = f as Partial<Feed>;
  return o.customTitle || o.title || o.url || '';
}

export function prefersReducedMotion() {
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

/* ---------------- 链接：标签 / 短地址 ---------------- */

/** 常见网盘域名 → 中文标签，其余用主机名 */
export const HOST_LABELS: Array<[RegExp, string]> = [
  [/pan\.quark\.cn$|(^|\.)quark\.cn$/, '夸克'],
  [/pan\.baidu\.com$/, '百度网盘'],
  [/aliyundrive\.(com|net)$|(^|\.)alipan\.com$/, '阿里云盘'],
  [/cloud\.189\.cn$/, '天翼云盘'],
  [/(^|\.)115\.com$/, '115 网盘'],
  [/123pan\.com$|123684\.com$/, '123 网盘'],
  [/mypikpak\.com$/, 'PikPak'],
  [/(^|\.)t\.me$|(^|\.)telegram\.me$/, 'Telegram'],
];
export function linkLabel(url: string): string {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch (_) {
    return '链接';
  }
  for (const [re, name] of HOST_LABELS) if (re.test(host)) return name;
  return host.replace(/^www\./, '');
}
/** 菜单里显示的短地址：去协议、超长中间省略 */
export function shortUrl(url: string): string {
  const s = String(url).replace(/^https?:\/\//i, '');
  return s.length > 46 ? s.slice(0, 30) + '…' + s.slice(-12) : s;
}
