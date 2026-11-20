/* 数据源面板：频道增删 / 行级动作 / 配置保存 / 图片缓存。从 SourcePane.controller.ts 抽出，逐字对齐。 */
import type * as React from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { EntityId, Feed } from '../core/types.ts';
import type { Cfg, FeedResult, FeedSnapshot, ToggleKey } from './SourcePane.types.ts';
import { fmtMinutes, jsonPost, patchInit, S, snapshotFeed } from './SourcePane.utils.ts';

type ImgStats = { count: number; bytes: number };
type CfgGuard = { mark: () => void };

/** 全部频道级动作。基础回调（reloadFeeds/patchFeed/patchWithUndo/bump）由主 controller 传入。 */
export function useSourceActions(opts: {
  cfg: Cfg;
  cfgLoaded: boolean;
  setCfg: Dispatch<SetStateAction<Cfg>>;
  setSavedCfg: Dispatch<SetStateAction<string>>;
  cfgGuard: CfgGuard;
  imgStats: ImgStats;
  setImgStats: Dispatch<SetStateAction<ImgStats>>;
  sheetId: EntityId | null;
  setSheetId: Dispatch<SetStateAction<EntityId | null>>;
  reloadFeeds: () => Promise<void>;
  patchFeed: (
    id: EntityId,
    patch: Record<string, unknown>,
    okMsg: string | null,
  ) => Promise<unknown>;
  patchWithUndo: (
    f: Feed,
    patch: Record<string, unknown>,
    prevPatch: Record<string, unknown>,
    okMsg: string,
  ) => Promise<void>;
  bump: () => void;
}) {
  const {
    cfg,
    cfgLoaded,
    setCfg,
    setSavedCfg,
    cfgGuard,
    imgStats,
    setImgStats,
    sheetId,
    setSheetId,
    reloadFeeds,
    patchFeed,
    patchWithUndo,
    bump,
  } = opts;

  const [url, setUrl] = useState('');
  const [result, setResult] = useState<FeedResult>(null);
  const [busy, setBusy] = useState('');
  const [busyFeed, setBusyFeed] = useState<EntityId | ''>('');
  const urlRef = useRef<HTMLInputElement>(null);

  // 成功提示 4 秒后自动淡出（复刻旧 showResult 的 ok 态行为）
  useEffect(() => {
    if (!result || !result.ok) return;
    const t = setTimeout(() => setResult(null), 4000);
    return () => clearTimeout(t);
  }, [result]);

  const onAdd = async () => {
    const u = url.trim();
    if (!u) {
      setResult({ ok: false, msg: '请先填入 RSS 地址' });
      if (urlRef.current) urlRef.current.focus();
      return;
    }
    const s = S();
    setBusy('add');
    setResult(null);
    try {
      // 30 秒兜底：添加订阅要等服务端去抓一次，遇到慢站或死站会一直挂着，
      // 按钮永远停在「添加中…」，用户既不知道还要等多久也不知道是不是卡了。
      const res = await s.apiFetch(
        '/api/feeds',
        Object.assign(jsonPost({ url: u }), { signal: AbortSignal.timeout(30000) }),
      );
      const data = await res.json();
      if (!res.ok) {
        setResult({ ok: false, msg: s.errText(data, '添加失败') });
        return;
      }
      setUrl('');
      setResult({
        ok: true,
        msg: `已添加「${s.shortFeedName(s.feedTitle(data.feed))}」，新增 ${data.added} 条`,
      });
      s.toast('订阅已添加');
      await reloadFeeds();
      s.state.tag = null;
      if (s.loadPage) await s.loadPage(true);
    } catch (err) {
      const timedOut = !!(err && (err.name === 'TimeoutError' || err.name === 'AbortError'));
      setResult({
        ok: false,
        msg: timedOut
          ? '抓取超时（30 秒）：这个地址可能太慢或没有响应'
          : '添加失败：' + (err.message || err),
      });
    } finally {
      setBusy('');
    }
  };

  const onImport = async (ev: React.ChangeEvent<HTMLInputElement>) => {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = ''; // 允许重新选择同一文件
    if (!file) return;
    const s = S();
    setBusy('import');
    try {
      const text = await file.text();
      const res = await s.apiFetch('/api/feeds/import', jsonPost({ opml: text }));
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(s.errText(data, '导入失败'));
      const parts = [`已导入 ${data.added} 个新频道`];
      if (data.duplicated) parts.push(`跳过 ${data.duplicated} 个重复`);
      if (data.groups && data.groups.length) parts.push(`${data.groups.length} 个分组`);
      setResult({ ok: true, msg: parts.join(' · ') });
      await reloadFeeds();
    } catch (err) {
      setResult({ ok: false, msg: '导入失败：' + (err.message || err) });
    } finally {
      setBusy('');
    }
  };

  const onRefreshFeed = async (id: EntityId) => {
    const s = S();
    setBusyFeed(id);
    try {
      const res = await s.apiFetch('/api/feeds/' + id + '/refresh', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.ok)
        throw new Error(s.errText((data.result && data.result.error) || data.error, '抓取失败'));
      s.toast(data.result.added ? `新增 ${data.result.added} 条` : '没有新内容');
      await reloadFeeds();
      if (s.loadPage) await s.loadPage(true);
    } catch (err) {
      s.toast('抓取失败：' + (err.message || err), false);
    } finally {
      setBusyFeed('');
    }
  };

  /** 删除撤销：按快照重建订阅（POST 会立即抓一次），再补回个性化字段。
   *  条目是重新抓的，已读 / 收藏状态回不来——确认框文案里已明说。 */
  const restoreFeed = useCallback(async (snap: FeedSnapshot) => {
    const s = S();
    const res = await s.apiFetch(
      '/api/feeds',
      jsonPost({
        url: snap.url,
        enabled: snap.enabled,
        cardEnabled: snap.cardEnabled,
        groupName: snap.groupName,
      }),
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(s.errText(data, '恢复失败'));
    if (!data.existed && data.feed) {
      const extra: Record<string, unknown> = {};
      if (snap.fullText) extra.fullText = true;
      if (snap.refreshMinutes != null) extra.refreshMinutes = snap.refreshMinutes;
      if (snap.customTitle) extra.title = snap.customTitle;
      if (Object.keys(extra).length)
        await s.apiFetch('/api/feeds/' + data.feed.id, patchInit(extra));
    }
  }, []);

  const onDelete = async (f: Feed) => {
    const s = S();
    const name = s.shortFeedName(s.feedTitle(f));
    const ok = await s.confirm({
      title: `删除订阅「${name}」？`,
      desc: '该频道已抓取的条目会一并删除。撤销可恢复订阅，但条目需重新抓取，已读 / 收藏状态会丢失。',
      confirmText: '删除订阅',
      danger: true,
    });
    if (!ok) return;
    const snap = snapshotFeed(f);
    try {
      const res = await s.apiFetch('/api/feeds/' + f.id, { method: 'DELETE' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      if (sheetId != null && String(sheetId) === String(f.id)) setSheetId(null);
      await reloadFeeds();
      s.state.tag = null;
      if (s.loadPage) await s.loadPage(true);
      s.toast('订阅已删除', true, {
        actionText: '撤销',
        ms: 6000,
        action: async () => {
          try {
            await restoreFeed(snap);
            await reloadFeeds();
            if (s.loadPage) await s.loadPage(true);
            s.toast('已恢复订阅');
          } catch (e) {
            s.toast('撤销失败：' + (e.message || e), false);
          }
        },
      });
    } catch (err) {
      s.toast('删除失败：' + (err.message || err), false);
    }
  };

  const onSaveCfg = async () => {
    if (!cfgLoaded) {
      setResult({ ok: false, msg: '设置尚未加载完成，请稍后再试' });
      return;
    }
    const s = S();
    setBusy('save');
    try {
      // v2 契约全是整数：输入框存的是字符串，提交前统一转数字（空串按 0，由服务端夹取）
      const num = (v: unknown) => Number(v) || 0;
      const res = await s.apiFetch(
        '/api/config',
        jsonPost({
          source: {
            refreshMinutes: num(cfg.refreshMinutes),
            keepPerFeed: num(cfg.keepPerFeed),
            keepDays: num(cfg.keepDays),
            timeoutSeconds: num(cfg.timeoutSeconds),
            concurrency: num(cfg.concurrency),
            autoRefreshMinutes: num(cfg.autoRefreshMinutes),
            proxyUrl: cfg.proxyUrl,
            imgTtlDays: num(cfg.imgTtlDays),
            imgKeepDays: num(cfg.imgKeepDays),
            imgMaxDim: num(cfg.imgMaxDim),
            imgQuality: num(cfg.imgQuality),
            feedFailLimit: num(cfg.feedFailLimit),
          },
        }),
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setResult({ ok: false, msg: s.errText(data, '保存失败') });
        return;
      }
      // 表单保存只用内联结果，不再叠一层 toast（列表级动作才用 toast）
      setResult({ ok: true, msg: '抓取设置已保存' });
      setSavedCfg(JSON.stringify(cfg));
      if (s.scheduleAutoRefresh) s.scheduleAutoRefresh(); // 立刻按新的「页面自动刷新」间隔重排
    } catch (err) {
      setResult({ ok: false, msg: '保存失败：' + (err.message || err) });
    } finally {
      setBusy('');
    }
  };

  /** 清空图片缓存（v2.4.0）：删库 + 清 L1，下次访问按新压缩参数重新缓存 */
  const onClearImgCache = async () => {
    const s = S();
    const n = Number(imgStats.count) || 0;
    const ok = await s.confirm({
      title: `清空图片缓存（${n} 张）？`,
      desc: '已缓存的图片会从库里删除，下次浏览时按当前压缩参数重新缓存。',
      confirmText: '清空缓存',
      danger: true,
    });
    if (!ok) return;
    setBusy('imgclear');
    try {
      const res = await s.apiFetch('/api/image-cache/clear', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(s.errText(data, 'HTTP ' + res.status));
      setImgStats({ count: 0, bytes: 0 });
      s.toast(`已清空 ${data.removed} 张缓存图片`);
    } catch (err) {
      s.toast('清空失败：' + (err.message || err), false);
    } finally {
      setBusy('');
    }
  };

  /* ---- 行级 / 详情层动作：即改即生效 + 撤销 ---- */
  const onToggle = async (f: Feed, key: ToggleKey, next: boolean, okMsg: string) => {
    await patchWithUndo(f, { [key]: next }, { [key]: f[key] }, okMsg);
  };

  const onCommitName = useCallback(
    async (f: Feed, raw: string) => {
      const s = S();
      const val = String(raw == null ? '' : raw)
        .trim()
        .slice(0, 200);
      if (val === s.feedTitle(f)) return; // 没变
      if (!val && !f.customTitle) return; // 本来就是原标题，无需清空
      await patchWithUndo(
        f,
        { title: val },
        { title: f.customTitle || '' },
        val ? '名称已更新' : '已恢复原标题',
      );
    },
    [patchWithUndo],
  );

  /* 改订阅地址：校验与「同用户 URL 唯一」判重都在后端（与新增共用 rss.assertFeedUrl）。
   * 服务端改完会按新地址当场试抓一次，结果走 probe 反馈；地址变更不做撤销（试抓有副作用）。 */
  const onCommitUrl = useCallback(
    async (f: Feed, raw: string) => {
      const s = S();
      const val = String(raw == null ? '' : raw).trim();
      if (!val || val === f.url) return;
      try {
        const data = (await patchFeed(f.id, { url: val }, '订阅地址已更新')) as {
          probe?: { ok: boolean; added?: number };
        } | null;
        const probe = data && data.probe;
        if (!probe) return;
        if (!probe.ok)
          s.toast(
            '新地址抓取失败：' + s.errText(probe, '未知错误') + '（地址已保存，下个周期自动重试）',
            false,
          );
        else if (probe.added) s.toast('新地址可用：本次新增 ' + probe.added + ' 条');
      } catch (err) {
        bump();
        s.toast('地址未更新：' + (err.message || err), false);
      }
    },
    [patchFeed, bump],
  );

  const onCommitGroup = useCallback(
    async (f: Feed, raw: string) => {
      const val = String(raw == null ? '' : raw)
        .trim()
        .slice(0, 40);
      if (val === (f.groupName || '')) return;
      await patchWithUndo(
        f,
        { groupName: val },
        { groupName: f.groupName || '' },
        val ? `已归入「${val}」` : '已移出分组',
      );
    },
    [patchWithUndo],
  );

  const onFreqChange = useCallback(
    async (f: Feed, next: number | null) => {
      const cur = f.refreshMinutes == null ? null : Number(f.refreshMinutes);
      if (cur === next) return;
      await patchWithUndo(
        f,
        { refreshMinutes: next },
        { refreshMinutes: cur },
        next == null ? '已改为跟随全局频率' : `该频道已设为每 ${fmtMinutes(next)}抓取`,
      );
    },
    [patchWithUndo],
  );

  const setCfgField = (k: keyof Cfg) => (ev: React.ChangeEvent<HTMLInputElement>) => {
    cfgGuard.mark();
    setCfg((c) => Object.assign({}, c, { [k]: ev.target.value }));
  };
  // 自绘 Dropdown 的 onChange 直接给值（不是 event），与 input 的 setCfgField 分开。
  const setCfgVal = (k: keyof Cfg) => (v: string | number) => {
    cfgGuard.mark();
    setCfg((c) => Object.assign({}, c, { [k]: String(v) }));
  };

  return {
    url,
    setUrl,
    result,
    setResult,
    urlRef,
    busy,
    setBusy,
    busyFeed,
    sheetId,
    setSheetId,
    onAdd,
    onImport,
    onRefreshFeed,
    restoreFeed,
    onDelete,
    onSaveCfg,
    onClearImgCache,
    onToggle,
    onCommitName,
    onCommitUrl,
    onCommitGroup,
    onFreqChange,
    setCfgField,
    setCfgVal,
  };
}
