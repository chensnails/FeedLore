/* 单篇「重新抓取」入口：常驻在正文的发布时间行右侧。
 *
 * 只更新当前正文缓存（core.readerRefreshEntry 不碰列表 / 标记），所以刷新一次不会让
 * 文章在列表里跳序。按钮自身负责加载 / 成功 / 失败反馈与防重复点击：
 * busy ref 先于 React 状态生效，连点两下也只发一次 POST。 */

import { core } from '@core';
import { useEffect, useRef, useState } from 'react';
import { errorText } from '../core/errorText.ts';
import type { EntityId } from '../core/types.ts';
import { Icon } from './Icon.tsx';

type RefreshStatus = 'idle' | 'loading' | 'success' | 'error';

export interface EntryRefreshPayload {
  ok: true;
  id: string;
  changed: boolean;
  images: number;
  refreshedAt: string;
  entry: import('../core/types.ts').EntryDetail;
}

interface EntryRefreshButtonProps {
  entryId: EntityId;
  /** 卡片详情等外部宿主可借此触发自己的 refetch；文章页不需要传。 */
  onRefreshed?: (payload: EntryRefreshPayload) => void | Promise<void>;
}

const RESET_MS = 2600;

export function EntryRefreshButton({ entryId, onRefreshed }: EntryRefreshButtonProps) {
  const [status, setStatus] = useState<RefreshStatus>('idle');
  const [message, setMessage] = useState('');
  const busy = useRef(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  const scheduleReset = () => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => {
      setStatus('idle');
      setMessage('');
      resetTimer.current = undefined;
    }, RESET_MS);
  };

  const run = async () => {
    if (busy.current) return;
    busy.current = true;
    if (resetTimer.current) clearTimeout(resetTimer.current);
    setStatus('loading');
    setMessage('正在重新抓取…');
    try {
      const payload = (await core.readerRefreshEntry(entryId)) as EntryRefreshPayload;
      setStatus('success');
      setMessage(payload.changed ? '内容已更新' : '内容没有变化');
      core.toast(payload.changed ? '文章已重新抓取' : '文章已是最新');
      await onRefreshed?.(payload);
    } catch (err) {
      setStatus('error');
      setMessage('刷新失败');
      const detail = err instanceof Error ? err.message : errorText(err, '请稍后重试');
      core.toast('刷新失败：' + detail, false);
    } finally {
      busy.current = false;
      scheduleReset();
    }
  };

  const label =
    status === 'loading'
      ? '正在抓取'
      : status === 'success'
        ? '已更新'
        : status === 'error'
          ? '重试'
          : '重新抓取';
  const icon = status === 'success' ? 'check' : status === 'error' ? 'alert' : 'refresh';

  return (
    <span className="art-refresh-wrap">
      <button
        className="art-refresh"
        type="button"
        data-state={status}
        aria-busy={status === 'loading' ? 'true' : 'false'}
        aria-label="重新抓取这篇文章"
        title="重新拉取订阅源并更新这篇正文"
        disabled={status === 'loading'}
        onClick={(ev) => {
          ev.stopPropagation();
          void run();
        }}
      >
        <Icon n={icon} />
        <span>{label}</span>
      </button>
      {status !== 'idle' && status !== 'loading' ? (
        <span
          className={'art-refresh-msg is-' + status}
          role={status === 'error' ? 'alert' : 'status'}
        >
          {message}
        </span>
      ) : null}
    </span>
  );
}
