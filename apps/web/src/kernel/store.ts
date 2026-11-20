/* 跨 root 的 UI 状态真源（V4.3 / Zustand）。
 *
 * 背景：8 个 createRoot 之间没有共享 Context，历史上靠 window.__* 全局变量互相调用
 * （kernel/bridge.ts 已把读写收口，但底层仍是裸 window 属性）。这里用 Zustand 作为
 * 桥状态的单一真源：provide/get/isOn/revoke 全部转发到 store，并同步镜像回 window.__*
 * —— 首屏内联脚本、jsdom 行为测试与尚未迁移的旧代码仍直接读 window，故镜像必须保留。
 *
 * 迁移价值：React 组件可用 useBridge() 订阅桥状态变化，不再靠 __xxxTick 事件 + get()
 * 轮询快照；Zustand 的选择器订阅天然只重渲染关心该切片的组件。
 *
 * 兼容约束（不可破）：
 *  - BRIDGE 的名字到 window.__* key 映射、未登记即抛错的语义全部留在 bridge.ts；
 *  - 本模块只提供底层存储，不暴露给业务代码直接 import（仍走 bridge.ts 门面）。
 */
import { createStore } from 'zustand/vanilla';

/** 桥值形态各异（布尔开关 / 函数 / 宿主对象），统一用 unknown，消费处窄化。 */
export type BridgeValue = unknown;
export type BridgeState = Record<string, BridgeValue>;

/** 桥状态存储：key 是 window.__* 的原始属性名（如 '__settingsOpen'）。 */
export const bridgeStore = createStore<BridgeState>(() => ({}));

/** 写一个桥值。undefined/null 等价于删除（与 bridge.provide 的语义一致）。 */
export function bridgeSet(key: string, value: BridgeValue) {
  const next = { ...bridgeStore.getState() };
  if (value == null) delete next[key];
  else next[key] = value;
  bridgeStore.setState(next, true);
}

/** 读一个桥值。 */
export function bridgeGet(key: string): BridgeValue {
  return bridgeStore.getState()[key];
}

/** 删除一个桥值。 */
export function bridgeDelete(key: string) {
  const next = { ...bridgeStore.getState() };
  delete next[key];
  bridgeStore.setState(next, true);
}

/* ------------------------------------------------------------------ *
 * React 订阅入口：组件用 useBridge(key) 读桥值，写入仍走 bridge.provide。
 * 用 useSyncExternalStore 直连 Zustand 的 subscribe/getState，与 React 19 并发渲染兼容。
 * 放在单独导出里，避免 kernel/store 在纯 Node 测试环境里强依赖 react。
 * ------------------------------------------------------------------ */
