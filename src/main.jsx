/* 笺川前端 React 入口（渐进式混合期）。
 * 职责：把 React 组件挂到旧 HTML 的挂载点上。
 * 目前挂 App Shell 顶栏与进度条（#topbarRoot / #shellRoot）、命令面板（#cmdkRoot）、
 * 设置弹层（#settingsRoot）、AI 视图（#aiRoot）、卡片视图（#cardsRoot）、文章视图（#readerRoot）
 * —— 三大视图与顶栏全部 React 化。
 * 核心逻辑（v2.1.0 起拆分在 src/core/*.js）经 @core 别名共享为单例。 */

import '@core';   // 初始化核心逻辑（原 public/app.js）：首屏主题/视图、事件绑定、init()
import React from 'react';
import { createRoot } from 'react-dom/client';
import { CommandPalette } from './cmdk/CommandPalette.jsx';
import { SettingsModal } from './settings/SettingsModal.jsx';
import { AiView } from './ai/AiView.jsx';
import { CardsView } from './views/CardsView.jsx';
import { ReaderView } from './views/ReaderView.jsx';
import { TopBar, ReadProgress } from './shell/TopBar.jsx';
import { Overlays } from './ui/Overlays.jsx';

const topbarRoot = document.getElementById('topbarRoot');
if (topbarRoot) {
  createRoot(topbarRoot).render(
    <React.StrictMode>
      <TopBar />
    </React.StrictMode>
  );
}

const shellRoot = document.getElementById('shellRoot');
if (shellRoot) {
  createRoot(shellRoot).render(
    <React.StrictMode>
      <ReadProgress />
    </React.StrictMode>
  );
}

const el = document.getElementById('cmdkRoot');
if (el) {
  createRoot(el).render(
    <React.StrictMode>
      <CommandPalette />
    </React.StrictMode>
  );
}

const settingsRoot = document.getElementById('settingsRoot');
if (settingsRoot) {
  createRoot(settingsRoot).render(
    <React.StrictMode>
      <SettingsModal />
    </React.StrictMode>
  );
}

const aiRoot = document.getElementById('aiRoot');
if (aiRoot) {
  createRoot(aiRoot).render(
    <React.StrictMode>
      <AiView />
    </React.StrictMode>
  );
}

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
