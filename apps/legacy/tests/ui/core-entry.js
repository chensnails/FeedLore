/* 冒烟入口：加载「真实」的核心模块（src/core/index.js），把 core 单例挂到 window 上供断言。
 *
 * 用途：v1.9.0 曾因桥里引用了不存在的标识符，app.js 顶层抛 ReferenceError → 整页 JS 中断。
 * 本入口在 jsdom 里真实执行一遍核心模块的顶层代码 + init()，专治这类「顶层崩了但语法检查查不出」的问题。
 */
import { core } from '../../src/core/index.js';

window.__coreForTest = core;
