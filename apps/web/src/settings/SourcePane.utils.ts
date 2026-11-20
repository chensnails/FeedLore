/* 数据源面板的纯函数：从 SourcePane.tsx 抽出，行为逐字对齐。 */

import { core } from '@core';
import type { Feed } from '../core/types.ts';
import type { FeedSnapshot } from './SourcePane.types.ts';

export const S = () => core;

/** 字节数格式化（图片缓存体积展示） */
export function fmtBytes(n: unknown) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

/** 选项表补上「库里当前值」：部署时用 env 设了非标称值（如 IMG_TTL_DAYS=5）也能正确回显 */
export function withCurrentOption(
  list: Array<[number, string]>,
  cur: unknown,
): Array<[number, string]> {
  if (list.some(([v]) => String(v) === String(cur))) return list;
  const n = Number(cur);
  if (!Number.isFinite(n)) return list;
  return [...list, [n, `${n} 天`] as [number, string]].sort((a, b) => a[0] - b[0]);
}

/* ---------- 纯函数（自旧 app.js 移植，行为逐字对齐） ---------- */
export function fmtMinutes(m: unknown) {
  const n = Number(m);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 60) return `${n} 分钟`;
  if (n === 60) return '1 小时';
  if (n < 1440) return `${(n / 60).toFixed(n % 60 ? 1 : 0)} 小时`;
  return '1 天';
}

/** 设置面板里显示「今天 12:36」这类相对时间 */
export function fmtDateTime(ts: string | number | null | undefined) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now.getTime() - 86400000).toDateString() === d.toDateString();
  if (sameDay) return `今天 ${hm}`;
  if (yesterday) return `昨天 ${hm}`;
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
}

/** 订阅地址只显示「主机名 + 路径」，太长就截断 */
export function prettyUrl(u: string) {
  try {
    const x = new URL(u);
    const path = x.pathname.replace(/\/$/, '');
    const s = x.host + path;
    return s.length > 64 ? s.slice(0, 62) + '…' : s;
  } catch (_) {
    return String(u || '');
  }
}

export function feedStatusText(f: Feed) {
  const parts = [`${f.entryCount} 条`];
  parts.push(f.lastFetchedAt ? fmtDateTime(f.lastFetchedAt) + ' 抓取' : '尚未抓取');
  parts.push(`每 ${fmtMinutes(f.effectiveRefreshMinutes)}`);
  if (!f.enabled && f.lastFetchedAt) parts.push('已停采');
  return parts.join(' · ');
}

export const jsonPost = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
// 注意合并顺序：jsonPost 自带 method:'POST'，必须后覆盖回 PATCH
export const patchInit = (body: unknown) => Object.assign(jsonPost(body), { method: 'PATCH' });

/** 删除撤销用的快照：重建订阅需要 url + 开关 + 分组，其余字段走 PATCH 补 */
export const snapshotFeed = (f: Feed): FeedSnapshot => ({
  url: f.url,
  enabled: f.enabled,
  cardEnabled: f.cardEnabled,
  groupName: f.groupName || '',
  fullText: f.fullText,
  refreshMinutes: f.refreshMinutes,
  customTitle: f.customTitle,
});
