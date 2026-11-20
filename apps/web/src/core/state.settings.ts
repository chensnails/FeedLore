/* 设置弹层委托入口 + 按角色显隐 + 弹层打开时的页面滚动锁。
 * 从 state.ts 抽出（深度重组）：设置弹层外壳已 React 化，本模块只保留命令面委托
 * 与滚动锁计数，state.ts 通过 export * 保持外部链不变。 */

import { get } from '../kernel/bridge.ts';
import { state } from '../store/app.ts';
import { toast } from './util.ts';

/** 设置弹层宿主暴露给 core 的命令面（经能力桥提供，缺失时静默）。 */
interface SettingsHost {
  open?: (tab?: string) => void;
  close?: () => void;
  setAdminFlag?: (v: boolean) => void;
  setRoleFlag?: (v: string) => void;
  setSummary?: (v: string) => void;
}

/* ============================================================
 * 设置面板
 * ============================================================ */

export const isAdmin = () => state.role === 'admin';
/** 只读账户只能阅读：配置类入口在前端隐藏，服务端另有 403 兜底。 */
export const isReadonly = () => state.role === 'readonly';
/** 可执行配置写操作（管理员 / 普通用户）；会话未加载时按可写处理，交给服务端判定。 */
export const isWritable = () => state.role !== 'readonly';

/** 按角色显隐：设置弹层的管理员专属 tab 由 React 外壳过滤；
 *  采集参数 / 用户管理 分别在各自 React 面板内按 admin 显隐（P3a 起 AI 视图亦 React 化） */
export function applyRoleUI() {
  const admin = isAdmin();
  // 设置弹层 tab 已 React 化：按角色过滤交给宿主（管理员专属 tab 由外壳不再渲染）
  const host = get('settingsHost') as SettingsHost | undefined;
  if (host && host.setAdminFlag) host.setAdminFlag(admin);
  if (host && host.setRoleFlag) host.setRoleFlag(state.role || '');
}

/* ---------- 弹层打开时锁住背景页面 ----------
 * 弹层本身是 position:fixed，但背景页面照样能滚：滚到弹层内容尽头后，滚轮会「接力」给
 * body，页面就跟着跑了。只给 body 加 overflow:hidden 在 iOS 上无效（惯性滚动挡不住），
 * 所以用 position:fixed + 负 top 把页面钉在原处，关掉时再滚回去。
 * 用计数是因为「设置弹层」和「图片灯箱」可能同时开着。
 */
export let scrollLockCount = 0;
export let scrollLockY = 0;

export function lockPageScroll() {
  scrollLockCount += 1;
  if (scrollLockCount > 1) return;
  scrollLockY = window.scrollY || window.pageYOffset || 0;
  // 页面滚动条会消失，先量出它的宽度补到右内边距上，否则整页会往右跳一下
  const sbw = Math.max(0, window.innerWidth - document.documentElement.clientWidth);
  document.body.style.setProperty('--sbw', sbw + 'px');
  document.body.style.top = `-${scrollLockY}px`;
  document.body.classList.add('modal-open');
}

export function unlockPageScroll() {
  scrollLockCount = Math.max(0, scrollLockCount - 1);
  if (scrollLockCount > 0) return;
  if (!document.body.classList.contains('modal-open')) return;
  document.body.classList.remove('modal-open');
  document.body.style.top = '';
  document.body.style.removeProperty('--sbw');
  window.scrollTo(0, scrollLockY); // 回到打开弹层前的位置
}

/** 打开设置弹层（外壳 React 化后仅作为委托入口：锁屏 / tab 副作用 / 面板加载
 *  都由 SettingsModal 挂载后自行完成）。
 *  注意：tab 要原样透传、不要在这里兜底成 'source' —— 移动端用「有没有指定分区」
 *  区分「进设置列表」和「直达某分区」（见 SettingsModal 的 mobilePane 判定）；
 *  桌面端的默认分区由 SettingsModal 自己兜底，语义不变。
 *@param {*} [tab]
 */

export function openSettings(tab?: string) {
  const host = get('settingsHost') as SettingsHost | undefined;
  if (host && host.open) {
    host.open(tab);
    return;
  }
  // 设置弹层自 v2.2.0 起按需加载：宿主还没注册时交给入口去拉 chunk，
  // 拉完由 SettingsModal 读取 __settingsPending 补上这次打开。
  const mount = get('mountSettings') as ((tab?: string) => Promise<unknown>) | undefined;
  if (typeof mount === 'function') {
    const p = mount(tab);
    if (p && p.catch) p.catch(() => toast('设置页面加载失败，请检查网络后重试', false));
  }
}

export function closeSettings() {
  const host = get('settingsHost') as SettingsHost | undefined;
  if (host && host.close) host.close();
}

/** 设置弹层副标题文本（纯计算：React 宿主打开弹层时也要用同一份） */
export function getSettingsSummary() {
  const meta = state.feedMeta;
  const total = meta?.total || 0;
  if (!total) return '还没有订阅源';
  const on = meta?.enabled || 0;
  const card = meta?.cardEnabled == null ? on : meta.cardEnabled;
  return `共 ${total} 个订阅源 · 采集开启 ${on} 个 · 卡片展示 ${card} 个`;
}

/** 推送副标题给 React 外壳（宿主未就绪时静默）
 *@param {*} [text]
 */

export function setSettingsSummary(text: string) {
  const host = get('settingsHost') as SettingsHost | undefined;
  if (host && host.setSummary) host.setSummary(text);
}
