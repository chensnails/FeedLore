import type { Appearance } from '@feedlore/contract';

/**
 * 把服务端偏好里的外观配置落到 DOM 上。
 *
 * 为什么放这里而不是写进 CSS 的媒体查询：外观是**按账号**的（用户的 v1.x 数据里
 * 可能设的是 `github` 主题或 teal 主色），媒体查询只能表达系统偏好。
 * 主题用 `data-theme` 属性驱动 CSS 变量，主色只换两个令牌（--accent / --accent-ink），
 * 不做「每个主题一份完整色板」——那是 6×N 的维护地狱。
 */
const ACCENTS: Record<string, [string, string]> = {
  blue: ['#5b8def', '#ffffff'],
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
}
