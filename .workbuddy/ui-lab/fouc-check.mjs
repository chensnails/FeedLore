/* 首屏 FOUC 核对：拦住 CSS 请求让它晚到，检查此刻首屏已有正确主题底色与容器宽度。 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { join, extname, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const DIST = join(ROOT, 'apps/web/dist');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const HP = 9406, CP = 9407;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const api = (p) => {
  if (p === '/api/session') return { authenticated: true, username: 't', role: 'admin' };
  if (p === '/api/feeds') return { feeds: [{ id: 1, title: 'F', url: 'https://e.com/1', enabled: true, cardEnabled: true, groupName: '' }], groupOrder: [''], flags: { unread: 1 }, total: 1, enabled: 1, cardEnabled: 1, refreshMinutes: 30 };
  if (p === '/api/entries') return { entries: [{ id: '1', name: '标题', desc: '', date: new Date().toISOString(), feedName: 'F', feedId: '1', image: '', link: '', links: [], tags: [], isRead: false, isFavorite: false }], hasMore: false, total: 1 };
  if (p === '/api/prefs') return { ok: true, digest: {}, rules: [], filters: [], aiTags: { enabled: false }, llm: {} };
  if (p === '/api/config') return { username: 't', role: 'admin', source: { refreshMinutes: 30, keepPerFeed: 300, keepDays: 365, timeoutSeconds: 25, concurrency: 3, autoRefreshMinutes: 0, proxyUrl: '', imgTtlDays: 7, imgKeepDays: 30, imgMaxDim: 1280, imgQuality: 78, feedFailLimit: 5 } };
  return { ok: true };
};
let holdCss = true;
const waiters = [];
const server = createServer((req, res) => {
  const p = new URL(req.url, `http://127.0.0.1:${HP}`).pathname;
  if (p.startsWith('/api/')) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(api(p)));
  }
  if (p.endsWith('.css') && holdCss) {
    waiters.push(() => {
      res.writeHead(200, { 'Content-Type': 'text/css' });
      res.end(readFileSync(join(DIST, p.replace(/^\/+/, ''))));
    });
    return;
  }
  let f = join(DIST, p === '/' ? 'index.html' : p.replace(/^\/+/, ''));
  if (!existsSync(f)) f = join(DIST, 'index.html');
  let body = readFileSync(f);
  if (f.endsWith('index.html')) body = Buffer.from(body.toString().replace('<head>', '<head><script>window.__LAYOUT__={view:"grid",tab:"reader",rdScope:"all"};</script>'));
  res.writeHead(200, { 'Content-Type': MIME[extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(body);
});
await new Promise((r) => server.listen(HP, '127.0.0.1', r));
const profile = mkdtempSync(join(tmpdir(), 'fouc-'));
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${CP}`, `--user-data-dir=${profile}`, '--no-first-run', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
let ws, seq = 0; const pending = new Map();
const send = (method, params = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' timeout')); } }, 15000); }); };
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true }); return r.result?.result?.value; };
for (let i = 0; i < 60 && !ws; i++) { try { const l = await (await fetch(`http://127.0.0.1:${CP}/json/list`)).json(); const t = l.find((x) => x.type === 'page'); if (t) { ws = new WebSocket(t.webSocketDebuggerUrl); } } catch {} if (!ws) await sleep(200); }
await new Promise((r) => ws.addEventListener('open', r));
ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); const p = pending.get(d.id); if (p) { pending.delete(d.id); d.error ? p.reject(new Error(d.error.message)) : p.resolve(d); } });
await send('Page.enable'); await send('Runtime.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('feedlore.appearance.v2',JSON.stringify({theme:'dark'}))}catch(e){}` });
await send('Page.navigate', { url: `http://127.0.0.1:${HP}/` });
await sleep(1200);
const before = await ev(`(()=>{const st=getComputedStyle(document.body);const boot=document.getElementById('appBoot');const bs=boot?getComputedStyle(boot):null;return{theme:document.documentElement.getAttribute('data-theme'),bodyBg:st.backgroundColor,bootBg:bs?bs.backgroundColor:null,hasShell:!!document.getElementById('criticalShell'),cssLoaded:[...document.styleSheets].some(s=>s.href&&s.href.indexOf('/assets/')>=0)}})()`);
console.log('CSS 未到达时:', JSON.stringify(before));
holdCss = false; while (waiters.length) waiters.shift()();
await sleep(800);
const after = await ev(`(()=>{const st=getComputedStyle(document.body);return{bodyBg:st.backgroundColor,cssLoaded:[...document.styleSheets].some(s=>s.href&&s.href.indexOf('/assets/')>=0)}})()`);
console.log('CSS 到达后:', JSON.stringify(after));
console.log('结论:', before.hasShell && before.theme === 'dark' && before.bodyBg === after.bodyBg && before.bodyBg === 'rgb(36, 36, 36)' ? 'PASS 首屏深色底色正确、无跳变' : 'FAIL 有跳变');
try { edge.kill(); } catch {} server.close(); process.exit(0);
