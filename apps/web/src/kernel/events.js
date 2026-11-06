/* 应用事件契约 —— 前端跨模块通信的唯一真源。
 *
 * 背景：渐进式迁移期留下了 9 类形如 `__xxxTick` 的字符串事件，派发点散在
 * core/ 五个模块、监听点散在 ui/ views/ settings/ ai/ 八个组件里。名字只靠
 * 口头约定：拼错不会报错，只会静默不刷新；订阅与退订各写一遍，漏一次就是
 * 内存泄漏；新增一类事件要同时改 N 个文件且没有任何地方能查到全集。
 *
 * 这里把它收成显式契约，但**保留 DOM 事件作为传输层**：
 *  - 首屏内联脚本、测试驱动（jsdom 里直接 dispatchEvent）与旧监听器无需改动；
 *  - 组件用 on() 订阅，返回 unsubscribe，useEffect 里直接 return；
 *  - emit() 统一构造 Event / CustomEvent，载荷形状有处可查；
 *  - 事件名集中登记，源码里不再出现裸字符串（由 UI 回归做静态守护）。
 *
 * 兼容性：未登记的名字仍然照常派发/订阅，只在控制台告警 —— 渐进迁移期间
 * 不能因为漏登记就让某个视图停止刷新。真正的「禁止裸字符串」由测试守门。
 */

export const EVENT = Object.freeze({
  VIEW: '__viewChanged',            // detail: 切换后的 tab 名（'reader' | 'cards' | 'ai' | ...）
  SHELL: '__shellTick',             // 顶栏快照（getShell）需要重读
  CARDS: '__cardsTick',             // 卡片列需要重绘
  READER: '__readerTick',           // 文章列需要重绘
  APPEARANCE: '__appearanceChanged', // 本机外观偏好被外部改动
  OVERLAYS: '__overlaysTick',       // 灯箱 / 提示 / 确认框快照需要重读
});

const KNOWN = new Set(Object.values(EVENT));

function assertKnown(kind, name) {
  if (KNOWN.has(name)) return;
  // 不阻断：迁移期允许尚未登记的调用点先跑起来，但让拼写错误立刻可见。
  console.warn(`[kernel] ${kind} 使用了未登记的事件名 "${name}"，请在 kernel/events.js 的 EVENT 里声明`);
}

/** 派发事件。detail 为空时用 Event，有值时用 CustomEvent（读 ev.detail）。 */
export function emit(name, detail) {
  assertKnown('emit', name);
  // 显式取 window 上的构造器：jsdom / iframe 等跨 realm 场景里，裸 Event 属于
  // 另一个 realm，dispatchEvent 会抛 "parameter 1 is not of type 'Event'"。
  const ev = detail === undefined
    ? new window.Event(name)
    : new window.CustomEvent(name, { detail });
  window.dispatchEvent(ev);
  return ev;
}

/** 订阅事件，返回 unsubscribe。组件里 `useEffect(() => on(EVENT.X, fn), [])` 即可。 */
export function on(name, handler) {
  assertKnown('on', name);
  window.addEventListener(name, handler);
  return () => window.removeEventListener(name, handler);
}

/** 一次订阅多个事件（ViewNav 同时关心视图切换与顶栏快照）。 */
export function onAny(names, handler) {
  const stops = names.map((n) => on(n, handler));
  return () => { for (const stop of stops) stop(); };
}
