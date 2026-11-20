/* 内核公共出口（只汇总无副作用的契约层）。
 *
 * 组件请直接 `import { on, EVENT } from '../kernel/events.ts'`、
 * `import { provide } from '../kernel/bridge.ts'`：本文件刻意**不**导出 mounts，
 * 因为它会静态引入全部视图组件，从组件侧绕进来会形成循环依赖并拖大分包。
 * mounts.tsx 只由 main.tsx 引用一次。
 */

export { BRIDGE, bridgeSnapshot, get, isOn, provide, requireBridge, revoke } from './bridge.ts';
export { EVENT, emit, on, onAny } from './events.ts';
