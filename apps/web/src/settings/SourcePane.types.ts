/* 数据源面板的共享类型：从 SourcePane.tsx 抽出。 */

import type { EntityId, Feed } from '../core/types.ts';

/** groupFeeds 的分组形状：feeds 由 Map.get 取得，理论可空（旧代码用 `(g.feeds || [])` 兜底）。 */
export type FeedGroup = { name: string; feeds: Feed[] | undefined };
/** 单频道 PATCH 的补丁：keys 来自动态字段名，值随字段而变。 */
export type FeedPatch = Record<string, unknown>;
/** 删除撤销快照。 */
export type FeedSnapshot = {
  url: string;
  enabled: boolean;
  cardEnabled: boolean;
  groupName: string;
  fullText: boolean;
  refreshMinutes: number | null;
  customTitle: string | null;
};
/** 拖拽上下文（feed 行 / 分组头共用）。 */
export type DragKind = 'feed' | 'group';
export type DropTarget = {
  type: 'head' | 'row' | 'group';
  id: string;
  group: string;
  before: boolean;
} | null;
export type DragCtx = {
  kind: DragKind;
  id: string;
  group: string;
  el: HTMLElement;
  x0: number;
  y0: number;
  moved: boolean;
  target: DropTarget;
};
export type Cfg = Record<string, string>;
export type FeedResult = { ok: boolean; msg: string } | null;
/** 详情层快捷开关能切的真实字段（都是 Feed 上的布尔字段）。 */
export type ToggleKey = 'enabled' | 'cardEnabled' | 'fullText';
/** 拖拽手柄传入的标识：频道行给 id，分组头给 group。 */
export type GripPayload = { id?: EntityId | string; group?: string };
