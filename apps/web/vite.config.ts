import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/**
 * 多页面应用（MPA），与 v1 一致：
 *   index.html  主站（阅读 / 卡片 / AI / 设置）
 *   login.html  登录页（独立文档，内联脚本，只为把 login.css 纳入打包）
 *
 * `@core` 是 v1 的核心逻辑单例（src/core/index.js），组件统一 `import { core } from '@core'`。
 * 开发态仍把 /api 代理到本地 Hono（3000），生产由同一容器静态托管，前端不写绝对地址。
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@core': path.resolve(import.meta.dirname, 'src/core/index.js'),
    },
  },
  publicDir: 'public',
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        index: path.resolve(import.meta.dirname, 'index.html'),
        login: path.resolve(import.meta.dirname, 'login.html'),
      },
      output: {
        assetFileNames: 'assets/[name]-[hash][extname]',
        chunkFileNames: 'assets/[name]-[hash].js',
        entryFileNames: 'assets/[name]-[hash].js',
        // React 单独成 vendor chunk：内容几乎不变，哈希稳定，业务改动不必重传
        manualChunks(id) {
          if (id.includes('node_modules')) return 'vendor';
          return undefined;
        },
      },
    },
    cssCodeSplit: true,
    assetsInlineLimit: 8192,
    sourcemap: false,
    modulePreload: { polyfill: true },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: false },
    },
  },
});
