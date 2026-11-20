/* 频道详情层：从 SourcePane.tsx 抽出，输入框 defaultValue + key 的语义与 DOM 逐字对齐。 */

import type * as React from 'react';
import { useRef } from 'react';
import type { EntityId, Feed } from '../core/types.ts';
import { Dropdown } from '../views/Dropdown.tsx';
import { DetailSheet } from './DetailSheet.tsx';
import { FREQ_OPTIONS } from './SourcePane.constants.ts';
import { Ico } from './SourcePane.parts.tsx';
import type { ToggleKey } from './SourcePane.types.ts';
import { feedStatusText, fmtMinutes, prettyUrl, S } from './SourcePane.utils.ts';

export type FeedSheetProps = {
  feed: Feed;
  order: number;
  globalMins: number;
  groupNames: string[];
  busyFeed: EntityId | '';
  pending: boolean;
  onClose: () => void;
  onToggle: (feed: Feed, key: ToggleKey, next: boolean, okMsg: string) => void;
  onFreq: (feed: Feed, next: number | null) => void;
  onOrder: (id: EntityId, pos: number) => void;
  onName: (feed: Feed, raw: string) => void;
  onUrl: (feed: Feed, raw: string) => void;
  onGroup: (feed: Feed, raw: string) => void;
  onRefresh: (id: EntityId) => void;
  onDelete: (feed: Feed) => void;
};

