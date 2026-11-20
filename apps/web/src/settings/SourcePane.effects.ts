/* 数据源面板的副作用：脏态上报、进入面板拉列表、分组区块绑定。从 SourcePane.controller.ts 抽出。 */
import type { RefObject } from 'react';
import { useEffect, useState } from 'react';
import { S } from './SourcePane.utils.ts';

/** 列表加载态与拉取失败态由本 hook 维护；其余副作用自洽。 */
export function useSourcePanelEffects(opts: {
  admin: boolean;
  bump: () => void;
  pushSummary: () => void;
  paneRef: RefObject<HTMLDivElement | null>;
  sourceDirty: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { admin, bump, pushSummary, paneRef, sourceDirty, onDirtyChange } = opts;
  const [loadError, setLoadError] = useState('');
  const [feedsLoading, setFeedsLoading] = useState(true);

  useEffect(() => {
    if (onDirtyChange) onDirtyChange(sourceDirty);
  }, [sourceDirty, onDirtyChange]);

  // 进入面板：拉频道列表（走桥，同步共享 state 与侧栏）；间隔刚可能被改过，重启定时器（同旧实现）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setFeedsLoading(true);
      try {
        await S().loadFeeds();
        if (cancelled) return;
        setLoadError('');
      } catch (err) {
        if (!cancelled) {
          setLoadError(String((err && err.message) || err));
          setFeedsLoading(false);
        }
        return;
      }
      setFeedsLoading(false);
      bump();
      pushSummary();
      const s = S();
      if (s.scheduleAutoRefresh) s.scheduleAutoRefresh();
    })();
    return () => {
      cancelled = true;
    };
  }, [bump, pushSummary]);

  // 可折叠分组：套上按账号记住的开合状态并监听变化（与旧 bindSections 同一机制）
  useEffect(() => {
    const s = S();
    if (s && s.bindSections && paneRef.current) s.bindSections(paneRef.current);
  }, [admin]);

  return { loadError, feedsLoading };
}
