/* 链接选择菜单：多条链接时从按钮旁弹出（fixed 定位，自动避让视口边缘）。
 * 从 util.ts 抽出（深度重组），util.ts 通过 export * 保持外部链不变。 */

import { escapeHtml, linkLabel, shortUrl } from './util.format.ts';

export let linkMenuEl: HTMLDivElement | null = null;
let linkMenuReturnFocus: HTMLElement | null = null;
export function closeLinkMenu() {
  if (!linkMenuEl) return;
  linkMenuEl.remove();
  linkMenuEl = null;
  document.removeEventListener('click', onLinkMenuDocClick, true);
  document.removeEventListener('keydown', onLinkMenuKey, true);
  window.removeEventListener('resize', closeLinkMenu);
  window.removeEventListener('scroll', closeLinkMenu, true);
  // 菜单是键盘可达的：关掉时把焦点还给打开它的按钮，别让用户掉到 body
  const back = linkMenuReturnFocus;
  linkMenuReturnFocus = null;
  if (back && document.contains(back) && typeof back.focus === 'function') back.focus();
}
export function onLinkMenuDocClick(ev: MouseEvent) {
  if (linkMenuEl && !(ev.target instanceof Node && linkMenuEl.contains(ev.target))) closeLinkMenu();
}
export function onLinkMenuKey(ev: KeyboardEvent) {
  if (!linkMenuEl) return;
  if (ev.key === 'Escape') {
    ev.preventDefault();
    ev.stopPropagation();
    closeLinkMenu();
    return;
  }
  if (ev.key === 'Tab') {
    closeLinkMenu();
    return;
  }
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp' || ev.key === 'Home' || ev.key === 'End') {
    ev.preventDefault();
    ev.stopPropagation();
    const items = Array.from(linkMenuEl.querySelectorAll<HTMLElement>('.link-menu-item'));
    if (!items.length) return;
    const idx = items.indexOf(document.activeElement as HTMLElement);
    let next: number;
    if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = items.length - 1;
    else
      next = Math.max(
        0,
        Math.min(items.length - 1, Math.max(idx, 0) + (ev.key === 'ArrowDown' ? 1 : -1)),
      );
    items[next]?.focus();
  }
}

export function openLinkMenu(anchor: HTMLElement, urls: string[], onPick: (url: string) => void) {
  closeLinkMenu();
  linkMenuReturnFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const menu = document.createElement('div');
  menu.className = 'link-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = urls
    .map(
      (u, i) => `
    <button type="button" class="link-menu-item" role="menuitem" data-i="${i}">
      <span class="link-menu-label">${escapeHtml(linkLabel(u))}</span>
      <span class="link-menu-url">${escapeHtml(shortUrl(u))}</span>
    </button>`,
    )
    .join('');
  document.body.appendChild(menu);
  linkMenuEl = menu;

  const r = anchor.getBoundingClientRect();
  const gap = 6;
  const left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - menu.offsetWidth - 8));
  let top = r.bottom + gap;
  if (top + menu.offsetHeight > window.innerHeight - 8)
    top = Math.max(8, r.top - menu.offsetHeight - gap);
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';

  // 弹出即入焦首项，↑↓ 漫游（见 onLinkMenuKey）
  const first = menu.querySelector<HTMLElement>('.link-menu-item');
  if (first) first.focus();

  menu.addEventListener('click', (ev) => {
    if (!(ev.target instanceof Element)) return;
    const item = ev.target.closest('.link-menu-item');
    if (!item) return;
    const u = urls[Number(item.getAttribute('data-i'))];
    closeLinkMenu();
    if (u) onPick(u);
  });
  // 延后一帧再挂「点外面关闭」，否则这次点击本身就会把刚弹出的菜单关掉
  setTimeout(() => {
    document.addEventListener('click', onLinkMenuDocClick, true);
    document.addEventListener('keydown', onLinkMenuKey, true);
    window.addEventListener('resize', closeLinkMenu, { passive: true });
    window.addEventListener('scroll', closeLinkMenu, { capture: true, passive: true });
  }, 0);
}
