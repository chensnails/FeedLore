/* 跨 React Root 的显式能力桥。
 *
 * 背景：前端有 8 个独立 createRoot，彼此无法共享 Context。历史上靠直接读写
 * `window.__settingsHost` / `__confirmOpen` / `__cardsFocusSearch` 等全局变量
 * 互相调用，问题有三：
 *   ① 没有注册表，谁提供、谁消费、全集有哪些都只能全局搜索才知道；
 *   ② 名字拼错只会拿到 undefined，失败发生在很远的地方，排查成本高；
 *   ③ 撤销语义不统一（有的 delete、有的置 false、有的忘了清），热重载/卸载后
 *      会留下指向已卸载组件的旧函数。
 *
 * 这里给出单一真源：底层仍写 window.__*（首屏注入、测试驱动与旧代码依赖它），
 * 但所有读写都经过本模块，且撤销统一走 revoke()。异步挂载的宿主允许暂时缺失，
 * 所以 get() 返回 undefined 是正常状态；确实必须有值时用 require() 拿明确报错。
 */

export const BRIDGE = Object.freeze({
  cmdkOpen: '__cmdkOpen',                 // boolean，命令面板是否展开
  confirmOpen: '__confirmOpen',           // boolean，统一确认框是否展开
  settingsOpen: '__settingsOpen',         // boolean，设置弹层是否展开
  settingsHost: '__settingsHost',         // { open, setRoleFlag, setAdminFlag, ... }
  settingsPending: '__settingsPending',   // 弹层尚未挂载时记下的目标分区
  mountSettings: '__mountSettings',       // (tab) => Promise，按需加载设置弹层
  mountAi: '__mountAi',                   // () => Promise，按需加载日报视图
  cardsFocusSearch: '__cardsFocusSearch', // () => void，聚焦卡片页搜索框
  readerFocusSearch: '__readerFocusSearch', // () => void，聚焦文章页搜索框
});

const KNOWN = new Set(Object.values(BRIDGE));

function keyOf(name) {
  const key = BRIDGE[name];
  if (!key) throw new Error(`[kernel] 未登记的能力桥 "${name}"，请在 kernel/bridge.js 的 BRIDGE 里声明`);
  return key;
}

/** 提供（或替换）一个能力。value 为 null/undefined 时等价于 revoke。 */
export function provide(name, value) {
  const key = keyOf(name);
  if (value == null) { delete window[key]; return; }
  window[key] = value;
}

/** 读取能力，缺失时返回 fallback（异步挂载是常态，不视为错误）。 */
export function get(name, fallback) {
  const v = window[keyOf(name)];
  return v === undefined ? fallback : v;
}

/** 布尔桥的快捷读法。 */
export function isOn(name) { return !!get(name, false); }

/** 必须有值：拿不到就抛带名字的错误，而不是让调用方对着 undefined 发呆。 */
export function requireBridge(name) {
  const v = get(name);
  if (!v) throw new Error(`[kernel] 能力桥 "${name}" 尚未提供（宿主组件可能还没挂载）`);
  return v;
}

/** 统一撤销：组件卸载时调用，避免留下指向旧实例的函数。 */
export function revoke(name) { delete window[keyOf(name)]; }

/** 供测试/诊断：当前所有已登记桥的占用情况。 */
export function bridgeSnapshot() {
  return Object.fromEntries([...KNOWN].map((k) => [k, typeof window[k]]));
}
