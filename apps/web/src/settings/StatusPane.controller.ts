/* 状态面板的数据状态：useQuery 30s 轮询 + 本地 uptime 递增 + 复制诊断 / 异常重试，从 StatusPane.tsx 抽出，逐字等价。 */

import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { isOn } from '../kernel/bridge.ts';
import { qk } from '../kernel/query.ts';
import type { StatusSnapshot, StatusView } from './StatusPane.types.ts';
import { buildDiagnostics, S } from './StatusPane.utils.ts';

export function useStatusController() {
  const s = S();
  const paneRef = useRef<HTMLDivElement | null>(null);
  const [data, setData] = useState<StatusView | null>(null);
  const [hint, setHint] = useState('正在读取运行状态…');
  const [retrying, setRetrying] = useState<Record<string, boolean>>({});
  // 手动刷新的忙碌态（30 秒轮询不置忙，否则按钮每半分钟闪一次）
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0); // 每秒重绘，驱动「已运行」本地递增
  const baseRef = useRef<{ sec: number; at: number } | null>(null); // { sec, at } 用于推算当前 uptime
  const dataRef = useRef<StatusSnapshot | null>(null); // 供复制诊断读取最新快照

  // V5：/api/status 交给 Query；queryFn 走 core.apiFetch 端口，测试桩照常生效。
  // 30s 轮询改用 refetchInterval（仅在设置打开时拉，等价于旧 poll 里的 isOn 判断）；
  // 「已运行时长」本地每秒递增的 tick 与轮询解耦，保留原样。
  const statusQuery = useQuery({
    queryKey: qk.status,
    queryFn: async () => {
      const res = await s.apiFetch('/api/status');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    },
    refetchOnMount: 'always',
    refetchInterval: () => (isOn('settingsOpen') ? 30000 : false),
    // 条件挂载面板每次进入干净加载；卸载即弃缓存，避免重挂载时旧快照先回填、
    // 让「失败且无快照才显示错误态」的判定拿到过期数据。
    gcTime: 0,
    retry: false,
  });

  // 回填：-query 的 data 变化时更新快照与 uptime 基准（沿用旧 load() 成功分支语义）。
  useEffect(() => {
    if (!statusQuery.data) return;
    const j = statusQuery.data;
    baseRef.current = { sec: Number(j.app && j.app.uptimeSec) || 0, at: Date.now() };
    dataRef.current = j;
    setData(j);
    setHint('每 30 秒自动刷新 · 内存与 CPU 取自容器 cgroup');
  }, [statusQuery.data]);

  // 读取失败：hint 提示错误；已有快照时保留旧内容（失败不清屏），无快照才显示错误态。
  useEffect(() => {
    if (!statusQuery.isError) return;
    const err = statusQuery.error;
    const msg = err instanceof Error ? err.message : String(err);
    setHint('读取失败：' + msg);
    if (!dataRef.current) setData({ __error: msg });
  }, [statusQuery.isError, statusQuery.error]);

  useEffect(() => {
    // 每秒重绘驱动 uptime 本地递增；轮询已由 statusQuery.refetchInterval 接管。
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // 手动刷新：refetch + 忙碌态（轮询不置忙，与旧实现一致）。
  async function refreshStatus() {
    setBusy(true);
    try {
      await statusQuery.refetch();
    } finally {
      setBusy(false);
    }
  }

  // 每次重绘后重新套上分组的展开态（新出现的异常频道分组也要绑上）
  useEffect(() => {
    if (s && s.bindSections && paneRef.current) s.bindSections(paneRef.current);
  });

  async function copyDiagnostics() {
    const snap = dataRef.current;
    if (!snap) {
      s.toast('还没有读到状态，稍等一下', false);
      return;
    }
    const text = buildDiagnostics(snap);
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        s.toast('诊断信息已复制');
        return;
      }
      throw new Error('no clipboard');
    } catch (_) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:absolute;left:-9999px;top:0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        s.toast(ok ? '诊断信息已复制' : '复制失败，请手动复制', ok);
      } catch (_e) {
        s.toast('复制失败，请手动复制', false);
      }
    }
  }

  async function retry(id: string) {
    setRetrying((r) => ({ ...r, [id]: true }));
    try {
      const res = await s.apiFetch('/api/feeds/' + id + '/refresh', { method: 'POST' });
      const d = await res.json().catch(() => ({}));
      const er = (d.result && d.result.error) || d.error;
      if (!res.ok || er) throw new Error(s.errText(er, 'HTTP ' + res.status));
      s.toast('抓取成功，新增 ' + ((d.result && d.result.added) || 0) + ' 条');
      if (s.loadFeeds) await s.loadFeeds();
      await statusQuery.refetch(); // 刷新快照（不置刷新按钮忙碌态，与旧 load() 无参一致）
    } catch (e) {
      s.toast('重试失败：' + ((e && e.message) || e), false);
    } finally {
      setRetrying((r) => {
        const n = { ...r };
        delete n[id];
        return n;
      });
    }
  }

  return {
    paneRef,
    data,
    hint,
    retrying,
    busy,
    baseRef,
    dataRef,
    statusQuery,
    refreshStatus,
    copyDiagnostics,
    retry,
  };
}

export type StatusController = ReturnType<typeof useStatusController>;
