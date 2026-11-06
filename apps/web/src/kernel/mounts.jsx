/* 声明式 React 装配：把 mount-points.js 的数据表变成真实的 createRoot。
 *
 * 背景：main.jsx 是渐进式迁移期的「混合入口」，八个 createRoot 各写一遍
 * StrictMode + getElementById + 判空，其中两个还要额外实现按需加载与
 * pending 补调用。新增一个浮层要复制一遍样板，挂载点全集散在 120 行里，
 * 也没有地方能校验 id 是否重复或漏挂。
 *
 * 现在 main.jsx 只剩三行；装配逻辑只写一次，挂载点全集由纯数据模块给出：
 *  - 常驻视图在 mountAll() 里一次挂载；
 *  - 设置 / 日报首次使用时才动态 import，宿主未就绪时把目标分区记进桥，
 *    由 SettingsModal 挂载后补一次 open（行为与旧实现一致）；
 *  - roots / loading 两张表防止重复挂载或重复下载，失败允许重试。
 *
 * 注意：main.jsx 仍须把 `import '@core'` 放在最前 —— 核心模块求值时就会
 * 绑定事件与首屏启动，挂载必须在它之后发生。
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { CommandPalette } from '../cmdk/CommandPalette.jsx';
import { CardsView } from '../views/CardsView.jsx';
import { ReaderView } from '../views/ReaderView.jsx';
import { ViewNav } from '../ui/ViewNav.jsx';
import { ScrollTop } from '../ui/ScrollTop.jsx';
import { Overlays } from '../ui/Overlays.jsx';
import { MOUNT_POINTS } from './mount-points.js';
import { provide, get } from './bridge.js';

const COMPONENTS = {
  CommandPalette, CardsView, ReaderView, Overlays, ViewNav, ScrollTop,
};
const LOADERS = {
  SettingsModal: () => import('../settings/SettingsModal.jsx'),
  AiView: () => import('../ai/AiView.jsx'),
};

/** 完整装配描述（数据 + 组件引用），供诊断与测试使用。 */
export const MOUNTS = Object.freeze(MOUNT_POINTS.map((p) => Object.freeze({
  ...p,
  component: COMPONENTS[p.component],
  load: p.lazy ? LOADERS[p.exportName] : undefined,
})));

const roots = new Map();
const loading = new Map();

function render(id, Component) {
  const host = document.getElementById(id);
  if (!host || roots.has(id) || !Component) return;
  const root = createRoot(host);
  roots.set(id, root);
  root.render(<React.StrictMode><Component /></React.StrictMode>);
}

function loadMount(id) {
  if (roots.has(id) || !document.getElementById(id)) return Promise.resolve();
  if (!loading.has(id)) {
    const m = MOUNTS.find((x) => x.id === id);
    if (!m || !m.load) return Promise.resolve();
    const p = m.load()
      .then((mod) => { render(id, mod[m.exportName]); })
      .catch((err) => {
        loading.delete(id);              // 允许下次重试，别把失败永久缓存
        console.error(`[kernel] 按需加载 ${id} 失败`, err);
        throw err;
      });
    loading.set(id, p);
  }
  return loading.get(id);
}

function openSettings(tab) {
  const host = get('settingsHost');
  if (host && host.open) { host.open(tab); return Promise.resolve(); }
  provide('settingsPending', { tab });
  return loadMount('settingsRoot');
}

function openAi() { return loadMount('aiRoot'); }

/** 唯一的启动入口：挂全部常驻视图，并把两个按需加载器登记到能力桥。 */
export function mountAll() {
  for (const m of MOUNTS) if (!m.lazy) render(m.id, m.component);
  provide('mountSettings', openSettings);
  provide('mountAi', openAi);
}
