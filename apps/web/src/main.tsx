import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { queryClient } from './lib/query';
import { hydrateFromRoute } from './lib/route';
import './style.css';

/* 必须在渲染之前：地址栏是筛选条件的**主真相源**，晚一步的话
 * EntriesPanel 会先用 localStorage 里的值发一次请求、再按 hash 重发一次，
 * 刷新时表现为列表闪一下再换内容。 */
hydrateFromRoute();

const el = document.getElementById('root');
if (!el) throw new Error('缺少 #root 挂载点');

createRoot(el).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);

/**
 * 注册 Service Worker（PWA 可安装 + 断网开壳）。
 *
 * 三个口径：
 * 1. **只在生产构建里注册**。dev 下注册会把 vite 的模块热更新缓存住，
 *    改一行代码刷新看不到变化，是最费时间的假 bug。
 * 2. 注册失败**不弹提示**：sw 不可用（非 HTTPS、隐私模式、旧浏览器）只是少了离线和
 *    「添加到主屏」，应用本身完全能用，没必要为此打断用户。
 * 3. 放在渲染之后：首屏渲染优先，注册是后台行为。
 */
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      /* 静默：见第 2 条 */
    });
  });
}
