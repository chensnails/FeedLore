// 笺川（Feedlore）· Vite 构建配置
//
// 多页面应用（MPA）：两个入口 HTML 都在仓库根 ——
//   index.html  主站（阅读 / 卡片 / AI / 设置）
//   login.html  登录页（独立页面，自包含样式）
// 其余静态资源（style.css / sw.js / 图标）仍放 public/，由 publicDir 原样拷入 dist/。
//
// 全部界面已 React 化（v2.0.0）：核心逻辑拆在 src/core/*.js（util / state / feeds / reader / autorefresh / ui / bootstrap），经别名 `@core` 暴露 `core` 单例，
// 组件统一 `import { core } from '@core'`；原先的 window.shiyue 全局桥已拆除，
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
  // public/ 原样拷贝到 dist/：style.css / sw.js / 图标 / manifest
  publicDir: 'public',
  build: {
    outDir: 'dist',
    // 产物带 hash，文件名稳定可缓存；publicDir 拷出来的文件不带 hash，保持原路径
    rollupOptions: {
      input: {
        index: path.resolve(import.meta.dirname, 'index.html'),
        login: path.resolve(import.meta.dirname, 'login.html'),
      },
    },
  },
  server: {
    port: 5173,
    // 前端 dev server 把 /api 代理到本地后端，前后端分离联调
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: false },
    },
  },
});
