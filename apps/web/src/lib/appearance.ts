import type { Appearance } from '@feedlore/contract';

/**
 * 把服务端偏好里的外观配置落到 DOM 上。
 *
 * 为什么放这里而不是写进 CSS 的媒体查询：外观是**按账号**的（用户的 v1.x 数据里
 * 可能设的是 `github` 主题或 teal 主色），媒体查询只能表达系统偏好。
 * 主题用 `data-theme` 属性驱动 CSS 变量，主色只换两个令牌（--accent / --accent-ink），
 * 不做「每个主题一份完整色板」——那是 6×N 的维护地狱。
 */
/* 默认蓝改为 CommaFeed 蓝（#3a8dcc），与 :root 回退令牌一致；其余主色选项保留。
 * 套用 CommaFeed 配色方案：干净中性灰底 + 蓝色强调，替换原 v2 的暖橙/浅蓝调。 */
const ACCENTS: Record<string, [string, string]> = {
  blue: ['#3a8dcc', '#ffffff'],
  violet: ['#9a7bf0', '#ffffff'],
  teal: ['#43b3a3', '#04211d'],
  green: ['#5cba6a', '#08180c'],
  amber: ['#d8a86e', '#241a0f'],
  rose: ['#e0708f', '#2a0e16'],
};

export function applyAppearance(a: Appearance): void {
  const el = document.documentElement;

  // 契约里 theme 有 auto/light/dark/github 四值；auto = 跟随系统（不写属性）
  if (a.theme === 'auto') delete el.dataset.theme;
  else if (a.theme === 'github') el.dataset.theme = 'dark';
  else el.dataset.theme = a.theme;

  const pair = ACCENTS[a.accent];
  if (pair) {
    el.style.setProperty('--accent', pair[0]);
    el.style.setProperty('--accent-ink', pair[1]);
  }

  el.dataset.density = a.density;
  el.dataset.fontSize = a.fontSize;

  /* 阅读排版四项：只作用于正文，界面字号不受影响。
   * 落成 data-* 属性、由 CSS 换算成 --reader-* 令牌，而不是在这里 setProperty
   * 一堆具体数值 —— 具体值属于样式表，放这里会让「改行高」变成改 JS。 */
  el.dataset.readerFont = a.readerFont;
  el.dataset.readerLh = a.readerLh;
  el.dataset.readerFs = a.readerFs;
  el.dataset.readerWidth = a.readerWidth;
}
