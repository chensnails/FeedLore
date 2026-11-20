/* 模型面板的数据状态：useQuery + 回填副作用，从 ModelPane.tsx 抽出，逐字对齐。 */

import type { AiRequestItem, AiUsageResponse } from '@feedlore/contract';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { qk } from '../kernel/query.ts';
import { useAiSettings } from './AiCapabilities.tsx';
import { type Ai, S, type SheetState } from './ModelPane.utils.ts';
import { useResult } from './primitives.tsx';

export function useModelPaneState(onDirtyChange?: (dirty: boolean) => void) {
  const paneRef = useRef<HTMLDivElement>(null);
  const ai: Ai = useAiSettings();
  const { vendors, models, loaded, loadError, busy, msg } = ai;

  // 详情层：{ kind: 'model'|'vendor', id: string|null }；id 为 null = 新建
  const [sheet, setSheet] = useState<SheetState>(null);
  // 在模型层里点「添加厂商」后，厂商保存完要自动回到新建模型
  const [pendingModel, setPendingModel] = useState(false);
  // 厂商组的展开状态；没动过的组默认展开默认模型所在厂商
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  const [usage, setUsage] = useState<AiUsageResponse | null>(null);
  const [usageBusy, setUsageBusy] = useState(false);
  const [requests, setRequests] = useState<AiRequestItem[] | null>(null);
  const [reqError, setReqError] = useState('');
  const [reqBusy, setReqBusy] = useState(false);
  const [reqLimit, setReqLimit] = useState(20);
  const [keepInfo, setKeepInfo] = useState<{ keep: number; days: number }>({ keep: 200, days: 30 });
  const [statusResult, showStatusResult] = useResult();

  useEffect(() => {
    const s = S();
    if (s && s.bindSections && paneRef.current) s.bindSections(paneRef.current);
  }, []);
  useEffect(() => {
    if (onDirtyChange) onDirtyChange(false);
  }, [onDirtyChange]);
  // V5：用量 / 请求历史交给 Query；queryFn 走 core.apiFetch 端口，测试桩照常生效。
  // 条数切换通过 queryKey 带 reqLimit 自动重拉（无需手动发请求）。
  const usageQuery = useQuery({
    queryKey: qk.aiUsage,
    queryFn: async () => {
      const res = await S().apiFetch('/api/ai-usage?days=30');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(S().errText(data, 'HTTP ' + res.status));
      return data;
    },
    refetchOnMount: 'always',
    gcTime: 0,
    retry: false,
  });
  const requestsQuery = useQuery({
    queryKey: qk.aiRequests(reqLimit),
    queryFn: async () => {
      const res = await S().apiFetch(
        '/api/ai-requests?limit=' + encodeURIComponent(String(reqLimit)),
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(S().errText(data, 'HTTP ' + res.status));
      return data;
    },
    refetchOnMount: 'always',
    gcTime: 0,
    retry: false,
  });

  // 用量：参考信息，失败静默留空（保留原语义）。
  useEffect(() => {
    setUsageBusy(false);
    if (usageQuery.data) setUsage(usageQuery.data);
  }, [usageQuery.data]);

  // 请求历史：回填列表 + keepInfo；失败写 reqError 并保住旧列表。
  useEffect(() => {
    setReqBusy(false);
    if (!requestsQuery.data) return;
    setReqError('');
    const data = requestsQuery.data;
    setRequests(Array.isArray(data.requests) ? data.requests : []);
    setKeepInfo({
      keep: Number(data.keep) > 0 ? Number(data.keep) : 200,
      days: Number(data.keepDays) > 0 ? Number(data.keepDays) : 30,
    });
  }, [requestsQuery.data]);
  useEffect(() => {
    if (!requestsQuery.isError) return;
    const err = requestsQuery.error;
    setReqError(String(err?.message || err));
    setRequests((prev) => (Array.isArray(prev) ? prev : []));
  }, [requestsQuery.isError, requestsQuery.error]);

  // 写后 / 手动刷新沿用原入口：refetch 强制重拉并触发上面的回填。
  async function loadUsage() {
    setUsageBusy(true);
    await usageQuery.refetch();
    setUsageBusy(false);
  }
  async function loadRequests(_limit?: number) {
    setReqBusy(true);
    setReqError('');
    await requestsQuery.refetch();
    setReqBusy(false);
  }

  function refreshAll() {
    loadRequests();
    loadUsage();
  }

  return {
    paneRef,
    ai,
    vendors,
    models,
    loaded,
    loadError,
    busy,
    msg,
    sheet,
    setSheet,
    pendingModel,
    setPendingModel,
    openGroups,
    setOpenGroups,
    usage,
    usageBusy,
    requests,
    reqError,
    reqBusy,
    reqLimit,
    setReqLimit,
    keepInfo,
    statusResult,
    showStatusResult,
    loadRequests,
    refreshAll,
  };
}
