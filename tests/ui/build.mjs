/* 用 esbuild 把各挂载入口打包成 CJS，供 ui-regression.cjs 在 jsdom 中 require。
 * 产物写到 tests/ui/.build/（gitignored）。运行：`npm run test:ui`。
 *
 * 关键点：组件统一 `import { core } from '@core'`，这里把 `@core` 别名指向 tests/ui/stub-core.js，
 * 于是测试能完全接管核心逻辑（不再需要挂 window.shiyue）。真实的 src/core 只由 core-entry.js
 * （冒烟用，不做别名）加载。 */
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const STUB = path.join(DIR, 'stub-core.js');

const COMMON = {
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  loader: { '.jsx': 'jsx' },
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"' },
  logLevel: 'warning',
};

const TARGETS = [
  ['mount-settings.jsx', '.build/mount-settings.cjs'],
  ['mount-ai.jsx', '.build/mount-ai.cjs'],
  ['mount-cards.jsx', '.build/mount-cards.cjs'],
  ['mount-reader.jsx', '.build/mount-reader.cjs'],
  ['mount-shell.jsx', '.build/mount-shell.cjs'],
  ['mount-overlays.jsx', '.build/mount-overlays.cjs'],
];

await Promise.all(TARGETS.map(([infile, outfile]) => build({
  ...COMMON,
  entryPoints: [path.join(DIR, infile)],
  outfile: path.join(DIR, outfile),
  alias: { '@core': STUB },
})));

// 冒烟：真实核心模块（不加别名），打成 IIFE 由测试内联进 index.html 执行
await build({
  ...COMMON,
  format: 'iife',
  entryPoints: [path.join(DIR, 'core-entry.js')],
  outfile: path.join(DIR, '.build/core-iife.js'),
});

console.log('ui test bundles built →', [...TARGETS.map(([, o]) => o), '.build/core-iife.js'].join(', '));
