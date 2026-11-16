/* 页面加载性能采集（本地工具，不入库）：真实 Edge + 本地 dist + mock API。
 * 冷启动 / 二次加载（缓存命中）/ 窄屏慢网三组，采 Navigation Timing、Paint、LCP、
 * 资源加载顺序与传输体积、API 请求是否重复。
 * 用法：node .workbuddy/ui-lab/perf-page.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync } from 'node:fs';
import { join, extname, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const DIST = join(ROOT, 'apps/web/dist');
const OUT = join(ROOT, '.workbuddy/qa');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const HTTP_PORT = 9396;
const CDP_PORT = 9397;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (v) => JSON.stringify(v);
mkdirSync(OUT, { recursive: true });

const feeds = [{ id: 1, title: '科技日报', customTitle: '', groupName: '科技', url: 'https://example.com/1', enabled: true, cardEnabled: true, unread: 8, count: 128 }];
const entries = [{
  id: '1', name: '一次把阅读器做对：从资讯流回到卡片行的三次反复',
  desc: '摘要文本。', date: new Date().toISOString(), feedName: '科技日报', feedId: '1',
  image: '', link: 'https://example.com/post/1', sourceUrl: 'https://example.com/post/1',
  links: ['https://example.com/post/1'], tags: ['深度'], isRead: false, isFavorite: false, size: '',
  aiTags: ['电影', '2025'],
}];
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const apiHits = [];
const staticHits = [];
const server = createServer((req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${HTTP_PORT}`);
  const p = u.pathname;
  const send = (code, body, type = 'application/json; charset=utf-8', cache = 'no-store') => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': cache });
    res.end(body);
  };
  if (p.startsWith('/api/')) {
    apiHits.push({ at: Date.now(), path: p, method: req.method });
    if (p === '/api/session') return send(200, json({ authenticated: true, username: 'tester', role: 'admin' }));
    if (p === '/api/feeds') return send(200, json({ feeds, groupOrder: ['科技'], flags: { unread: 8, favorite: 0 }, total: 1, enabled: 1, cardEnabled: 1, refreshMinutes: 30 }));
    if (p === '/api/entries') return send(200, json({ entries, hasMore: false, total: 1, tags: ['深度'] }));
    if (p.startsWith('/api/entries/')) return send(200, json({ ...entries[0], content: '<p>正文。</p>', description: '' }));
    if (p === '/api/prefs') return send(200, json({
      ok: true, digest: {}, rules: [], filters: [], aiTags: { enabled: false },
      llm: { baseUrl: 'https://api.example.com/v1', model: 'neohorse-1-9b', temperature: 0.2, thinking: false, thinkingDepth: 2, apiKeySet: true, apiKeyHint: 'sk-••••••••••••0mmQ' },
    }));
    if (p === '/api/version') return send(200, json({ version: '2.4.6+perf', latest: '2.4.6' }));
    if (p === '/api/status') return send(200, json({ ok: true, db: { ready: true }, feeds: 1, entries: 1 }));
    if (p === '/api/image-cache') return send(200, json({ count: 0, bytes: 0 }));
    if (p === '/api/config') return send(200, json({
      username: 'tester', role: 'admin',
      source: { refreshMinutes: 30, keepPerFeed: 300, keepDays: 365, timeoutSeconds: 25, concurrency: 3, autoRefreshMinutes: 0, proxyUrl: '', imgTtlDays: 7, imgKeepDays: 30, imgMaxDim: 1280, imgQuality: 78, feedFailLimit: 5 },
    }));
    return send(200, json({ ok: true }));
  }
  staticHits.push({ at: Date.now(), path: p });
  let file = join(DIST, p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, ''));
  if (!file.startsWith(DIST)) return send(403, '{}');
  if (!existsSync(file)) file = join(DIST, 'index.html');
  let body = readFileSync(file);
  if (file.endsWith('index.html')) {
    const inject = '<script>window.__LAYOUT__={view:"grid",tab:"reader",sort:"new",rdScope:"all",readerSideWidth:232,accordion:false,sections:{},collapsedGroups:[],rdCollapsedGroups:[],digestEnabled:true};</script>';
    body = Buffer.from(body.toString('utf8').replace('<head>', '<head>' + inject));
  }
  // 性能测量专用：生产环境 assets 带 immutable，但这里统一 no-store，
  // 否则浏览器 HTTP 缓存会让「首次加载」测不到真实字节与传输耗时。
  return send(200, body, MIME[extname(file)] || 'application/octet-stream', 'no-store');
});
await new Promise((r) => server.listen(HTTP_PORT, '127.0.0.1', r));

const profile = mkdtempSync(join(tmpdir(), 'feedlore-perf-'));
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
let ws, seq = 0;
const pending = new Map();
function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`${method} 超时`)); } }, 20000);
  });
}
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'evaluate 异常');
  return r.result?.result?.value;
};
async function waitFor(expression, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await evalJs(expression)) return true; await sleep(120); }
  return false;
}
let target;
for (let i = 0; i < 60 && !target; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    target = list.find((t) => t.type === 'page');
  } catch (_) { /* 还没起来 */ }
  if (!target) await sleep(200);
}
ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => { ws.addEventListener('open', r); });
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  const p = pending.get(m.id);
  if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m); }
});
await send('Page.enable');
await send('Runtime.enable');
const noSwHook = process.argv.includes('--no-sw')
  ? `try{Object.defineProperty(navigator,'serviceWorker',{configurable:true,value:{register:()=>Promise.reject(new Error('sw disabled for perf test')),getRegistrations:async()=>[],getRegistration:async()=>undefined,addEventListener(){},removeEventListener(){}}});}catch(e){}`
  : '';
