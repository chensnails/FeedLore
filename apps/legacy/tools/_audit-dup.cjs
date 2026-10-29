// 审计：无用 import + 重复代码块
const fs = require('fs');
const path = require('path');
const ROOT = process.cwd();
const EXCLUDE = new Set(['node_modules', '.git', 'dist', 'docs', '.workbuddy', '.build', 'tools']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const files = walk(ROOT).map((p) => path.relative(ROOT, p).replace(/\\/g, '/')).filter((f) => /\.(js|jsx|mjs|cjs)$/.test(f));
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

console.log('=== import 了但文件内未使用的标识符 ===');
let n = 0;
for (const f of files) {
  const src = read(f);
  const body = src.replace(/^import[\s\S]*?from\s*['"][^'"]+['"];?$/gm, '');
  for (const m of src.matchAll(/^import\s+(?:(\w+)\s*,?\s*)?(?:\{([^}]+)\})?\s*from\s*['"][^'"]+['"]/gm)) {
    const names = [];
    if (m[1]) names.push(m[1]);
    if (m[2]) m[2].split(',').forEach((s) => {
      const t = s.trim();
      if (!t) return;
      const as = t.split(/\s+as\s+/);
      names.push(as[1] ? as[1].trim() : t);
    });
    for (const name of names) {
      if (!name) continue;
      const re = new RegExp('\\b' + name.replace(/\$/g, '\\$') + '\\b', 'g');
      const count = (body.match(re) || []).length;
      if (count === 0) { console.log('  ' + f.padEnd(36) + name); n++; }
    }
  }
}
if (!n) console.log('  （无）');

console.log('\n=== 重复代码块（≥6 行完全相同，归一化空白后）===');
const index = new Map();
for (const f of files) {
  if (f.startsWith('tests/')) continue;
  const lines = read(f).split('\n').map((l) => l.trim()).filter((l) => l && !/^[})\];]+$/.test(l) && !l.startsWith('//') && !l.startsWith('*'));
  for (let i = 0; i + 6 <= lines.length; i++) {
    const key = lines.slice(i, i + 6).join('|');
    if (key.length < 120) continue;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(f + ':' + (i + 1));
  }
}
let d = 0;
for (const [key, locs] of index) {
  const uniqFiles = new Set(locs.map((x) => x.split(':')[0]));
  if (locs.length > 1 && uniqFiles.size > 1) {
    console.log('  ' + [...uniqFiles].join(' + ') + '  ← ' + key.slice(0, 80).replace(/\|/g, ' ⏎ '));
    d++;
    if (d >= 12) break;
  }
}
if (!d) console.log('  （无跨文件重复）');
