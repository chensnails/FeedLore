// 审计：无用导出 / 注释代码块 / CSS 死选择器
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const EXCLUDE = new Set(['node_modules', '.git', 'dist', 'docs', '.workbuddy', '.build']);

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
const code = all.filter((f) => /\.(js|jsx|mjs|cjs)$/.test(f) && !f.startsWith('tools/'));
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const corpusCode = code.map(read).join('\n');
const corpusHtml = all.filter((f) => f.endsWith('.html')).map(read).join('\n');
const corpusAll = corpusCode + '\n' + corpusHtml;

console.log('=== 导出但全仓库无引用 ===');
let deadExports = 0;
for (const f of code) {
  if (f.startsWith('tests/')) continue;
  const src = read(f);
  const names = [];
  for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm)) names.push(m[1]);
  for (const m of src.matchAll(/^export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/gm)) names.push(m[1]);
  for (const m of src.matchAll(/^\s*([A-Za-z0-9_$]+),\s*$/gm)) names.push(m[1]);
  for (const n of new Set(names)) {
    if (n.length < 3) continue;
    const esc = n.replace(/\$/g, '\\$');
    const uses = [...corpusAll.matchAll(new RegExp('\\b' + esc + '\\b', 'g'))].length;
    if (uses <= 1) {
      console.log('  ' + f.padEnd(38) + n + '   （仅出现 ' + uses + ' 次，即定义处）');
      deadExports++;
    }
  }
}
if (!deadExports) console.log('  （无）');

console.log('\n=== 疑似注释掉的代码块（连续 // 或 /* */ 内含代码符号）===');
let blocks = 0;
for (const f of code) {
  const lines = read(f).split('\n');
  let run = [];
  const flush = () => {
    if (run.length >= 2) {
      const joined = run.map((r) => r.text).join(' ');
      if (/[;{}=>]|function|const |let |return /.test(joined)) {
        console.log('  ' + f + ':' + run[0].line + '-' + run[run.length - 1].line + '  (' + run.length + ' 行)');
        run.slice(0, 2).forEach((r) => console.log('      ' + r.text.trim().slice(0, 90)));
        blocks++;
      }
    }
    run = [];
  };
  lines.forEach((ln, i) => {
    const t = ln.trim();
    if (t.startsWith('//') && !t.startsWith('///')) run.push({ line: i + 1, text: t });
    else flush();
  });
  flush();
  for (const m of read(f).matchAll(/\/\*([\s\S]*?)\*\//g)) {
    const body = m[1];
    if (!/[;{}]/.test(body)) continue;
    if (/^\s*[\u4e00-\u9fa5]/.test(body)) continue;
    if ((body.match(/[;{}]/g) || []).length < 2) continue;
    const line = read(f).slice(0, m.index).split('\n').length;
    console.log('  ' + f + ':' + line + '  /* …' + body.trim().split('\n')[0].slice(0, 80) + ' */');
    blocks++;
  }
}
if (!blocks) console.log('  （无）');

console.log('\n=== CSS 里无任何引用的类名（数量前 40）===');
const css = fs.readFileSync(path.join(ROOT, 'src/style.css'), 'utf8');
const cls = new Set();
for (const m of css.matchAll(/\.([a-zA-Z][\w-]*)/g)) cls.add(m[1]);
const usage = new Map();
for (const c of cls) {
  const esc = c.replace(/[-]/g, '\\-');
  const n = [...corpusAll.matchAll(new RegExp('\\b' + esc + '\\b', 'g'))].length;
  usage.set(c, n);
}
const unused = [...usage].filter(([, n]) => n === 0).sort((a, b) => a[0].localeCompare(b[0]));
console.log('  类名总数 ' + cls.size + '，零引用 ' + unused.length);
console.log('  ' + unused.map(([c]) => c).join(' '));
