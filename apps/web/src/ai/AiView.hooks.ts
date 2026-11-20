/* 日报（探索页）的状态与逻辑：视图激活、二级 tab、日期列表、摘要范围、读取 / 轮询。
 * AiView 本体只保留生成动作与 JSX 骨架。 */

import { core } from '@core';
import type { Digest, Feed, FeedsListResponse, PrefsResponse } from '@feedlore/contract';
import { useQuery } from '@tanstack/react-query';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { EVENT, on } from '../kernel/events.ts';
import { qk } from '../kernel/query.ts';

const S = () => core;

/** 日报视图的四态（读取中 / 生成中 / 就绪 / 空 / 错误）。 */
export type DigestViewState =
  | { kind: 'loading' }
  | { kind: 'genLoading'; phase: string; at?: string }
  | { kind: 'ready'; digest: Digest }
  | { kind: 'empty'; date: string }
  | { kind: 'error'; msg: string }
  | { kind: 'genError'; msg: string };

interface FeedsInfo {
  total: number;
  enabled: number;
}

interface DigestScope {
  mode: string;
  feeds: number[];
}

export function shanghaiToday() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** 日报视图的状态容器；headRef 与生成动作留在 AiView.tsx 本体。 */
export function useAiVm() {
  const s = S();
  const writable = !!(s && s.isWritable ? s.isWritable() : true);
  const [active, setActive] = useState<boolean>(() => !!(s && s.state && s.state.tab === 'ai'));
  const [pane, setPane] = useState('ask');
  const [sessionKey, setSessionKey] = useState(0);
  const newSession = () => setSessionKey(/** @param {*} [k] */ (k) => k + 1);

  function onTabKey(e: ReactKeyboardEvent<HTMLButtonElement>) {
    const list = Array.from(
      e.currentTarget.parentElement!.querySelectorAll<HTMLElement>('[role="tab"]'),
    ).filter((el) => !el.hidden);
    if (list.length < 2) return;
    const i = list.indexOf(e.currentTarget);
    let next: HTMLElement | undefined;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = list[(i + 1) % list.length];
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp')
      next = list[(i - 1 + list.length) % list.length];
    else if (e.key === 'Home') next = list[0];
    else if (e.key === 'End') next = list[list.length - 1];
    if (!next) return;
    e.preventDefault();
    setPane(next.id === 'exploreTabDigest' ? 'digest' : 'ask');
    next.focus();
  }

  const [dates, setDates] = useState<string[]>([]);
  const [selected, setSelected] = useState<string>(shanghaiToday);
  const [view, setView] = useState<DigestViewState>({ kind: 'loading' });
  /* 忙碌态按按钮区分（'regen' / 'gen'），避免两个按钮共用一枚 boolean。 */
  const [genKey, setGenKey] = useState<string | null>(null);
  const genBusy = useRef(false);
  const [genElapsed, setGenElapsed] = useState(0);
  useEffect(() => {
    if (!genKey) {
      setGenElapsed(0);
      return undefined;
    }
    const t0 = Date.now();
    const iv = setInterval(() => setGenElapsed(Math.round((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(iv);
  }, [genKey]);

  /* 请求代际：日期切换是「点第二个日期时第一个可能还在飞」，慢响应回来会盖掉新内容。 */
  const reqGen = useRef(0);
  const [feedsInfo, setFeedsInfo] = useState<FeedsInfo>({ total: 0, enabled: 0 });
  const [scope, setScope] = useState<DigestScope>({ mode: 'enabled', feeds: [] });

  useEffect(() => {
    const onView = (ev: Event) => setActive((ev as CustomEvent<unknown>).detail === 'ai');
    return on(EVENT.VIEW, onView);
  }, []);

  useEffect(() => {
    if (active) void loadDigest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const scopeQuery = useQuery({
    queryKey: qk.prefs,
    enabled: active,
    queryFn: async (): Promise<PrefsResponse> => {
      const r = await s.apiFetch('/api/prefs');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return (await r.json()) as PrefsResponse;
    },
    refetchOnMount: 'always',
    retry: false,
  });
  useEffect(() => {
    if (!scopeQuery.data) return;
    const d = scopeQuery.data.digest || {};
    setScope({
      mode: ['all', 'enabled', 'custom'].indexOf(d.mode) >= 0 ? d.mode : 'enabled',
      feeds: Array.isArray(d.feeds) ? d.feeds.map(Number) : [],
    });
  }, [scopeQuery.data]);

  // 账号关掉日报后不能停在日报 tab（tab 按钮会隐藏），自动回到问答
  useEffect(() => {
    if (pane === 'digest' && s.digestIsEnabled && !s.digestIsEnabled()) setPane('ask');
  }, [pane]);

  const today = shanghaiToday();
  const dateOptions = useMemo(() => {
    const list = dates.slice();
    if (!list.includes(today)) list.unshift(today);
    return list;
  }, [dates, today]);

  const mode = scope.mode || 'enabled';
  const scopeLabel =
    mode === 'all'
      ? '全部频道'
      : mode === 'custom'
        ? `自定义的 ${scope.feeds.length} 个频道`
        : '「采集」开启的频道';
  const subtitle =
    `把${scopeLabel}过去 24 小时的新条目整理成一份中文简报` +
    ` · 共 ${feedsInfo.total} 个频道，采集开启 ${feedsInfo.enabled} 个`;

  async function loadDigest() {
    let ds: string[] = [];
    try {
      const r = await s.apiFetch('/api/digests');
      const d = (await r.json()) as { dates?: string[] };
      ds = d.dates || [];
    } catch (_) {
      ds = [];
    }
    setDates(ds);
    try {
      const data = (await s.loadFeeds()) as FeedsListResponse;
      const list: Feed[] = (data && data.feeds) || [];
      setFeedsInfo({
        total: list.length,
        enabled: list.filter((f) => f.enabled).length,
      });
    } catch (_) {
      /* 用已有缓存 */
    }
    const opts = ds.includes(today) ? ds : [today, ...ds];
    const cur = opts.includes(selected) ? selected : (opts[0] ?? today);
    await showDigest(cur);
  }

  async function showDigest(date: string) {
    const gen = ++reqGen.current;
    setSelected(date);
    setView({ kind: 'loading' });
    try {
      const res = await s.apiFetch('/api/digest?date=' + encodeURIComponent(date));
      const data = (await res.json().catch(() => ({}))) as { digest?: Digest | null };
      if (!res.ok) throw new Error(s.errText(data, '读取失败'));
      if (gen !== reqGen.current) return;
      if (data && data.digest) setView({ kind: 'ready', digest: data.digest });
      else setView({ kind: 'empty', date });
    } catch (err) {
      if (gen !== reqGen.current) return;
      setView({ kind: 'error', msg: s.errText(err, '读取失败') });
    }
  }

  return {
    s,
    writable,
    pane,
    setPane,
    sessionKey,
    newSession,
    onTabKey,
    selected,
    view,
    setView,
    genKey,
    setGenKey,
    genElapsed,
    genBusy,
    reqGen,
    feedsInfo,
    dateOptions,
    today,
    subtitle,
    loadDigest,
    showDigest,
    setDates,
    setSelected,
  };
}
