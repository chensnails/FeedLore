/* React 桥订阅 hook（V4.3）。
 * 组件用 useBridge('settingsOpen') 读桥状态，无需 __xxxTick 事件 + get() 轮询快照。
 * 写入仍走 bridge.provide（保持命令式门面单一），读取改走 Zustand 的选择器订阅。
 */
import { useSyncExternalStore } from 'react';
import { bridgeStore } from './store.ts';

/** 订阅单个桥值（key 是 window.__* 原始名，通常从 BRIDGE 取）。 */
export function useBridge(key: string): any {
  return useSyncExternalStore(
    bridgeStore.subscribe,
    () => bridgeStore.getState()[key],
    () => undefined,
  );
}
