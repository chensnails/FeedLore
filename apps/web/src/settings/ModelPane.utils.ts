/* 模型面板的纯函数与共享类型：从 ModelPane.tsx 抽出，行为逐字对齐。 */

import { core } from '@core';
import type { LlmVendorView } from '@feedlore/contract';
import type { useAiSettings } from './AiCapabilities.tsx';

export const S = () => core;

export type Ai = ReturnType<typeof useAiSettings>;
export type Depth = 'low' | 'medium' | 'high';
export type SheetState = { kind: 'model' | 'vendor'; id: string | null; vendorId?: string } | null;

export const USAGE_SPANS: Record<string, string> = {
  today: '今日',
  days7: '近 7 天',
  days30: '近 30 天',
};
export const USAGE_KINDS: Record<string, string> = {
  digest: '日报生成',
  entry_ai: '单篇 AI',
  ai_tags: 'AI 标签',
  mcp: 'MCP 调用',
  test: '测试模型',
};
export const DEPTH_LABEL = { low: '轻', medium: '中', high: '深' };

export const fmtNum = (n: unknown) => Number(n || 0).toLocaleString('zh-CN');
export const fmtTokens = (n: unknown) => {
  const v = Number(n || 0);
  if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M';
  if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
  return String(v);
};
export const hostOf = (url: unknown) =>
  String(url || '')
    .replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
    .split('/')[0];
export const vendorLabel = (v: LlmVendorView | null | undefined) =>
  String((v && v.name) || hostOf(v && v.baseUrl) || '').trim() || '未命名厂商';

const pad2 = (n: number) => String(n).padStart(2, '0');
export const fmtReqTime = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  return d.toDateString() === new Date().toDateString()
    ? hm
    : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hm}`;
};
export const fmtRel = (iso: string) => {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  const diff = Date.now() - t;
  if (diff < 60e3) return '刚刚';
  if (diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前';
  if (diff < 86400e3) return Math.floor(diff / 3600e3) + ' 小时前';
  return Math.floor(diff / 86400e3) + ' 天前';
};
export const fmtDur = (ms: unknown) => {
  const v = Number(ms || 0);
  if (!v) return '—';
  if (v < 1000) return v + 'ms';
  return v >= 10000 ? Math.round(v / 1000) + 's' : (v / 1000).toFixed(1) + 's';
};

/* 界面用 low/medium/high 三档，落库是 1/2/3 的整数（0 表示未设置）。 */
export const depthToNum = (d: Depth) => (d === 'low' ? 1 : d === 'high' ? 3 : 2);
export const numToDepth = (n: number): Depth => (n === 1 ? 'low' : n === 3 ? 'high' : 'medium');
export const tempText = (t: unknown) => String(Number.isFinite(Number(t)) ? Number(t) : 0.3);
