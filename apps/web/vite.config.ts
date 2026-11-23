import { readFileSync } from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * 首屏骨架内联：从 style.css 抽取 CRITICAL_SHELL 标记之间的规则，构建时注入
 * **主站 index.html** 的 <head>。
 *
 * 为什么不在 index.html 手写一份：手写副本必然与全量 CSS 漂移 —— 主题色改了
 * 内联没改，首屏就会先闪一个旧颜色。同源抽取让两者永远一致，全量 CSS 到达时
 * 覆盖同值规则，用户看不到跳变。
 *
 * 骨架是三套主题 × 各强调色的 CSS 变量 + 基础排版 + `.wrap` 规则 —— 这是
 * 「首帧就按 localStorage 应用主题、不闪白」的必要成本，不是可以随手删的冗余。
 * 构建时去掉注释与连续空行（声明一字不动），把内联体积压下来。
 * login.html / change-password.html **不注入**：它们是独立文档，自带 login.css
 * 里的全套主题变量，注入整站骨架纯属重复下载。
 */
function inlineCriticalShell(): Plugin {
  return {
    name: 'feedlore-inline-critical-shell',
    apply: 'build',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        // 只给主站注入；两个独立文档有自己的 login.css 主题层（约省 20KB/页）
        if (!ctx.path.endsWith('/index.html')) return html;
        try {
          const css = readFileSync(path.resolve(import.meta.dirname, 'src/style.css'), 'utf8');
          const m =
            /\/\* ==== CRITICAL_SHELL:START ====[\s\S]*?\*\/([\s\S]*?)\/\* ==== CRITICAL_SHELL:END ==== \*\//.exec(
              css,
            );
          const shell = m?.[1];
          if (!shell) return html;
          // 骨架里的注释（主题说明、断点索引）是给维护者看的，浏览器不需要；
          // 只去注释与多余空行，声明保持原样，首帧视觉完全不变。
          const compact = shell
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
          const block = `<style id="criticalShell">\n${compact}\n</style>`;
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
