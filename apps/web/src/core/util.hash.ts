/* 地址栏 hash：进入文章的深链。从 util.ts 抽出（深度重组），
 * util.ts 通过 export * 保持外部链不变。仅 replaceState，绝不 pushState。 */

import { matchViewHash } from '../kernel/router.ts';

/* ---------------- 地址栏 hash（进入文章的深链） ----------------
 * 策略：笺川**不把文章写进浏览器历史**（只用 replaceState，不 push）——
 * 否则读完点 20 次「下一篇」之后，按一次后退要按 20 次才能离开，
 * 那不是「后退」，是罚站。地址栏只留当前状态（视图 / 当前篇），
 * 刷新或从别处回来时按它恢复，并统一滚到该篇顶部。
 * 与「进入一篇文章」的滚动策略一致：谁进来都从文章开头看起。 */
export function writeHash(hash: string) {
  try {
    if (!hash) return;
    if (location.hash === hash) return;
    history.replaceState(null, '', hash);
  } catch (_) {
    /* 老浏览器 / 沙箱环境忽略 */
  }
}

/** 从 hash 里解析「视图 + 条目」：#cards / #reader / #reader/art/<id> / #ai … */
export function parseHash(hash: string | null | undefined) {
  const h = hash || '';
  // V5：路由解析真正交给 React Router 的 matchPath 声明式路由表（kernel/router.ts）。
  // matchViewHash 同时认新格式 #/reader/... 与旧格式 #reader/...，返回统一结构。
  const m = matchViewHash(h);
  if (m) return { tab: m.tab, artId: m.params?.artId ?? null, scope: m.scope ?? null };
  return { tab: null, artId: null };
}
