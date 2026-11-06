/* 内核公共出口（只汇总无副作用的契约层）。
 *
 * 组件请直接 `import { on, EVENT } from '../kernel/events.js'`、
 * `import { provide } from '../kernel/bridge.js'`：本文件刻意**不**导出 mounts，
 * 因为它会静态引入全部视图组件，从组件侧绕进来会形成循环依赖并拖大分包。
 * mounts.jsx 只由 main.jsx 引用一次。
 */
export { EVENT, emit, on, onAny } from './events.js';
export { BRIDGE, provide, get, isOn, requireBridge, revoke, bridgeSnapshot } from './bridge.js';
