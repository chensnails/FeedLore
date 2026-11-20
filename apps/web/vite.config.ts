import { readFileSync } from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * 首屏骨架内联：从 style.css 抽取 CRITICAL_SHELL 标记之间的规则（主题变量 +
 * body 基础 + .wrap 容器），构建时注入两个 HTML 入口的 <head>。
 *
 * 为什么不在 index.html 手写一份：手写副本必然与全量 CSS 漂移 —— 主题色改了
 * 内联没改，首屏就会先闪一个旧颜色。同源抽取让两者永远一致，全量 CSS 到达时
 * 覆盖同值规则，用户看不到跳变。骨架只含「首屏必须先有」的十几条规则，
 * 体积远小于 171KB 全量样式表。
 */
function inlineCriticalShell(): Plugin {
  return {
    name: 'feedlore-inline-critical-shell',
    apply: 'build',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        try {
          const css = readFileSync(path.resolve(import.meta.dirname, 'src/style.css'), 'utf8');
          const m =
            /\/\* ==== CRITICAL_SHELL:START ====[\s\S]*?\*\/([\s\S]*?)\/\* ==== CRITICAL_SHELL:END ==== \*\//.exec(
              css,
            );
          const shell = m?.[1];
          if (!shell) return html;
          const block = `<style id="criticalShell">\n${shell.trim()}\n</style>`;
          return html.replace('</head>', `  ${block}\n  </head>`);
        } catch {
          return html;
        }
      },
    },
  };
}

/**
 * 多页面应用（MPA）：
 *   index.html  主站（阅读 / 卡片 / AI / 设置）
 *   login.html  登录页（独立文档，内联脚本，只为把 login.css 纳入打包）
 *
 * `@core` 是核心逻辑单例（src/core/index.js），组件统一 `import { core } from '@core'`。
 * 开发态仍把 /api 代理到本地 Hono（3000），生产由同一容器静态托管，前端不写绝对地址。
 */
export default defineConfig({
  plugins: [react(), inlineCriticalShell()],
  resolve: {
    alias: {
      '@core': path.resolve(import.meta.dirname, 'src/core/index.ts'),
    },
  },
  publicDir: 'public',
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        index: path.resolve(import.meta.dirname, 'index.html'),
        login: path.resolve(import.meta.dirname, 'login.html'),
        changePassword: path.resolve(import.meta.dirname, 'change-password.html'),
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
