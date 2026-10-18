/* 校验 Dockerfile 会不会漏拷文件。
 *
 * 背景：v2.2.0 把后端纯函数抽到 lib/ 后，Dockerfile 里那行
 *   COPY server.js db.js rss.js digest.js proxy.js ./
 * 没跟着加 lib/，镜像构建照样成功，但**容器启动时会 MODULE_NOT_FOUND** ——
 * 本地和 CI 都发现不了，只有部署到服务器才炸。
 *
 * 这个脚本从 Dockerfile 解析出最终镜像的 COPY 清单（不含多阶段构建阶段），
 * 再按 server.js 的 require 图逐个核对。跑法：node tests/server/dockerfile-files.cjs
 * 纯文本处理，无需 Docker。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');

/* ---------------- 1. 解析最终镜像阶段的 COPY 清单 ---------------- */

/** 按 FROM 切段，返回 [{ stage, from }]；builder 阶段用 --from 拷进最终镜像，跳过 */
function stages(text) {
  const out = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const m = line.match(/^FROM\s+(\S+)(?:\s+AS\s+(\S+))?$/i);
    if (m) {
      cur = { image: m[1], name: (m[2] || '').toLowerCase(), copies: [] };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    const c = line.match(/^COPY\s+(.+)$/i);
    if (c) cur.copies.push(c[1].trim());
  }
  return out;
}

const all = stages(dockerfile);
const runtime = all[all.length - 1];
if (!runtime) {
  console.error('❌ 解析 Dockerfile 失败：找不到最终镜像阶段');
  process.exit(1);
}

/** 展开 COPY 的 src 部分 → 仓库内绝对路径集合（跳过 --from 的构建阶段拷贝与索引行） */
function copiedPaths(argstr) {
  const parts = argstr.split(/\s+/).filter(Boolean);
  const srcs = [];
  for (const p of parts) {
    if (p.startsWith('--from=')) break;          // 之后的都是构建阶段产物，不是仓库文件
    if (p.startsWith('--')) continue;
    srcs.push(p);
  }
  const dst = parts[parts.length - 1];
  srcs.pop();                                     // 最后一段是目标
  const out = new Set();
  for (const s of srcs) {
    const abs = path.resolve(ROOT, s);
    if (!fs.existsSync(abs)) { out.add('MISSING:' + abs); continue; }
    if (fs.statSync(abs).isDirectory()) {
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p); else out.add(p);
        }
      };
      walk(abs);
    } else {
      out.add(abs);
    }
  }
  return out;
}

const copied = new Set();
for (const c of runtime.copies) for (const p of copiedPaths(c)) copied.add(p);

/* ---------------- 2. 走一遍 server.js 的相对 require 图 ---------------- */

/** require('./x') → 解析成绝对路径；找不到就记进 missing */
function resolveLocal(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const cand of [base, base + '.js', path.join(base, 'index.js')]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  }
  return null;
}

const seen = new Set();
const missing = new Map();          // 依赖 spec → 引用它的文件
const queue = [path.join(ROOT, 'server.js')];

while (queue.length) {
  const file = queue.pop();
  if (seen.has(file)) continue;
  seen.add(file);
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/require\((['"])(\.[^'"]+)\1\)/g)) {
    const target = resolveLocal(file, m[2]);
    if (!target) {
      if (!missing.has(m[2])) missing.set(m[2], new Set());
      missing.get(m[2]).add(path.relative(ROOT, file));
      continue;
    }
    queue.push(target);
  }
}

/* ---------------- 3. 核对 ---------------- */

let bad = 0;

for (const p of copied) {
  if (typeof p === 'string' && p.startsWith('MISSING:')) {
    console.error('❌ Dockerfile COPY 的源不存在：' + p.slice(8));
    bad++;
  }
}

for (const [spec, by] of missing) {
  console.error(`❌ server.js 依赖 ${spec}，但仓库里找不到（被 ${[...by].join(', ')} 引用）`);
  bad++;
}

const notCopied = [...seen].filter((f) => !copied.has(f));
for (const f of notCopied) {
  console.error(`❌ 运行时会用到但 Dockerfile 没拷：${path.relative(ROOT, f)}`);
  bad++;
}

if (bad) {
  console.error(`\nDockerfile 文件清单校验失败（${bad} 项）。最终镜像阶段已有：`);
  for (const c of runtime.copies) console.error('  COPY ' + c);
  process.exit(1);
}

console.log(`Dockerfile 文件清单校验通过：server.js 依赖图 ${seen.size} 个文件，全部已 COPY 进最终镜像。`);
