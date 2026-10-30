import { api } from './api';

/** 类型一律从客户端方法推导，避免前端再手抄一份接口形状（契约唯一真相源）。 */
export type Session = Awaited<ReturnType<typeof api.session>>;
export type FeedsList = Awaited<ReturnType<typeof api.feeds.list>>;
export type Feed = FeedsList['feeds'][number];
