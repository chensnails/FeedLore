/* 拾阅核心逻辑 · 通用工具枢纽（DOM 选择器 / 复制 / 错误文案）
 *
 * 深度重组后：网络层 → util.fetch.ts，格式化 → util.format.ts，
 * toast → util.toast.ts，确认框 → util.confirm.ts，事件 → util.events.ts，
 * 链接菜单 → util.linkmenu.ts，hash → util.hash.ts。
 * 本文件保留 $/copyText 并统一 re-export，外部引用链完全不变。
 * ============================================================ */

import { errorText } from './errorText.ts';

export * from './util.confirm.ts';
export * from './util.events.ts';
export * from './util.fetch.ts';
export * from './util.format.ts';
export * from './util.hash.ts';
export * from './util.linkmenu.ts';
export * from './util.toast.ts';
export { errorText as errText };

/* ---------------- DOM ---------------- */
export const $ = (s: string): Element | null => document.querySelector(s);

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) {
    /* 降级 */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (_) {
    return false;
  }
}
