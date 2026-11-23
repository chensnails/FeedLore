/* 声明式 React 装配（V5：单一 root）。
 *
 * 历史上八个 DOM 容器各有自己的 createRoot，各写一遍 StrictMode + 判空，
 * 其中两个还要动态 import + pending 补开。V5 把这些 root 合并为一个：
 *  - 唯一的 createRoot 挂到动态创建的空 #appRoot（不碰 index.html 的静态骨架）；
 *  - 每个视图/浮层用 createPortal 分发到原来的 8 个 DOM 容器 —— id 与层级
 *    全部保留，CSS 高度链（#aiView→.ex-wrap→.ex-pane→.ex-shell）、fixed 包含块、
 *    #overlaysRoot 查询作用域都不受影响；
 *  - 单一 React 树意味着 QueryProvider 只需包一层，所有组件共享同一个 Context。
 *
 * 按需加载（SettingsModal / AiView）保持原有 Promise 语义：core 层的 openSettings /
 * switchView('ai') 会拿到 import 的 Promise 并在失败时 toast；模块加载完成后通知
 * React 重渲染，再由 createPortal 把组件挂到对应容器，SettingsModal 挂载后照旧
 * 消费 settingsPending 补上那次打开。
 *
 * 注意：main.tsx 仍须把 `import '@core'` 放在最前 —— 核心模块求值时就会
 * 绑定事件与首屏启动，挂载必须在它之后发生。
 */
