/* 应用状态真源（Zustand）。
 *
 * 迁移前，全局状态是一个裸可变对象 `core/state.ts#state`，跨模块原地读写、
 * 靠 emit(tick) 通知 React 重绘。这里把它搬进 Zustand vanilla store：
 *  - store 是唯一真源；`state` 变成指向 store 的 Proxy，所有旧读写零改动继续工作；
 *  - 组件可用 useApp selector 订阅，Zustand 只重渲染关心该切片的组件；
 *  - 测试网用可注入的桩 core（其 state 是普通对象），完全不经过本模块，故行为测试不受影响。
 *
 * 初始字段逐字来自旧 state.ts，语义不变。 */

import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { AppState } from '../core/types.ts';

export type { AppState };

const initial: AppState = {
  entries: [],
  offset: 0,
  hasMore: true,
  total: 0,
  loading: false,
  loadError: false,
  loadMoreErr: false,
  loadMoreErrMsg: '',
  listEpoch: 0,
  q: '',
  sort: 'new',
  tag: null,
  aiTag: null,
  view: 'grid',
  pageSize: 50,
  readerPageSize: 40,
  tagline: '拾取值得读的',
  feedFilter: null,
  cardGroup: null,
  feedList: null,
  feedMeta: null,
  groupOrder: [],
  collapsedGroups: new Set(),
  srcGroupsOpen: [],
  tags: [],
  username: null,
  role: null,
  tab: 'reader',
  rdScope: 'all',
  rdFeedId: null,
  rdGroup: null,
  rdWatch: null,
  rdQ: '',
  rdTag: null,
  rdAiTag: null,
  rdFlags: { total: 0, unread: 0, favorite: 0, watching: 0, blocked: 0 },
  rdEntries: [],
  rdOffset: 0,
  rdHasMore: true,
  rdTotal: 0,
  rdLoading: false,
  rdLoadMoreErr: false,
  rdCollapsedGroups: [],
  rdExpanded: new Set(),
  rdBody: new Map(),
  rdBodyErr: new Set(),
  rdReadError: false,
  rdReadErrorMsg: '',
  rdFlashId: null,
};

/** 唯一状态容器。core 层与组件层共享同一实例。 */
export const appStore = createStore<AppState>(() => ({ ...initial }));

/**
 * 与旧 `state` 对象完全同形的 Proxy：读写入口都转到 store。
 * 这样 core 里 152 处写入、428 处读取一个字都不用改，行为逐字一致。
 * 原地修改（push/add/set）改的是 store 里的同一个引用，引用不变 —— core 层
 * 在修改后照旧 emit(tick)，React 侧靠事件刷新，语义与迁移前完全相同。
 */
export const state: AppState = new Proxy({} as AppState, {
  get(_t, key) {
    return appStore.getState()[key as keyof AppState];
  },
  set(_t, key, value) {
    appStore.setState({ [key as string]: value } as Partial<AppState>);
    return true;
  },
  has(_t, key) {
    return key in appStore.getState();
  },
  ownKeys() {
    return Reflect.ownKeys(appStore.getState());
  },
  getOwnPropertyDescriptor(_t, key) {
    return {
      enumerable: true,
      configurable: true,
      value: appStore.getState()[key as keyof AppState],
    };
  },
});

/** React 订阅入口：只重渲染关心该切片的组件。selector 须返回稳定引用或原始值。 */
export function useApp<T>(selector: (s: AppState) => T): T {
  return useStore(appStore, selector);
}

/** 命令式读取（事件回调、非 React 模块）。 */
export function readApp<T>(selector: (s: AppState) => T): T {
  return selector(appStore.getState());
}
