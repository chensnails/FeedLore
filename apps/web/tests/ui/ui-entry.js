/* 非登录字段自动填充防护的运行时契约入口。
 * 与 kernel-entry.js 同一套路：esbuild 打成 CJS，让 ui-regression.cjs 能在 jsdom 里
 * 真的派发一次「被自动填充」的哨兵动画，而不是只 grep 源码文本。 */
import * as noAutofill from '../../src/ui/noAutofill.js';

window.__noAutofillForTest = noAutofill;
