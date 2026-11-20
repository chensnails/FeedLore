/* 可折叠分组（<details class="sec" data-sec="…">）的开合记忆。
 * 从 ui.ts 抽出（深度重组），ui.ts 通过 export * 保持外部链不变。 */

import { layoutPref, setLayout } from './state.ts';

/* ============================================================
 * 可折叠分组（<details class="sec" data-sec="…">）
 * 用原生 <details>/<summary>（键盘可操作、无障碍语义天然正确），
 * 这里只做两件事：按 data-sec 记住每组的开合状态、由各表单更新摘要行。
 * 开合状态按账号持久化（users.prefs.layout.sections），不再落浏览器 localStorage。
 * ============================================================ */
export function savedSections() {
  return layoutPref.sections && typeof layoutPref.sections === 'object' ? layoutPref.sections : {};
}

export function saveSectionState(key: string, open: boolean) {
  const next = Object.assign({}, layoutPref.sections || {}, { [key]: !!open });
  setLayout('sections', next);
}

/**
 * 给 root 里所有 details.sec 套上记住的开合状态，并挂上变化监听。
 * 静态区域在启动时调一次就够；**动态重绘的区域每次渲染后都要再调一次**
 * —— 状态页每 30s 重绘一遍，不重新绑定的话展开态会被冲掉。
 */
export function bindSections(root: ParentNode | null | undefined) {
  const saved = savedSections();
  (root || document).querySelectorAll<HTMLDetailsElement>('details.sec[data-sec]').forEach((d) => {
    if (d.dataset.secBound === '1') return; // 已经绑过，别重复挂监听
    d.dataset.secBound = '1';
    const k = d.getAttribute('data-sec');
    if (!k) return;
    if (k in saved) d.open = !!saved[k];
    d.addEventListener('toggle', () => saveSectionState(k, d.open));
  });
}

bindSections(document);
