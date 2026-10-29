// 笺川（FeedLore）· Vite 构建配置
//
// 多页面应用（MPA）：两个入口 HTML 都在仓库根 ——
//   index.html  主站（阅读 / 卡片 / AI / 设置）
//   login.html  登录页（独立页面，自包含样式）
// 其余静态资源（sw.js / manifest / 图标）仍放 public/，由 publicDir 原样拷入 dist/。
// ⚠️ 样式表（style.css / login.css）已移入 src/（v1.5.0），走 Vite 打包才有内容哈希。
//
// 全部界面已 React 化（v2.0.0）：核心逻辑拆在 src/core/*.js（util / state / feeds / reader / autorefresh / ui / bootstrap），经别名 `@core` 暴露 `core` 单例，
// 组件统一 `import { core } from '@core'`；原先的 window.feedlore 全局桥已拆除，
// public/app.js 亦已退役（不再有经典脚本）。

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // 核心逻辑单例（src/core/index.js → app.js）；测试用同名别名换成替身
      '@core': path.resolve(import.meta.dirname, 'src/core/index.js'),
    },
  },
  // public/ 原样拷贝到 dist/：sw.js / 图标 / manifest
  // ⚠️ 样式表（style.css / login.css）已移入 src/（v1.5.0），不再走 publicDir。
  //    原因：public 里的文件是固定路径、不带内容哈希，CDN 会缓存 1~4 小时，
  //    而 index.html 始终是新的 → 新 HTML + 旧 CSS 错配，新增元素完全没有样式。
  publicDir: 'public',
  build: {
    outDir: 'dist',
    // 产物带 hash，文件名稳定可缓存；publicDir 拷出来的文件不带 hash，保持原路径
    rollupOptions: {
      input: {
        index: path.resolve(import.meta.dirname, 'index.html'),
        login: path.resolve(import.meta.dirname, 'login.html'),
      },
      output: {
        // 样式表独立成 chunk，文件名带内容哈希 → 可以放心设长缓存（immutable）
        assetFileNames: 'assets/[name]-[hash][extname]',
        chunkFileNames: 'assets/[name]-[hash].js',
        entryFileNames: 'assets/[name]-[hash].js',
        // React / ReactDOM 单独成 vendor chunk：内容几乎不变 → 哈希稳定 →
        // 用户第二次访问直接命中 CDN 缓存，业务代码改动不必重传 React（弱网下是最大头）。
        manualChunks(id) {
          if (id.includes('node_modules')) return 'vendor';
          return undefined;
        },
      },
    },
    // CSS 单独抽 chunk：主 JS 与主 CSS 可并行下载，不必等 JS 解析完才知道样式在哪
    cssCodeSplit: true,
    // 提高内联阈值上限：sprite 与外观引导脚本内联进 HTML，少两个往返
    assetsInlineLimit: 8192,
    // 关掉 sourcemap 生产产物（不产出 .map 文件，减少体积与请求）
    sourcemap: false,
    // 预加载：把 CSS 与 vendor chunk 提到最高优先级，弱网下先到先画
    modulePreload: { polyfill: true },
  },
  server: {
    port: 5173,
    // 前端 dev server 把 /api 代理到本地后端，前后端分离联调
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: false },
    },
  },
});
