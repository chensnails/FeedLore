/* 测试替身：把组件对 `@core` 的依赖替换成本文件（别名见 tests/ui/build.mjs）。
 *
 * ui-regression.cjs 在 require 挂载入口之前，会把它自己那份与线上同构的桩对象挂到
 * Node 的 globalThis.__uiCore 上（与 window 无关——bundle 在 Node 里跑）。
 * 这样组件仍然走「模块引用」的写法，测试却能完全接管核心逻辑。
 */
export const core = globalThis.__uiCore || {};