export function FeedSheet({
  feed,
  order,
  globalMins,
  groupNames,
  busyFeed,
  pending,
  onClose,
  onToggle,
  onFreq,
  onOrder,
  onName,
  onUrl,
  onGroup,
  onRefresh,
  onDelete,
}: FeedSheetProps) {
  const s = S();
  const nameRef = useRef<HTMLInputElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const groupRef = useRef<HTMLInputElement>(null);
  const name = s.shortFeedName(s.feedTitle(feed));

  const editKeys = (resetVal: string) => (ev: React.KeyboardEvent<HTMLInputElement>) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      ev.currentTarget.blur();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.currentTarget.value = resetVal;
      ev.currentTarget.blur();
    }
  };

  const commitOrder = (ev: React.FocusEvent<HTMLInputElement>) => {
    const pos = parseInt(ev.target.value, 10);
    if (!Number.isFinite(pos) || pos < 1) {
      ev.target.value = String(order);
      return;
    }
    if (pos !== order) onOrder(feed.id, pos);
  };

  const swRow = (
    key: ToggleKey,
    label: string,
    desc: string,
    checked: boolean,
    okOn: string,
    okOff: string,
    dataAttr: string,
  ) => (
    <label className="ds-sw-row">
      <span className="ds-sw-txt">
        <span className="ds-sw-name">{label}</span>
        <span className="ds-sw-desc">{desc}</span>
      </span>
      <span className="switch">
        <input
          type="checkbox"
          {...{ [dataAttr]: feed.id }}
          aria-label={label}
          checked={checked}
          disabled={pending}
          onChange={
            /** @param {*} [ev] */ (ev) =>
              onToggle(feed, key, ev.target.checked, ev.target.checked ? okOn : okOff)
          }
        />
        <span className="switch-slider" />
      </span>
    </label>
  );

  return (
    <DetailSheet
      title={name}
      subtitle={prettyUrl(feed.url)}
      onClose={onClose}
      foot={
        <>
          <button
            className="btn"
            type="button"
            disabled={busyFeed === feed.id}
            onClick={() => onRefresh(feed.id)}
          >
            {busyFeed === feed.id ? '抓取中…' : '立即抓取'}
          </button>
          <button
            className="btn btn-danger"
            type="button"
            disabled={pending}
            onClick={() => onDelete(feed)}
          >
            删除订阅
          </button>
        </>
      }
    >
      <div className="ds-stat">
        <div className="ds-stat-line">{feedStatusText(feed)}</div>
        {feed.status === 'error' ? (
          <div className="ds-stat-line err">
            <Ico name="alert" /> {s.errText(feed.error)}
          </div>
        ) : null}
      </div>

      <div className="form-row">
        <label htmlFor="dsName">名称</label>
        <input
          id="dsName"
          key={'n-' + (feed.customTitle || '')}
          ref={nameRef}
          type="text"
          maxLength={200}
          spellCheck={false}
          autoComplete="off"
          data-sheet-title={feed.id}
          defaultValue={s.feedTitle(feed)}
          onBlur={() => onName(feed, nameRef.current ? nameRef.current.value : '')}
          onKeyDown={editKeys(s.feedTitle(feed))}
        />
        <small className="form-tip">改完即保存；清空可恢复订阅源原标题</small>
      </div>

      <div className="form-row">
        <label htmlFor="dsUrl">订阅地址</label>
        <input
          id="dsUrl"
          key={'u-' + feed.url}
          ref={urlRef}
          type="text"
          inputMode="url"
          maxLength={600}
          spellCheck={false}
          autoComplete="off"
          data-sheet-url={feed.id}
          defaultValue={feed.url}
          onBlur={() => onUrl(feed, urlRef.current ? urlRef.current.value : '')}
          onKeyDown={editKeys(feed.url)}
        />
        <small className="form-tip">
          需以 http:// 或 https:// 开头，改完会立即按新地址试抓一次
        </small>
      </div>

      <div className="form-row">
        <label htmlFor="dsGroup">分组</label>
        <div className="input-with-btn">
          {/* 保留手填「输入新名即建组」；候选用自绘 Dropdown，不用 datalist
              （Android Chrome 把多项 datalist 渲染成一排空心胶囊，真机不可用）。 */}
          <input
            id="dsGroup"
            key={'g-' + (feed.groupName || '')}
            ref={groupRef}
            type="text"
            maxLength={40}
            spellCheck={false}
            autoComplete="off"
            placeholder="未分组"
            data-sheet-group={feed.id}
            defaultValue={feed.groupName || ''}
            onBlur={() => onGroup(feed, groupRef.current ? groupRef.current.value : '')}
            onKeyDown={editKeys(feed.groupName || '')}
          />
          {groupNames.length ? (
            <Dropdown
              id="dsGroupPick"
              wrapId="dsGroupDD"
              title="选已有分组"
              ariaLabel="选已有分组"
              valueLabel="选组"
              options={groupNames.map((g) => ({ value: g, label: g }))}
              onChange={(v: string | number) => {
                if (groupRef.current) groupRef.current.value = String(v);
                onGroup(feed, String(v));
              }}
            />
          ) : null}
        </div>
        <small className="form-tip">留空移出分组；输入新名即建组，也可点「选组」挑已有分组</small>
      </div>

      <div className="form-row">
        <label>抓取频率</label>
        <Dropdown
          id="dsFreq"
          wrapId="dsFreqDD"
          title="抓取频率"
          ariaLabel="抓取频率"
          extraClass={'feed-freq' + (feed.refreshMinutes == null ? '' : ' own')}
          dataAttrs={{ 'data-sheet-freq': feed.id }}
          value={feed.refreshMinutes == null ? '' : String(feed.refreshMinutes)}
          disabled={pending}
          onChange={(v: string | number) => onFreq(feed, v === '' ? null : Number(v))}
          options={[
            { value: '', label: `跟随全局（${fmtMinutes(globalMins)}）` },
            ...FREQ_OPTIONS.map(/** @param {*} arr */ ([v, t]) => ({ value: v, label: t })),
          ]}
        />
        <small className="form-tip">未设置则跟随全局自动抓取间隔</small>
      </div>

      <div className="form-row">
        <label htmlFor="dsOrder">组内序号</label>
        <input
          id="dsOrder"
          className="feed-order"
          key={'o-' + order}
          type="number"
          min="1"
          data-sheet-order={feed.id}
          defaultValue={order}
          onBlur={commitOrder}
          onKeyDown={
            /** @param {*} [ev] */ (ev) => {
              if (ev.key === 'Enter') {
                ev.preventDefault();
                ev.currentTarget.blur();
              } else if (ev.key === 'Escape') {
                ev.preventDefault();
                ev.currentTarget.value = String(order);
                ev.currentTarget.blur();
              }
            }
          }
        />
        <small className="form-tip">填数字调整在本组内的顺序（与拖拽并存）</small>
      </div>

      {swRow(
        'enabled',
        '采集',
        '开启后定时抓取这个频道的新条目',
        feed.enabled,
        '已开启采集',
        '已停止采集',
        'data-sheet-toggle',
      )}
      {swRow(
        'cardEnabled',
        '卡片',
        '开启后在「卡片」页展示这个频道的条目',
        feed.cardEnabled,
        '已在卡片页展示',
        '已从卡片页隐藏',
        'data-sheet-card',
      )}
      {swRow(
        'fullText',
        '全文',
        '订阅只给摘要时，抓取原文页面并提取完整正文（会增加抓取耗时）',
        feed.fullText,
        '已开启全文抓取（下轮抓取生效）',
        '已关闭全文抓取',
        'data-sheet-fulltext',
      )}
    </DetailSheet>
  );
}
