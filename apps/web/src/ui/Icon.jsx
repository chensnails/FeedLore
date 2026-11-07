/* 图标出口（v2.3.1）：<use href="#i-xxx"> 的 sprite 引用。
 *
 * 此前 5 个组件（AiView / CardDetail / CardsView / ChannelList / ReaderView）各自写了一份
 * 完全相同的定义 —— 改一次 aria 属性要改五处，漏一处就是无障碍口径分叉。
 *
 * 约定：图标一律 aria-hidden + focusable="false"，语义由父级按钮的 aria-label / 文本承担；
 * 需要独立语义时给它套一个带 aria-label 的元素，别在这里加 role。
 */

export const Icon = ({ n }) => (
  <svg className="ico" aria-hidden="true" focusable="false"><use href={'#i-' + n} /></svg>
);
