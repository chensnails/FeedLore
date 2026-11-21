/* 关注 / 屏蔽面板的数据状态与动作：useQuery + 回填副作用 + 即存动作，从 WatchPane.tsx 抽出，逐字等价。 */

import type { Feed, PrefsResponse } from '@feedlore/contract';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { qk } from '../kernel/query.ts';
import { useFormLoadGuard } from './primitives.tsx';
import type { FilterDraft, ResultState, RuleDraft, SheetState } from './WatchPane.types.ts';
import {
  blankFilter,
  blankRule,
  filtersFromServer,
  fromServer,
  jsonPost,
  normalizeDays,
  ruleName,
  S,
  toServer,
} from './WatchPane.utils.ts';

export function useWatchController(onDirtyChange?: (dirty: boolean) => void) {
  const s = S();
  const [rules, setRules] = useState<RuleDraft[]>([]);
  const [filters, setFilters] = useState<FilterDraft[]>([]);
  const [webhook, setWebhook] = useState('');
  const [savedWebhook, setSavedWebhook] = useState('');
  const [expireDays, setExpireDays] = useState('90'); // 关注保留天数，0 = 永不
  const [savedExpireDays, setSavedExpireDays] = useState('90');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(''); // rules | filters | webhook | expire | apply
  const [result, setResult] = useState<ResultState>(null); // { ok, msg } | null —— #watchResult
  const [prefsError, setPrefsError] = useState(''); // /api/prefs 读取失败（面板级，编辑动作要禁用）
  const [sheet, setSheet] = useState<SheetState>(null); // { type: 'rule' | 'filter', value, isNew }
  const paneRef = useRef<HTMLDivElement>(null);
  const guard = useFormLoadGuard();

  // 适用范围选择器要用的频道 / 分组清单
  const [feedsList, setFeedsList] = useState<Feed[]>([]);
  const [groupOrder, setGroupOrder] = useState<string[]>([]);

  // V5：/api/prefs 交给 Query（去重 / 失效）；queryFn 走 core.apiFetch 端口，测试桩照常生效。
  const prefsQuery = useQuery({
    queryKey: qk.prefs,
    queryFn: async () => {
      const res = await s.apiFetch('/api/prefs');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    },
    refetchOnMount: 'always',
    retry: false,
  });

  // 读取失败时不能把空数组显示成「还没有规则」——空态要等首包成功后才放行。
  const applyPrefs = (d: Partial<PrefsResponse>) => {
    setRules(fromServer(d.watchRules));
    const w = typeof d.webhookUrl === 'string' ? d.webhookUrl : '';
    const days = Number.isFinite(Number(d.watchExpireDays))
      ? String(Number(d.watchExpireDays))
      : '90';
    setWebhook(w);
    setSavedWebhook(w);
    setExpireDays(days);
    setSavedExpireDays(days);
    setFilters(filtersFromServer(d.filters));
  };
  useEffect(() => {
    if (prefsQuery.isPending) return;
    if (prefsQuery.isError) {
      const err = prefsQuery.error;
      setPrefsError('读取失败：' + String((err && err.message) || err));
      setLoaded(true);
      return;
    }
    if (!prefsQuery.data) return;
    // 首包晚到时用户可能已在编辑 webhook / 天数 / 草稿：跳过回填，不覆盖输入。
    guard.apply(() => {
      setPrefsError('');
      applyPrefs(prefsQuery.data);
      setLoaded(true);
    });
  }, [prefsQuery.data, prefsQuery.isPending, prefsQuery.isError, prefsQuery.error]);

  // 频道清单只有适用范围选择器用得到，失败时选择器里只剩「全部频道」（原 loadPrefs 后半段）。
  const loadFeeds = async () => {
    try {
      const data = await s.loadFeeds();
      setFeedsList((data && data.feeds) || []);
      setGroupOrder(data && Array.isArray(data.groupOrder) ? data.groupOrder : []);
    } catch (_) {
      /* 拿不到频道清单时选择器仍可切「全部频道」 */
    }
  };
  useEffect(() => {
    loadFeeds();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 「重试」沿用原入口名：强制重拉 prefs（refetch 绕过 stale 缓存）+ 频道清单。
  const loadPrefs = async () => {
    await prefsQuery.refetch();
    await loadFeeds();
  };

  // 可折叠分组的开合按账号持久化（与其它面板同一机制）
  useEffect(() => {
    if (s && s.bindSections && paneRef.current) s.bindSections(paneRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 成功提示 4s 后自动清除，失败常驻
  useEffect(() => {
    if (!result || !result.ok) return undefined;
    const t = setTimeout(() => setResult(null), 4000);
    return () => clearTimeout(t);
  }, [result]);

  // 改动都是即存；详情层里的草稿在关层时落库，所以没有面板级脏态
  useEffect(() => {
    if (onDirtyChange) onDirtyChange(false);
  }, [onDirtyChange]);

  const postPrefs = async (body: unknown) => {
    const res = await s.apiFetch('/api/prefs', jsonPost(body));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(s.errText(data, '保存失败'));
    return data;
  };

  /* ---------- 关注 / 屏蔽规则 ---------- */

  const commitRules = async (next: RuleDraft[]) => {
    setBusy('rules');
    try {
      const data = await postPrefs({ watchRules: toServer(next) });
      const saved = fromServer(data.watchRules);
      setRules(saved);
      return { ok: true, saved, dropped: next.length - saved.length };
    } catch (e) {
      return { ok: false, error: (e as Error).message || String(e) };
    } finally {
      setBusy('');
    }
  };

  const restoreRules = async (prev: RuleDraft[], msg: string) => {
    const out = await commitRules(prev);
    if (out.ok) s.toast(msg);
    else s.toast('撤销失败：' + out.error, false);
  };

  const openRule = (r: RuleDraft | null, isNew: boolean) => {
    guard.mark(); // 用户已进入规则草稿编辑
    setSheet({ type: 'rule', value: isNew ? blankRule() : r!, isNew });
  };

  const saveRuleDraft = async (draft: RuleDraft) => {
    const exists = rules.some((r) => r.id === draft.id);
    const prev = rules;
    const next = exists ? rules.map((r) => (r.id === draft.id ? draft : r)) : rules.concat([draft]);
    const out = await commitRules(next);
    if (!out.ok) {
      s.toast('保存失败：' + out.error, false);
      return;
    }
    setSheet(null);
    if ((out.dropped || 0) > 0) {
      s.toast('关键词为空，这条规则没有保存', false);
      return;
    }
    s.toast(
      exists ? '规则已保存，只对之后新抓取的文章生效' : '规则已添加，只对之后新抓取的文章生效',
      true,
      {
        actionText: '撤销',
        ms: 6000,
        action: () => restoreRules(prev, exists ? '已撤销修改' : '已撤销添加'),
      },
    );
  };

  const deleteRule = async (r: RuleDraft) => {
    const okGo = await s.confirm({
      title: `删除规则「${ruleName(r)}」？`,
      desc: '只影响以后新抓取的文章判定；已入库文章上的关注 / 屏蔽标记不变。',
      confirmText: '删除',
      danger: true,
    });
    if (!okGo) return;
    const prev = rules;
    const out = await commitRules(rules.filter((x) => x.id !== r.id));
    if (!out.ok) {
      s.toast('删除失败：' + out.error, false);
      return;
    }
    setSheet(null);
    s.toast('规则已删除', true, {
      actionText: '撤销',
      ms: 6000,
      action: () => restoreRules(prev, '已恢复规则'),
    });
  };

  const toggleRule = async (r: RuleDraft, on: boolean) => {
    const prev = rules;
    const out = await commitRules(
      rules.map((x) => (x.id === r.id ? Object.assign({}, x, { on }) : x)),
    );
    if (!out.ok) {
      s.toast('保存失败：' + out.error, false);
      return;
    }
    s.toast(`${ruleName(r)} 已${on ? '启用' : '停用'}`, true, {
      actionText: '撤销',
      ms: 6000,
      action: () => restoreRules(prev, '已撤销'),
    });
  };

  const onApply = async () => {
    if (sheet) {
      s.toast('先关闭正在编辑的规则', false);
      return;
    }
    const okGo = await s.confirm({
      title: '把规则应用到已有文章？',
      desc: '会按当前规则重新判定全部已有文章：命中关注规则的加入「关注」，命中屏蔽规则的标为「屏蔽」并自动标为已读。',
      confirmText: '应用',
    });
    if (!okGo) return;
    setBusy('apply');
    try {
      const res = await s.apiFetch('/api/watch/apply', { method: 'POST' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setResult({ ok: false, msg: s.errText(d, '应用失败') });
        return;
      }
      setResult({
        ok: true,
        msg: `已回溯：重新判定 ${d.tagged} 篇，关注命中 ${d.watching} 篇、屏蔽命中 ${d.blocked} 篇（清除旧标记 ${d.cleared} 条）。`,
      });
      // 侧栏的关注 / 屏蔽计数变了，让频道栏重新拉一遍
      if (s.loadFeeds) await s.loadFeeds();
    } catch (err) {
      setResult({ ok: false, msg: '应用失败：' + String((err && err.message) || err) });
    } finally {
      setBusy('');
    }
  };

  /* ---------- 入库前过滤 ---------- */

  const commitFilters = async (next: FilterDraft[]) => {
    setBusy('filters');
    try {
      const data = await postPrefs({ filters: next });
      const saved = filtersFromServer(data.filters);
      setFilters(saved);
      return { ok: true, saved, dropped: next.length - saved.length };
    } catch (e) {
      return { ok: false, error: (e as Error).message || String(e) };
    } finally {
      setBusy('');
    }
  };

  const restoreFilters = async (prev: FilterDraft[], msg: string) => {
    const out = await commitFilters(prev);
    if (out.ok) s.toast(msg);
    else s.toast('撤销失败：' + out.error, false);
  };

  const openFilter = (f: FilterDraft | null, isNew: boolean) => {
    guard.mark(); // 用户已进入过滤草稿编辑
    setSheet({ type: 'filter', value: isNew ? blankFilter() : f!, isNew });
  };

  const saveFilterDraft = async (draft: FilterDraft) => {
    const exists = filters.some((f) => f.id === draft.id);
    const prev = filters;
    const next = exists
      ? filters.map((f) => (f.id === draft.id ? draft : f))
      : filters.concat([draft]);
    const out = await commitFilters(next);
    if (!out.ok) {
      s.toast('保存失败：' + out.error, false);
      return;
    }
    setSheet(null);
    if ((out.dropped || 0) > 0) {
      s.toast('匹配模式为空或非法，这条规则没有保存', false);
      return;
    }
    s.toast(exists ? '过滤规则已保存' : '过滤规则已添加，对之后新抓取的文章生效', true, {
      actionText: '撤销',
      ms: 6000,
      action: () => restoreFilters(prev, exists ? '已撤销修改' : '已撤销添加'),
    });
  };

  const deleteFilter = async (f: FilterDraft) => {
    const okGo = await s.confirm({
      title: `删除过滤规则「${f.pattern || '未命名'}」？`,
      desc: '只影响以后新抓取的文章，已入库的历史文章不动。',
      confirmText: '删除',
      danger: true,
    });
    if (!okGo) return;
    const prev = filters;
    const out = await commitFilters(filters.filter((x) => x.id !== f.id));
    if (!out.ok) {
      s.toast('删除失败：' + out.error, false);
      return;
    }
    setSheet(null);
    s.toast('过滤规则已删除', true, {
      actionText: '撤销',
      ms: 6000,
      action: () => restoreFilters(prev, '已恢复规则'),
    });
  };

  const toggleFilter = async (f: FilterDraft, on: boolean) => {
    const prev = filters;
    const out = await commitFilters(
      filters.map((x) => (x.id === f.id ? Object.assign({}, x, { on }) : x)),
    );
    if (!out.ok) {
      s.toast('保存失败：' + out.error, false);
      return;
    }
    s.toast(`${f.pattern || '过滤规则'} 已${on ? '启用' : '停用'}`, true, {
      actionText: '撤销',
      ms: 6000,
      action: () => restoreFilters(prev, '已撤销'),
    });
  };

  /* ---------- Webhook / 关注保留天数：失焦即提交 ---------- */

  const commitWebhook = async () => {
    const next = webhook.trim();
    if (next === savedWebhook) {
      setWebhook(savedWebhook);
      return;
    }
    setBusy('webhook');
    try {
      const data = await postPrefs({ webhookUrl: next });
      const w = typeof data.webhookUrl === 'string' ? data.webhookUrl : '';
      const prev = savedWebhook;
      setWebhook(w);
      setSavedWebhook(w);
      s.toast(
        w ? 'Webhook 已保存，关注规则命中的新文章会推送到这个地址' : 'Webhook 已清空，不再推送通知',
        true,
        {
          actionText: '撤销',
          ms: 6000,
          action: async () => {
            try {
              const back = await postPrefs({ webhookUrl: prev });
              const pw = typeof back.webhookUrl === 'string' ? back.webhookUrl : '';
              setWebhook(pw);
              setSavedWebhook(pw);
              s.toast('已撤销');
            } catch (e) {
              s.toast('撤销失败：' + (e.message || e), false);
            }
          },
        },
      );
    } catch (e) {
      setWebhook(savedWebhook);
      setResult({ ok: false, msg: 'Webhook 保存失败：' + (e.message || e) });
    } finally {
      setBusy('');
    }
  };

  const commitExpire = async () => {
    const days = normalizeDays(expireDays);
    setExpireDays(String(days));
    if (String(days) === savedExpireDays) return;
    setBusy('expire');
    try {
      const data = await postPrefs({ watchExpireDays: days });
      const nd = Number.isFinite(Number(data.watchExpireDays))
        ? String(Number(data.watchExpireDays))
        : String(days);
      const prev = Number(savedExpireDays);
      setExpireDays(nd);
      setSavedExpireDays(nd);
      s.toast(`关注保留 ${Number(nd) === 0 ? '永久' : nd + ' 天'}`, true, {
        actionText: '撤销',
        ms: 6000,
        action: async () => {
          try {
            const back = await postPrefs({ watchExpireDays: prev });
            const bd = Number.isFinite(Number(back.watchExpireDays))
              ? String(Number(back.watchExpireDays))
              : String(prev);
            setExpireDays(bd);
            setSavedExpireDays(bd);
            s.toast('已撤销');
          } catch (e) {
            s.toast('撤销失败：' + (e.message || e), false);
          }
        },
      });
    } catch (e) {
      setExpireDays(savedExpireDays);
      setResult({ ok: false, msg: '保存失败：' + (e.message || e) });
    } finally {
      setBusy('');
    }
  };

  // 视图层直接写这两个输入；包一层 mark，让晚到的首包不能覆盖用户输入。
  const markWebhook: typeof setWebhook = (v) => {
    guard.mark();
    setWebhook(v);
  };
  const markExpireDays: typeof setExpireDays = (v) => {
    guard.mark();
    setExpireDays(v);
  };

  return {
    rules,
    filters,
    webhook,
    setWebhook: markWebhook,
    expireDays,
    setExpireDays: markExpireDays,
    loaded,
    busy,
    result,
    prefsError,
    sheet,
    setSheet,
    feedsList,
    groupOrder,
    paneRef,
    loadPrefs,
    openRule,
    toggleRule,
    saveRuleDraft,
    deleteRule,
    onApply,
    openFilter,
    toggleFilter,
    saveFilterDraft,
    deleteFilter,
    commitWebhook,
    commitExpire,
  };
}

export type WatchController = ReturnType<typeof useWatchController>;
