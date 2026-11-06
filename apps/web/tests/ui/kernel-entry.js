/* 内核契约冒烟入口：把真实 kernel 模块挂到 jsdom 的 window 上。
 * 与 core-entry.js 同一套路 —— 用 esbuild 打成 CJS，让 ui-regression.cjs
 * 能对事件总线 / 能力桥做运行时断言，而不只是 grep 源码文本。 */
import * as events from '../../src/kernel/events.js';
import * as bridge from '../../src/kernel/bridge.js';
import * as points from '../../src/kernel/mount-points.js';

window.__kernelForTest = { ...events, ...bridge, ...points };
