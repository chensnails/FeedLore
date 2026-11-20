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
import { type BridgeValue, bridgeDelete, bridgeGet, bridgeSet } from './store.ts';

export const BRIDGE = Object.freeze({
  cmdkOpen: '__cmdkOpen', // boolean，命令面板是否展开
  confirmOpen: '__confirmOpen', // boolean，统一确认框是否展开
  settingsOpen: '__settingsOpen', // boolean，设置弹层是否展开
  settingsHost: '__settingsHost', // { open, setRoleFlag, setAdminFlag, ... }
  settingsPending: '__settingsPending', // 弹层尚未挂载时记下的目标分区
  mountSettings: '__mountSettings', // (tab) => Promise，按需加载设置弹层
  mountAi: '__mountAi', // () => Promise，按需加载日报视图
  cardsFocusSearch: '__cardsFocusSearch', // () => void，聚焦卡片页搜索框
  readerFocusSearch: '__readerFocusSearch', // () => void，聚焦文章页搜索框
});

const KNOWN = new Set<string>(Object.values(BRIDGE));

/** window 的 __* 桥属性是动态字符串键，global.d.ts 无法枚举；此处集中窄化。 */
const winBridge = () => window as unknown as Record<string, BridgeValue>;

/** 已登记的能力桥名（BRIDGE 的键）。 */
export type BridgeName = keyof typeof BRIDGE;

function keyOf(name: BridgeName): string {
  const key = BRIDGE[name];
  if (!key)
    throw new Error(`[kernel] 未登记的能力桥 "${name}"，请在 kernel/bridge.ts 的 BRIDGE 里声明`);
  return key;
}

/** 提供（或替换）一个能力。value 为 null/undefined 时等价于 revoke。 */
export function provide(name: BridgeName, value: BridgeValue) {
  const key = keyOf(name);
  // V4.3：Zustand store 是真源，window.__* 是兼容镜像（首屏脚本 / 测试桩读它）
  bridgeSet(key, value);
  if (value == null) {
    delete winBridge()[key];
    return;
  }
  winBridge()[key] = value;
}

/** 读取能力，缺失时返回 fallback（异步挂载是常态，不视为错误）。 */
export function get<T = BridgeValue>(name: BridgeName, fallback?: T): BridgeValue | T {
  const key = keyOf(name);
  // 首屏内联脚本可能绕过 provide 直接写 window.__LAYOUT__ 等；读时以 window 为准并回灌 store，
  // 让两条写入路径（provide / 首屏脚本）在 store 里汇合，React 订阅才能看到完整状态。
  const win = winBridge()[key];
  if (win !== undefined && bridgeGet(key) !== win) bridgeSet(key, win);
  const v = win !== undefined ? win : bridgeGet(key);
  return v === undefined ? fallback : v;
}

/** 布尔桥的快捷读法。 */
export function isOn(name: BridgeName) {
  return !!get(name, false);
}

/** 必须有值：拿不到就抛带名字的错误，而不是让调用方对着 undefined 发呆。 */
export function requireBridge(name: BridgeName): BridgeValue {
  const v = get(name);
  if (!v) throw new Error(`[kernel] 能力桥 "${name}" 尚未提供（宿主组件可能还没挂载）`);
  return v;
}

/** 统一撤销：组件卸载时调用，避免留下指向旧实例的函数。 */
export function revoke(name: BridgeName) {
  const key = keyOf(name);
  bridgeDelete(key);
  delete winBridge()[key];
}

/** 供测试/诊断：当前所有已登记桥的占用情况。 */
export function bridgeSnapshot() {
  return Object.fromEntries([...KNOWN].map((k) => [k, typeof winBridge()[k]]));
}
