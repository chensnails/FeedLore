/* 统一事件派发：顶栏快照与覆盖层重绘。从 util.ts 抽出（深度重组），
 * util.ts 通过 export * 保持外部链不变。 */

import { EVENT, emit } from '../kernel/events.ts';

/** 通知视图导航 / ⋮ 菜单重绘：它们监听 __shellTick 后重读 getShell() */
export function emitShell() {
  emit(EVENT.SHELL);
}

/** 通知覆盖层（src/ui/Overlays.jsx）重绘：toast / 新内容浮标 / 图片灯箱都归它渲染 */
export function emitOverlays() {
  emit(EVENT.OVERLAYS);
}
