/* 弹层层级判定（唯一真源）：Esc 归谁、快捷键能不能抢占，都读这里。
 *
 * 背景：设置弹层、命令面板、确认框、灯箱、移动端整屏抽屉各自实现了 Esc 与焦点陷阱，
 * 但没有一处统一的「现在最上面是哪一层」。结果是命令面板（z=500）能叠在设置弹层（z=200）
 * 之上再开一层，Esc 还会先关下层；卡片详情被设置弹层盖着时，一次 Esc 连详情一起关掉。
 *
 * 约定：调用方只问「我上面还有没有别的层」，不要自己写选择器 —— 新增弹层时改这一个文件。
 * 注意：设置弹层是常驻挂载（关闭时靠 hidden），所以模态与抽屉都必须带 :not([hidden])。
 */

export const LAYER_SELECTORS = {
  sheet: '.dd-mask:not([hidden])',                            // 移动端整屏抽屉
  cmdk: '.cmdk-mask',                                         // 命令面板（仅在打开时渲染）
  confirm: '.confirm-mask',                                   // 统一确认框（同上）
  lightbox: '.lightbox',                                      // 图片灯箱（同上）
  modal: '.modal-mask:not([hidden]):not(.confirm-mask)',      // 设置弹层
};

/** 比「自己」更上面是否还有一层开着。
 *
 *  own 的两种写法：
 *  - 字符串：LAYER_SELECTORS 的键，表示「我属于这一层」（命令面板传 'cmdk'）；
 *  - 元素：我所在的那一层（卡片详情这类自己就渲染 .modal-mask / .dd-mask 的组件传
 *    自己的面板节点），凡是包含这个节点的层都算「自己」，不会被误判成上层。
 *  不传：只要有任意一层开着就算更高。 */
export function hasLayerAbove(own = null) {
  if (typeof document === 'undefined') return false;
  const isEl = !!own && typeof own === 'object' && own.nodeType === 1;
  for (const [key, sel] of Object.entries(LAYER_SELECTORS)) {
    if (!isEl && key === own) continue;
    for (const el of document.querySelectorAll(sel)) {
      if (isEl && (el === own || el.contains(own))) continue;   // 自己那一层
      return true;
    }
  }
  return false;
}
