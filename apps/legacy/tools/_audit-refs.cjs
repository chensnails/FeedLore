// 引用图分析：找出零引用的源码文件、未使用的依赖
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const EXCLUDE = new Set(['node_modules', '.git', 'dist', 'docs', 'screenshots', '.workbuddy', '.build']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const all = walk(ROOT).map((p) => path.relative(ROOT, p).replace(/\\/g, '/'));
const codeFiles = all.filter((f) => /\.(js|jsx|mjs|cjs)$/.test(f));
const EXT = ['', '.js', '.jsx', '.mjs', '.cjs', '/index.js', '/index.jsx'];

function resolveSpec(from, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.posix.dirname(from);
  const target = path.posix.normalize(path.posix.join(base, spec));
  for (const ext of EXT) {
    const cand = target + ext;
    if (all.includes(cand)) return cand;
  }
  return null;
}

const edges = new Map();
const external = new Map();

for (const f of codeFiles) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const specs = new Set();
  const re = /(?:from\s*|require\(\s*|import\(\s*|^import\s+)['"]([^'"]+)['"]/gm;
  let m;
  while ((m = re.exec(src))) specs.add(m[1]);
  const resolved = [];
  for (const s of specs) {
    if (s.startsWith('.')) {
      const r = resolveSpec(f, s);
      if (r) resolved.push(r);
      else resolved.push('!!UNRESOLVED:' + s + ' (from ' + f + ')');
    } else if (!s.startsWith('node:')) {
      const pkg = s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0];
      if (!external.has(pkg)) external.set(pkg, new Set());
      external.get(pkg).add(f);
    }
  }
  edges.set(f, resolved);
}

const inbound = new Map();
for (const [, outs] of edges) for (const o of outs) inbound.set(o, (inbound.get(o) || 0) + 1);

// 额外引用来源：HTML <script src> / <link href>，sw.js 预缓存列表，CSS url()
const htmlRefs = new Set();
const swRefs = new Set();
const cssRefs = new Set();
for (const f of all.filter((x) => /\.(html|css|js)$/.test(x))) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  if (f.endsWith('.html')) {
    for (const m of src.matchAll(/(?:src|href)="([^"]+)"/g)) if (!/^https?:|^data:|^#/.test(m[1])) htmlRefs.add(m[1].replace(/^\//, ''));
  }
  if (f === 'public/sw.js') for (const m of src.matchAll(/['"](\/[^'"]+)['"]/g)) swRefs.add(m[1].replace(/^\//, ''));
  if (f.endsWith('.css')) for (const m of src.matchAll(/url\((['"]?)([^)'"]+)\1\)/g)) if (!/^data:|^https?:/.test(m[2])) cssRefs.add(m[2].replace(/^\//, ''));
}

const entries = new Set(['src/main.jsx', 'server.js']);
const neverImported = codeFiles.filter((f) => !inbound.has(f) && !entries.has(f));

console.log('=== 代码文件总数 ===', codeFiles.length);
console.log('\n=== 零引用代码文件（无任何 import/require 指向）===');
for (const f of neverImported) {
  const extra = [];
  if (htmlRefs.has(f)) extra.push('HTML引用');
  if (swRefs.has(f)) extra.push('SW预缓存');
  console.log('  ' + f + (extra.length ? '   [' + extra.join(',') + ']' : ''));
}

console.log('\n=== 外部包被谁 import ===');
for (const [pkg, files] of [...external].sort()) {
  console.log('  ' + pkg.padEnd(18) + ' <- ' + [...files].join(', '));
}

const declared = new Set([
  ...Object.keys(require(path.join(ROOT, 'package.json')).dependencies || {}),
  ...Object.keys(require(path.join(ROOT, 'package.json')).devDependencies || {}),
]);
const used = new Set(external.keys());
console.log('\n=== 声明了但代码里没出现 ===');
for (const d of declared) if (!used.has(d)) console.log('  ' + d);
console.log('\n=== 代码里用了但没声明 ===');
for (const u of used) if (!declared.has(u)) console.log('  ' + u);

console.log('\n=== 静态资源引用情况 ===');
const assets = all.filter((f) => /\.(png|ico|svg|jpe?g|webp|woff2?|json|webmanifest)$/i.test(f) && !f.startsWith('docs/'));
for (const a of assets) {
  const base = a.replace(/^public\//, '');
  const hit = [];
  if (htmlRefs.has(base) || htmlRefs.has(a)) hit.push('html');
  if (swRefs.has(base) || swRefs.has(a)) hit.push('sw');
  if (cssRefs.has(base) || cssRefs.has(a)) hit.push('css');
  const byCode = [...codeFiles].some((c) => {
    const s = fs.readFileSync(path.join(ROOT, c), 'utf8');
    return s.includes(base) || s.includes(a);
  });
  if (byCode) hit.push('code');
  console.log('  ' + (hit.length ? '✓' : '✗') + ' ' + a.padEnd(40) + hit.join(','));
}

console.log('\n=== 解析失败的 import ===');
let bad = 0;
for (const [f, outs] of edges) for (const o of outs) if (o.startsWith('!!')) { console.log('  ' + o); bad++; }
if (!bad) console.log('  （无）');
