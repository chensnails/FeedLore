/* 笺川前端入口：核心启动 → 声明式挂载。
 *
 * 挂载点全集、按需加载标记与组件映射都在 src/kernel/mount-points.js /
 * mounts.jsx；这里不再逐根 createRoot，新增浮层只改那张表。
 * 设置弹层（7 个面板）与日报视图仍按需加载，首屏不背这两块 JS。
 *
 * 两处顺序约束：
 *  - `@core` 求值时就会绑定全局事件、应用首屏主题/视图并跑 init()，必须先于组件挂载；
 *  - 样式表必须由入口 import，Vite 由此打出带内容哈希的 CSS —— 手写固定路径的
 *    <link> 会被 CDN 缓存 1~4 小时，出现「新 HTML + 旧 CSS」的错配。
 */
import '@core';
import './style.css';
import { mountAll } from './kernel/mounts.jsx';

mountAll();
