/* 笺川前端 React 入口（渐进式混合期）。
 * 职责：把 React 组件挂到旧 HTML 的挂载点上。
 * 命令面板（#cmdkRoot）、卡片 / 文章视图（#cardsRoot / #readerRoot）、覆盖层（#overlaysRoot）
 * 常驻；设置弹层（#settingsRoot）与 AI 视图（#aiRoot）改为**首次使用时按需加载** ——
 * 七个配置面板和日报界面只在用户真正点开时才下载，首屏少背一截 JS。
 * 核心逻辑（v2.1.0 起拆分在 src/core/*.js）经 @core 别名共享为单例。 */

import '@core';   // 初始化核心逻辑（原 public/app.js）：首屏主题/视图、事件绑定、init()
import React from 'react';
import { createRoot } from 'react-dom/client';
/* 样式表从 public/ 移入 src/（v1.5.0）：由 Vite 打包，产物带内容哈希。
 * 此前 public/style.css 是固定文件名，CDN 会把它缓存 1~4 小时，而 index.html
 * 永远是新的 —— 新 HTML + 旧 CSS 错配会让新增元素完全没有样式（实测 1.3.9 的
 * 旧 CSS 遇上新版频道搜索框，svg 撑成 300×150 的黑色实心圆）。 */
import './style.css';
import { CommandPalette } from './cmdk/CommandPalette.jsx';
import { CardsView } from './views/CardsView.jsx';
import { ReaderView } from './views/ReaderView.jsx';
import { ViewNav } from './ui/ViewNav.jsx';
import { Overlays } from './ui/Overlays.jsx';

/* v1.6.0：顶栏并入各视图自带的第一行（≡频道 / 标题 / 搜索 / ⋮），
   三视图各自渲染合并后的 Row1 并写入 --topbar-h。 */

const el = document.getElementById('cmdkRoot');
if (el) {
  createRoot(el).render(
    <React.StrictMode>
      <CommandPalette />
    </React.StrictMode>
  );
}

/* 设置弹层：第一次 openSettings 时才下载并挂载。
 * 打开动作可能在挂载完成前到达（动态 import 是异步的），先把目标分区记在
 * window.__settingsPending，由 SettingsModal 注册宿主时补一次 open。 */
const settingsRoot = document.getElementById('settingsRoot');
let settingsLoading = null;
window.__mountSettings = (tab) => {
  const host = window.__settingsHost;
  if (host && host.open) {
    host.open(tab);
    return Promise.resolve();
  }
  window.__settingsPending = { tab };
  if (!settingsRoot) return Promise.resolve();
  if (!settingsLoading) {
    settingsLoading = import('./settings/SettingsModal.jsx').then(({ SettingsModal }) => {
      createRoot(settingsRoot).render(
        <React.StrictMode>
          <SettingsModal />
        </React.StrictMode>
      );
    });
  }
  return settingsLoading;
};

/* AI 视图：切到「AI」页时才下载并挂载；组件初始 activeness 直接读 core.state.tab，
 * 所以挂载晚于切页也不会漏掉首次加载。 */
const aiRoot = document.getElementById('aiRoot');
let aiLoading = null;
window.__mountAi = () => {
  if (!aiRoot) return Promise.resolve();
  if (!aiLoading) {
    aiLoading = import('./ai/AiView.jsx').then(({ AiView }) => {
      createRoot(aiRoot).render(
        <React.StrictMode>
          <AiView />
        </React.StrictMode>
      );
    });
  }
  return aiLoading;
};

const cardsRoot = document.getElementById('cardsRoot');
if (cardsRoot) {
  createRoot(cardsRoot).render(
    <React.StrictMode>
      <CardsView />
    </React.StrictMode>
  );
}

const readerRoot = document.getElementById('readerRoot');
if (readerRoot) {
  createRoot(readerRoot).render(
    <React.StrictMode>
      <ReaderView />
    </React.StrictMode>
  );
}

const overlaysRoot = document.getElementById('overlaysRoot');
if (overlaysRoot) {
  createRoot(overlaysRoot).render(
    <React.StrictMode>
      <Overlays />
    </React.StrictMode>
  );
}

/* 移动端底部视图标签栏（v2.4.0）：只在 ≤720px 显示，复用同一份 ViewNav 组件。
 * 放在视图容器之外，避免 .reader-head 的容器查询（container-type）把 fixed
 * 后代限制在头部那一小块里。桌面 / 平板由各视图顶栏里的实例负责。 */
const mobileTabbarRoot = document.getElementById('mobileTabbarRoot');
if (mobileTabbarRoot) {
  createRoot(mobileTabbarRoot).render(
    <React.StrictMode>
      <ViewNav />
    </React.StrictMode>
  );
}
