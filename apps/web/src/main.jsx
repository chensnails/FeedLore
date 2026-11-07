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
 *  - 样式分两层：`style.css` 是历史布局层（骨架 / 断点 / 几何 / 状态类名），
 *    `hig.css` 是 Apple HIG 视觉层（令牌 / 材质 / 圆角 / 反馈 / 控件形态）。
 *    顺序不能反：后者靠「后写者胜」覆盖前者的视觉声明，不复制任何布局规则。
 */
import '@core';
import './style.css';
import './hig.css';
import { mountAll } from './kernel/mounts.jsx';
import { installAutofillGuard } from './ui/noAutofill.js';
import { installTabbarAutoHide } from './ui/tabbarAutoHide.js';
import { installScrollBusy } from './ui/scrollBusy.js';

// 浏览器会把登录页保存的账密启发式填进同源 SPA 的搜索框；全局哨兵只清非登录字段。
installAutofillGuard();
mountAll();
// 底部标签栏随滚动方向收展；纯 DOM 状态类，不参与 React 渲染。
installTabbarAutoHide();
// 滚动期间挂 `body.is-scrolling`，让列表项的悬停过渡让路（纯指针场景的重绘优化）。
installScrollBusy();
