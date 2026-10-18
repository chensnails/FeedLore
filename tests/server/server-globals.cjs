/* server.js「被抽走的标识符是否仍被裸引用」检查。
 *
 * 背景：v2.2.0 把纯函数抽到 lib/ 时，用「起止锚点区间删除」清理旧实现，
 * 误把 `IMG_CACHE_TTL` / `imgCache` 一起删了 —— 它们是被 proxyImage 闭包持有的
 * **运行时状态**，不是纯函数。结果：容器正常启动、健康检查通过、启动日志无异常，
 * 但每次请求 /api/img 都抛 `ReferenceError: imgCache is not defined`。
 * 只有真正加载出带图文章的用户才会发现。
 *
 * 为什么常规手段抓不到：
 *   - `node --check` 只查语法，ReferenceError 是运行时的
 *   - 启动与健康检查都不碰图片代理
 *   - 前端 UI 回归与后端单测都不 require server.js
 *
 * 做法：拿一个「抽出之前」的基线版本（默认 v2.1.0，可用 SHIYUE_BASELINE 覆盖），
 * 列出它声明过的顶层标识符，找出在当前 server.js 里已经消失的那些，
 * 再逐个检查当前文件是否还在**裸引用**它：
 *   - 顶部有 require 解构 → 已从 lib/ 引进，正常
 *   - 只剩零散出现（如 `imgCache.get`）且没有声明 → 漏删了运行时状态，报错
 *
 * 跑法：node tests/server/server-globals.cjs
 * 基线覆盖：SHIYUE_BASELINE=v2.0.0 node tests/server/server-globals.cjs
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const BASELINE = process.env.SHIYUE_BASELINE || 'v2.1.0';

const current = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

let baseline;
try {
  baseline = execFileSync('git', ['show', `${BASELINE}:server.js`], {
    cwd: ROOT, maxBuffer: 1e8, encoding: 'utf8',
  });
} catch (e) {
  console.error(`❌ 取不到基线版本 ${BASELINE}：${e.message}`);
  console.error('   （需要该 tag 在本地仓库存在；可用 SHIYUE_BASELINE 指定其它版本）');
  process.exit(2);
}

/* ---------------- 顶层声明 ---------------- */

/** 收集行首的 const/let/var 与 function/class 声明（即模块级标识符） */
function topLevelDecls(src) {
  const out = new Set();
  let m;
  const reConst = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
  while ((m = reConst.exec(src)) !== null) out.add(m[1]);
  const reFn = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm;
  while ((m = reFn.exec(src)) !== null) out.add(m[1]);
  const reCls = /^class\s+([A-Za-z_$][\w$]*)/gm;
  while ((m = reCls.exec(src)) !== null) out.add(m[1]);
  return out;
}

const before = topLevelDecls(baseline);
const after = topLevelDecls(current);
const gone = [...before].filter((n) => !after.has(n));

if (!gone.length) {
  console.log(`server.js 标识符检查通过：相对 ${BASELINE} 没有顶层标识符消失。`);
  process.exit(0);
}

/* ---------------- 当前文件里是否还裸引用 ---------------- */

/** 去掉注释与字符串，避免注释里的词造成误判 */
function stripNoise(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
}

const code = stripNoise(current);

/** 顶部 require 解构里引进的名字 —— 这些是「已从 lib/ 引进」，属正常 */
const imported = new Set();
for (const m of code.matchAll(/const\s*\{([^}]*)\}\s*=\s*require\(/g)) {
  for (const part of m[1].split(',')) {
    const name = part.split(':').pop().split('=')[0].trim();
    if (/^[A-Za-z_$][\w$]*$/.test(name)) imported.add(name);
  }
}

const problems = [];
for (const name of gone) {
  if (imported.has(name)) continue;                 // 已从 lib/ 引进
  const re = new RegExp(`\\b${name}\\b`, 'g');
  const hits = [...code.matchAll(re)];
  if (!hits.length) continue;                        // 完全没人用了，删对了
  // 还在被用：看是不是只在「声明」位置（理论上不会，因为我们查的就是消失的）
  problems.push({ name, count: hits.length });
}

if (problems.length) {
  console.error(`❌ 有 ${problems.length} 个标识符在基线 ${BASELINE} 里声明过、现在却「消失但仍被引用」：`);
  for (const p of problems) {
    console.error(`   ${p.name}  （当前文件中出现 ${p.count} 次，但已无声明）`);
  }
  console.error('\n这类问题的后果：容器能启动、健康检查能过、启动日志干净，');
  console.error('但真正调用到它的那个请求才抛 ReferenceError（v2.2.0 的 imgCache 就是这么上线的）。');
  console.error('修法：若它是纯函数 → 从 lib/ 顶部 require 进来；');
  console.error('     若它是运行时状态（缓存 Map / 定时器句柄）→ 补回 server.js 的声明。');
  process.exit(1);
}

console.log(
  `server.js 标识符检查通过：相对 ${BASELINE} 消失的 ${gone.length} 个顶层标识符均已从 lib/ 引入，无裸引用。`,
);