await send('Page.addScriptToEvaluateOnNewDocument', { source: noSwHook + `
(() => {
  const p = { paints: [], lcp: 0, bootAt: 0, bootError: false };
  window.__perf = p;
  try {
    new PerformanceObserver((l) => l.getEntries().forEach((e) => p.paints.push([e.name, Math.round(e.startTime)])))
      .observe({ type: 'paint', buffered: true });
    new PerformanceObserver((l) => { const es = l.getEntries(); if (es.length) p.lcp = Math.round(es[es.length - 1].startTime); })
      .observe({ type: 'largest-contentful-paint', buffered: true });
    const obs = new MutationObserver(() => {
      const b = document.getElementById('appBoot');
      if (b && !p.bootAt && (b.classList.contains('is-done') || b.classList.contains('is-error'))) {
        p.bootAt = Math.round(performance.now());
        p.bootError = b.classList.contains('is-error');
      }
      if (!b) obs.disconnect();
    });
    document.addEventListener('DOMContentLoaded', () => obs.observe(document.documentElement, { subtree: true, attributes: true, childList: true }));
  } catch (e) { p.observerError = String(e); }
})();
` });

const COLLECT = `(() => {
  const nav = performance.getEntriesByType('navigation')[0] || {};
  const r = (v) => Math.round(v || 0);
  const res = performance.getEntriesByType('resource').map((e) => ({
    name: e.name.replace(location.origin, ''), type: e.initiatorType,
    start: r(e.startTime), ttfb: r(e.responseStart - e.startTime), dur: r(e.duration),
    transfer: e.transferSize || 0, encoded: e.encodedBodySize || 0, decoded: e.decodedBodySize || 0,
  })).sort((a, b) => a.start - b.start);
  return {
    nav: { ttfb: r(nav.responseStart), dcl: r(nav.domContentLoadedEventEnd), load: r(nav.loadEventEnd), duration: r(nav.duration) },
    paints: window.__perf?.paints || [], lcp: window.__perf?.lcp || 0,
    bootAt: window.__perf?.bootAt || 0, bootError: window.__perf?.bootError || false,
    resources: res,
    api: res.filter((x) => x.name.indexOf('/api/') === 0),
    assets: res.filter((x) => x.name.indexOf('/assets/') === 0),
  };
})()`;

async function run(label, { width = 1280, height = 900, mobile = false, throttle = false, reload = false, clearCache = false }) {
  apiHits.length = 0;
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  await send('Network.enable');
  if (clearCache) await send('Network.clearBrowserCache');
  if (throttle) {
    await send('Network.setCacheDisabled', { cacheDisabled: true });
    await send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 200000, uploadThroughput: 75000 });
    await send('Emulation.setCPUThrottlingRate', { rate: 4 });
  } else {
    await send('Network.setCacheDisabled', { cacheDisabled: false });
    await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await send('Emulation.setCPUThrottlingRate', { rate: 1 });
  }
  const t0 = Date.now();
  if (reload) await send('Page.reload', { ignoreCache: false });
  else await send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/?case=${encodeURIComponent(label)}&t=${Date.now()}` });
  await waitFor("document.querySelectorAll('#readerList .art-item').length > 0 || !!document.querySelector('#appBoot.is-error')", throttle ? 40000 : 20000);
  await sleep(throttle ? 2500 : 1500);
  const data = await evalJs(COLLECT);
  const dup = {};
  for (const a of apiHits) dup[a.path] = (dup[a.path] || 0) + 1;
  return { label, wallMs: Date.now() - t0, ...data, apiServerHits: dup, staticServerHits: staticHits.map((s) => s.path) };
}

/* 每组单独一次运行（独立 Edge 进程 + 全新 profile），避免上一组的磁盘/内存缓存污染冷启动数据。
 * 用法：node perf-page.mjs cold | warm | mobile */
const mode = process.argv[2] || 'cold';
const results = [];
if (mode === 'cold') results.push(await run('cold-desktop', {}));
else if (mode === 'warm') {
  await run('warm-preload', {});
  staticHits.length = 0; apiHits.length = 0;
  results.push(await run('warm-desktop', { reload: true }));
} else if (mode === 'mobile') results.push(await run('mobile-slow3g', { width: 390, height: 844, mobile: true, throttle: true }));
else throw new Error('unknown mode: ' + mode);
const suffix = process.argv.includes('--no-sw') ? '-nosw' : '';
writeFileSync(join(OUT, `perf-page-${mode}${suffix}.json`), JSON.stringify(results, null, 2));
for (const r of results) {
  console.log(`\n[${r.label}] wall=${r.wallMs}ms ttfb=${r.nav.ttfb} dcl=${r.nav.dcl} load=${r.nav.load} fcp=${r.paints.find((p) => p[0] === 'first-contentful-paint')?.[1] ?? '-'} lcp=${r.lcp} boot=${r.bootAt}`);
  console.log('  assets:', r.assets.map((a) => `${a.name.split('/').pop()}(${a.start}+${a.dur},${a.transfer}B)`).join(' '));
  console.log('  api:', JSON.stringify(r.apiServerHits));
  console.log('  static-server:', JSON.stringify(r.staticServerHits));
}
try { edge.kill(); } catch (_) { /* ignore */ }
server.close();
process.exit(0);
