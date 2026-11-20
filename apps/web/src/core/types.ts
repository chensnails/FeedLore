/* 前端领域类型底座（V6 any 清零）。
 *
 * 复用 @feedlore/contract 的 DTO 作为「服务端来数」的形状，这里补充只存在于
 * 浏览器侧的视图状态类型（覆盖层、表单草稿、聚合视图模型）。
 *
 * 设计原则：不用 `any` 逃生，也不用无意义断言。动态 JSON 边界统一用
 * `unknown` + 窄化，或显式标记 index 签名 `Record<string, unknown>`。
 * 所有 core 模块与组件从此处 import，类型从源头流向全树。 */

import type {
  AiJob,
  AiJobBody,
  AiUsageResponse,
  Card,
  EntryDetail,
  EntryFlagPatchBody,
  EntryFlags,
  Feed,
  FeedsListResponse,
  TagCount,
} from '@feedlore/contract';

export type {
  AiJob,
  AiJobBody,
  Card,
  EntryDetail,
  EntryFlagPatchBody,
  EntryFlags,
  Feed,
  FeedsListResponse,
  TagCount,
};

/* ---------------- 视图与主题 ---------------- */

export type ViewTab = 'reader' | 'cards' | 'ai';
export type ThemeMode = 'auto' | 'light' | 'dark' | 'github';
export type ViewMode = 'grid' | 'list';
export type SortMode = 'new' | 'old' | 'name';
export type ReaderScope = 'all' | 'unread' | 'favorite';
export type WatchFilter = 'watch' | 'block';

/** 频道 / 条目 id：服务端 bigserial 以数字返回，DOM dataset 侧是字符串。 */
export type EntityId = number | string;

/** 条目标记补丁（已读 / 收藏）。 */
export type EntryFlagPatch = Partial<EntryFlagPatchBody>;

/** AI 轮询 opts（submitAiJob / pollAiJob）。 */
export interface AiPollOpts {
  onStatus?: (job: AiJob) => void;
  isCancelled?: () => boolean;
  maxMs?: number;
}

/** 带任务字段的 Error（超时 / 中止 / 失败时附着 job 供调用方恢复）。 */
export interface AiJobError extends Error {
  job?: AiJob | null;
}

/* ---------------- 应用状态真源 ----------------
 * 逐个字段精确化，替代原 Record<string, any>。字段集合与 store/app.ts#initial 一一对应，
 * 行为逐字不变；仅把「任意形态」收敛为真实取值域。 */

export interface AppState {
  entries: Card[];
  offset: number;
  hasMore: boolean;
  total: number;
  loading: boolean;
  loadError: boolean;
  loadMoreErr: boolean;
  loadMoreErrMsg: string;
  listEpoch: number;
  q: string;
  sort: SortMode;
  tag: string | null;
  aiTag: string | null;
  view: ViewMode;
  pageSize: number;
  readerPageSize: number;
  tagline: string;
  feedFilter: number | string | null;
  cardGroup: string | null;
  feedList: Feed[] | null;
  feedMeta: FeedsListResponse | null;
  groupOrder: string[];
  collapsedGroups: Set<string>;
  srcGroupsOpen: string[];
  tags: TagCount[];
  username: string | null;
  role: 'admin' | 'user' | 'readonly' | null;
  tab: ViewTab;
  rdScope: ReaderScope;
  rdFeedId: number | string | null;
  rdGroup: string | null;
  rdWatch: WatchFilter | null;
  rdQ: string;
  rdTag: string | null;
  rdAiTag: string | null;
  rdFlags: EntryFlags;
  rdEntries: Card[];
  rdOffset: number;
  rdHasMore: boolean;
  rdTotal: number;
  rdLoading: boolean;
  rdLoadMoreErr: boolean;
  rdCollapsedGroups: string[];
  rdExpanded: Set<number | string>;
  rdBody: Map<number | string, EntryDetail>;
  rdBodyErr: Set<number | string>;
  rdReadError: boolean;
  rdReadErrorMsg: string;
  rdFlashId: number | string | null;
}

/* ---------------- 覆盖层状态 ---------------- */

export interface ToastState {
  msg: string;
  ok: boolean;
  show: boolean;
  action: null | (() => void);
  actionText: string;
}

export interface ConfirmInput {
  placeholder?: string;
  type?: string;
}

export interface ConfirmOptions {
  title?: string;
  desc?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  input?: ConfirmInput | null;
}

export interface ConfirmState {
  open: boolean;
  title: string;
  desc: string;
  confirmText: string;
  cancelText: string;
  danger: boolean;
  input: ConfirmInput | null;
}

export interface LightboxState {
  src: string;
  show: boolean;
  list: string[];
  index: number;
}

export interface NewPillState {
  show: boolean;
  text: string;
}

/* ---------------- 请求与响应边界 ---------------- */

/** apiFetch 的 opts：与原生 RequestInit 同形，另加项目的弱网/超时开关。 */
export interface ApiFetchOpts extends RequestInit {
  retry?: boolean;
  timeoutMs?: number;
  skipPasswordGate?: boolean;
}

/** 服务端错误体（失败分支的 res.json()）。 */
export interface ApiErrorBody {
  error: string;
  message?: string;
  [key: string]: unknown;
}

/**  unfurled 的 JSON 值：API 边界处用它替代 any，消费前必须窄化。 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** 已知形状的响应信封，字段按需声明，其余透传。 */
export type ApiObject = Record<string, unknown>;

export type { AiUsageResponse };
