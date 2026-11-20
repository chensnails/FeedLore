/* 账号面板的纯函数与共享类型：从 AccountPane.tsx 抽出，行为逐字对齐。 */

import { core } from '@core';
import type * as React from 'react';

export const S = () => core;

export const ROLE_LABEL: Record<string, string> = {
  admin: '管理员',
  user: '普通',
  readonly: '只读',
};

export type OpResult = { ok: boolean; error?: string; canceled?: boolean };
export type OpResultMaybe = OpResult | undefined;
export type ResultState = { ok: boolean; msg: string } | null;
export type SheetState =
  | { type: 'device'; id: string }
  | { type: 'user'; id: string }
  | { type: 'addUser' }
  | null;

/** UA 只取「浏览器 · 系统」两段，原文太长且没人读得懂；认不出就截断原文兜底。 */
export function deviceLabel(ua: string | null | undefined) {
  if (!ua) return '未知设备';
  const os = /Windows NT/.test(ua)
    ? 'Windows'
    : /iPhone|iPad|iPod/.test(ua)
      ? 'iOS'
      : /Android/.test(ua)
        ? 'Android'
        : /Mac OS X/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  const br = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : '';
  if (br || os) return [br, os].filter(Boolean).join(' · ');
  return ua.length > 48 ? ua.slice(0, 48) + '…' : ua;
}

/** 最近活跃时间按相对量显示；超过 30 天回落到日期，绝对时间留在 title 里。 */
export function fmtRel(iso: string) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  const diff = Date.now() - t;
  if (diff < 60e3) return '刚刚';
  if (diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前';
  if (diff < 86400e3) return Math.floor(diff / 3600e3) + ' 小时前';
  if (diff < 30 * 86400e3) return Math.floor(diff / 86400e3) + ' 天前';
  return iso.slice(0, 10);
}

export const openOnKey = (fn: () => void) => (ev: React.KeyboardEvent<HTMLElement>) => {
  if (ev.target !== ev.currentTarget) return;
  if (ev.key === 'Enter' || ev.key === ' ') {
    ev.preventDefault();
    fn();
  }
};