import React, { type ComponentType, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { ErrorBoundary } from '../ui/ErrorBoundary.tsx';
import { Overlays } from '../ui/Overlays.tsx';
import { ScrollTop } from '../ui/ScrollTop.tsx';
import { ViewNav } from '../ui/ViewNav.tsx';
import { CardsView } from '../views/CardsView.tsx';
import { ReaderView } from '../views/ReaderView.tsx';
import { get, provide } from './bridge.ts';
import { MOUNT_POINTS } from './mount-points.ts';
import { QueryProvider } from './QueryProvider.tsx';

const COMPONENTS = {
  CardsView,
  ReaderView,
  Overlays,
  ViewNav,
  ScrollTop,
};
const LOADERS = {
  SettingsModal: () => import('../settings/SettingsModal'),
  AiView: () => import('../ai/AiView'),
  CommandPalette: () => import('../cmdk/CommandPalette'),
};

/** 完整装配描述（数据 + 组件引用），供诊断与测试使用。 */
export const MOUNTS = Object.freeze(
  MOUNT_POINTS.map((p) =>
    Object.freeze({
      ...p,
      component: p.component
        ? (COMPONENTS as Record<string, ComponentType>)[p.component]
        : undefined,
      load: p.lazy && p.exportName ? LOADERS[p.exportName as keyof typeof LOADERS] : undefined,
    }),
  ),
);

// 按需模块就绪状态：loadMount 在模块外（core 层调用）完成 import 后写入并通知 React。
const loadedLazy = new Map<string, ComponentType>();
const loading = new Map<string, Promise<void>>();
const lazyListeners = new Set<() => void>();

function subscribeLazy(fn: () => void) {
  lazyListeners.add(fn);
  return () => {
    lazyListeners.delete(fn);
  };
}
function getLazySnapshot() {
  return loadedLazy.size;
}

function loadMount(id: string): Promise<void> {
  const pending = loading.get(id);
  if (pending) return pending;
  if (loadedLazy.has(id) || !document.getElementById(id)) return Promise.resolve();
  const m = MOUNTS.find((x) => x.id === id);
  if (!m || !m.load || !m.exportName) return Promise.resolve();
  const exportName = m.exportName;
  const p: Promise<void> = m
    .load()
    .then((mod: Record<string, unknown>) => {
      const Comp = mod[exportName];
      if (typeof Comp === 'function') loadedLazy.set(id, Comp as ComponentType);
      loading.delete(id);
      lazyListeners.forEach((fn) => fn());
    })
    .catch((err: unknown) => {
      loading.delete(id); // 允许下次重试，别把失败永久缓存
      console.error(`[kernel] 按需加载 ${id} 失败`, err);
      throw err;
    });
  loading.set(id, p);
  return p;
}

/** 每个装配项出错时的中文区域名：只用于 fallback 文案，不展示英文堆栈。 */
const BOUNDARY_LABELS: Record<string, string> = {
  cardsRoot: '卡片页',
  readerRoot: '文章页',
  aiRoot: '探索页',
  settingsRoot: '设置',
  cmdkRoot: '命令面板',
  overlaysRoot: '浮层',
  mobileTabbarRoot: '导航',
  scrollTopRoot: '回到顶部',
};

/** 单一 root 的内容：把每个装配项 portal 到它原来的 DOM 容器。
 *  每个视图单独罩一层错误边界：一处渲染抛错只降级那一块，不拖垮整棵树。 */
function App() {
  useSyncExternalStore(subscribeLazy, getLazySnapshot);
  return (
    <>
      {MOUNTS.map((m) => {
        const host = document.getElementById(m.id);
        if (!host) return null;
        const Component = m.lazy ? loadedLazy.get(m.id) : m.component;
        if (!Component) return null;
        return createPortal(
          <ErrorBoundary label={BOUNDARY_LABELS[m.id] || '页面'}>
            <Component />
          </ErrorBoundary>,
          host,
          m.id,
        );
      })}
    </>
  );
}

function openSettings(tab?: string) {
  const host = get('settingsHost') as { open?: (tab?: string) => void } | undefined;
  if (host && host.open) {
    host.open(tab);
    return Promise.resolve();
  }
  // 无参打开（⋮ 菜单的「设置」）也要能触发宿主补开：消费方要求 tab 是字符串，
  // 传空串让 `host.open(t || 默认分区)` 兜底，不能因为没指定分区就丢掉这次点击。
  provide('settingsPending', { tab: tab ?? '' });
  return loadMount('settingsRoot');
}

function openAi() {
  return loadMount('aiRoot');
}

/** ⌘K 的懒加载引导：模块还没下载时先拉取，再把这次按键补发给组件自己的监听。
 *  已加载后这里直接放行，开合与弹层优先级仍由 CommandPalette 单点判定，不会双触发。 */
function installCmdkShortcut(): void {
  document.addEventListener(
    'keydown',
    (ev) => {
      if (!(ev.metaKey || ev.ctrlKey) || (ev.key !== 'k' && ev.key !== 'K')) return;
      if (loadedLazy.has('cmdkRoot') || loading.has('cmdkRoot')) return;
      ev.preventDefault();
      const { metaKey, ctrlKey } = ev;
      void loadMount('cmdkRoot')
        .then(() => {
          document.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'k', metaKey, ctrlKey, bubbles: true }),
          );
        })
        .catch(() => undefined);
    },
    { capture: true },
  );
}

let rootInstance: Root | null = null;

/** 唯一的启动入口：建一个 root 挂全部装配项，并把两个按需加载器登记到能力桥。 */
export function mountAll() {
  if (rootInstance) return;
  // 动态创建空宿主：不往 index.html 加节点（守卫/首屏骨架零改动），
  // 所有真实内容都 portal 到原来的 8 个容器，appRoot 本身始终为空。
  let host = document.getElementById('appRoot');
  if (!host) {
    host = document.createElement('div');
    host.id = 'appRoot';
    document.body.appendChild(host);
  }
  installCmdkShortcut();
  rootInstance = createRoot(host);
  rootInstance.render(
    <React.StrictMode>
      <ErrorBoundary scope="app" label="页面">
        <QueryProvider>
          <App />
        </QueryProvider>
      </ErrorBoundary>
    </React.StrictMode>,
  );
  provide('mountSettings', openSettings);
  provide('mountAi', openAi);
}
