import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 开发态：vite dev server 把 /api 代理到本地 Hono（3000），所以前端代码里
 * 一律用同源相对路径，不出现 `http://localhost:3000` 这种硬编码——生产构建后
 * 正好由同一个 Hono 静态托管，代码零改动。
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    // 资源带内容哈希（v1.x 的 CDN 缓存事故铁律）：assets/xxx-<hash>.js|css
    assetsDir: 'assets',
  },
});
