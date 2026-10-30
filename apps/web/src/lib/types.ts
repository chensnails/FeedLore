import { api } from './api';

/**
 * 类型一律从客户端方法推导，前端不手抄接口形状（契约唯一真相源）。
 * 服务端改字段时这里跟着变，用错的地方立刻 tsc 报错。
 */
export type Session = Awaited<ReturnType<typeof api.session>>;
export type FeedsList = Awaited<ReturnType<typeof api.feeds.list>>;
export type Feed = FeedsList['feeds'][number];
export type EntriesList = Awaited<ReturnType<typeof api.entries.list>>;
export type EntryCard = EntriesList['entries'][number];
export type EntryFull = Awaited<ReturnType<typeof api.entries.detail>>;
export type Prefs = Awaited<ReturnType<typeof api.prefs.get>>;
