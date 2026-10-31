/**
 * v1 界面运行期冒烟（Edge headless + CDP）。
 *
 * 守的是 jsdom 单测与产物校验都看不见的那一层：
 * - 未登录 → /login.html 的真实跳转（服务端没有拦住，是前端 bootstrap 在跳）；
 * - 登录后服务端注入的 window.__APPEARANCE__ / __LAYOUT__（首屏主题与布局靠它，
 *   注入逻辑一旦在 app.ts 里失效，页面照样能开，只是「暗色用户闪一下白」）；
 * - 列表 / 阅读层 / 三视图切换 / 设置页签这些只有真浏览器 + 真接口才跑得通的路。
 *
 * 用法：node scripts/ui-smoke.mjs http://172.26.1.2:3211 admin <密码>
 * ⚠️ 运行前先 `taskkill //F //IM msedge.exe`：Edge 单实例，已有实例时新进程会把 URL
 *    甩给老实例就退出，--user-data-dir 指定的干净 profile 不生效（= 首屏已是登录态）。
 */

import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const [url = 'http://172.26.1.2:3211', user = 'admin', pass = ''] = process.argv.slice(2);
const PORT = 9335;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'edge-ui-'));
const edge = spawn(
  EDGE,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1280,860',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let ws;
let seq = 0;
const pending = new Map();
const errors = [];

function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`${method} 超时`));
      }
    }, 20000);
  });
}

function evalJs(expression) {
  return send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    .then((r) => r.result?.result?.value);
}

/** 轮询直到表达式为真。固定 sleep 在慢网下必然误报，这里给足超时、条件一到就走。 */
async function waitFor(expression, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evalJs(expression)) return true;
    await sleep(200);
  }
  return false;
}

async function shot(name) {
  const msg = await send('Page.captureScreenshot', { format: 'png' });
  const data = msg.result?.data;
  if (!data) throw new Error('截图数据为空');
  const p = join(process.cwd(), name);
  writeFileSync(p, Buffer.from(data, 'base64'));
  console.log(`  截图 → ${p}`);
}

const fails = [];
const oks = [];
const check = (ok, msg) => {
  (ok ? oks : fails).push(msg);
  console.log(`  ${ok ? '✓' : '✗'} ${msg}`);
};

try {
  let targets = null;
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      targets = await res.json();
      if (targets?.length) break;
    } catch {
      /* 端口还没起来 */
    }
    await sleep(250);
  }
  const page = targets?.find((t) => t.type === 'page');
  if (!page) throw new Error('未找到页面 target');

  ws = new WebSocket(page.webSocketDebuggerUrl);
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params?.exceptionDetails?.exception?.description ?? '异常');
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
      errors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
    /* 原生 confirm/alert 会同步阻塞渲染进程，脚本表现为「卡死」。出现即记错。 */
    if (msg.method === 'Page.javascriptDialogOpening') {
      errors.push(`出现原生 ${msg.params?.type} 对话框 —— 应改用应用内确认框`);
      void send('Page.handleJavaScriptDialog', { accept: false }).catch(() => {});
    }
  });
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  await send('Page.enable');
  await send('Runtime.enable');

  console.log(`[smoke] 打开 ${url}（未登录）`);
  await send('Page.navigate', { url });

  /* 1) 未登录必须落到独立登录页 */
  check(await waitFor("location.pathname === '/login.html'"), '未登录访问 / → 跳到 /login.html');
  check(await waitFor("!!document.querySelector('#loginForm #username')"), '登录页有用户名输入框');
  check(await evalJs("!!document.querySelector('#loginForm #submitBtn')"), '登录页有提交按钮');
  await shot('ui-v1-login.png');

  /* 2) 登录 → 回主站并完成启动 */
  if (!pass) throw new Error('缺少密码参数');
  const filled = await evalJs(`(() => {
    const setVal = (el, v) => {
      const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      d.set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const u = document.querySelector('#loginForm #username');
    const p = document.querySelector('#loginForm #password');
    if (!u || !p) return 'no-form';
    setVal(u, ${JSON.stringify(user)});
    setVal(p, ${JSON.stringify(pass)});
    document.querySelector('#loginForm #submitBtn').click();
    return 'ok';
  })()`);
  check(filled === 'ok', '登录表单已填并提交');

  check(await waitFor("location.pathname === '/'", 20000), '登录成功 → 回到 /');
  check(await waitFor("document.querySelectorAll('.viewnav-btn').length >= 2"), '顶栏视图导航已渲染');
  /* 服务端注入的首屏偏好：暗色 / 侧栏宽度靠它在首帧生效，失效时页面正常但会闪白 */
  check(await evalJs("typeof window.__APPEARANCE__ === 'object' && window.__APPEARANCE__ != null"),
    '服务端注入了 window.__APPEARANCE__');
  /* 首页里带着这个账号的外观/布局；一旦可被缓存，代理就会把 A 的偏好发给 B。
   * Hono 的 compress 在 finalized 后补 Vary 会重建 Response、丢掉 c.res.headers 上的头，
   * 这条断言就是那个坑的哨兵。 */
  const rootCC = await evalJs("fetch('/').then((r) => r.headers.get('cache-control'))");
  check(rootCC === 'no-cache', `首页 Cache-Control=${rootCC}（必须 no-cache）`);

  /* 3) 文章页：频道栏 + 列表 + 展开正文 */
  check(await waitFor("document.querySelectorAll('.rd-ch').length > 0"), '文章页频道栏有频道');
  check(await waitFor("document.querySelectorAll('#readerList .art-item').length > 0", 20000), '文章列表加载出条目');

  const expanded = await evalJs(`(() => {
    const head = document.querySelector('#readerList .art-item .art-head');
    if (!head) return 'no-item';
    head.click();
    return 'clicked';
  })()`);
  check(expanded === 'clicked', '点开第一条');
  check(await waitFor("!!document.querySelector('#readerList .art-item.open .art-body .art-inner')", 20000),
    '阅读层展开并出现正文容器');
  const bodyLen = (await evalJs("document.querySelector('#readerList .art-item.open .art-body')?.innerText.length ?? 0")) ?? 0;
  check(bodyLen > 20, `正文已渲染（${bodyLen} 字）`);
  check(await evalJs("/^#reader\\/art\\/.+/.test(location.hash)"), `展开后 hash 指向条目（${await evalJs('location.hash')}）`);
  await shot('ui-v1-reader.png');

  /* 4) 卡片页：切过去有卡片，视图导航高亮跟着走 */
  await evalJs("document.querySelector('.viewnav-btn[data-view=\"cards\"]')?.click()");
  check(await waitFor("!!document.querySelector('#grid .card, #grid .row-item')", 20000), '卡片页渲染出卡片');
  check(await evalJs("!!document.querySelector('.viewnav-btn[data-view=\"cards\"].active')"), '卡片视图导航高亮');
  await shot('ui-v1-cards.png');

  await evalJs("document.querySelector('.viewnav-btn[data-view=\"reader\"]')?.click()");
  check(await waitFor("!!document.querySelector('#readerList')"), '切回文章页');

  /* 5) 日报：关掉时入口本就不该在，开着才验 */
  const hasDigest = await evalJs("!!document.querySelector('.viewnav-btn[data-view=\"ai\"]')");
  if (hasDigest) {
    await evalJs("document.querySelector('.viewnav-btn[data-view=\"ai\"]')?.click()");
    check(await waitFor("(document.querySelector('#aiRoot')?.innerText.length ?? 0) > 10", 20000), '日报页渲染出内容');
    await evalJs("document.querySelector('.viewnav-btn[data-view=\"reader\"]')?.click()");
  } else {
    console.log('  - 日报已关闭，跳过入口检查');
  }

  /* 6) 设置：页签数量 + 数据源里的每频道采集间隔（v1 把采集参数放在数据源页） */
  await waitFor("!!document.querySelector('#settingsBtn')");
  await evalJs("document.querySelector('#settingsBtn')?.click()");
  check(await waitFor("!!document.querySelector('.modal-mask:not([hidden]) .settings-modal')"), '设置弹层打开');
  const tabCount = (await evalJs("document.querySelectorAll('#tabs .tab').length")) ?? 0;
  check(tabCount >= 7, `设置页签 ${tabCount} 个（≥7）`);
  await evalJs("document.querySelector('#tabs .tab[data-tab=\"source\"]')?.click()");
  check(await waitFor("!!document.querySelector('#settingsPanel #srcRefresh')"), '数据源页渲染出全局采集间隔');
  const freqCount = (await evalJs("document.querySelectorAll('#settingsPanel .feed-freq').length")) ?? 0;
  check(freqCount > 0, `每频道采集间隔下拉 ${freqCount} 个`);
  await shot('ui-v1-settings.png');
  await evalJs("document.querySelector('#settingsClose')?.click()");
  check(await waitFor("!document.querySelector('.modal-mask:not([hidden])')"), '设置弹层可关闭');

  /* 7) 窄屏：频道抽屉是手机端唯一入口，桌面断点下打不开就是死路 */
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
  });
  await sleep(600);
  const menuVisible = await evalJs(`(() => {
    const b = document.querySelector('#readerMenuBtn');
    return !!b && getComputedStyle(b).display !== 'none';
  })()`);
  check(menuVisible, '390px 下频道抽屉按钮可见');
  await evalJs("document.querySelector('#readerMenuBtn')?.click()");
  check(await waitFor("document.body.classList.contains('reader-drawer-open')"), '点按钮后 body 进入抽屉态');
  const sideRect = await evalJs(`(() => {
    const el = document.querySelector('#readerSide');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), left: Math.round(r.left) };
  })()`);
  check(!!sideRect && sideRect.w > 0 && sideRect.left >= 0,
    `抽屉在视口内展开（宽 ${sideRect?.w ?? 0}px，left ${sideRect?.left ?? '-'}）`);
  await shot('ui-v1-phone-drawer.png');
  await evalJs("document.querySelector('#readerSideClose')?.click()");
  check(await waitFor("!document.body.classList.contains('reader-drawer-open')"), '抽屉可收起');
  await send('Emulation.clearDeviceMetricsOverride');

  /* 8) 控制台：真机上不该有任何未捕获错误 */
  const realErrors = errors.filter((e) => !/favicon/i.test(e));
  check(realErrors.length === 0, `控制台错误 ${realErrors.length} 条${realErrors.length ? `：${realErrors.slice(0, 3).join(' | ')}` : ''}`);
} catch (err) {
  fails.push(String(err?.message ?? err));
  console.error(`✗ 冒烟中断：${err?.message ?? err}`);
} finally {
  try { ws?.close(); } catch { /* 忽略 */ }
  try { edge.kill(); } catch { /* 忽略 */ }
}

console.log(`\n冒烟结果：通过 ${oks.length}，失败 ${fails.length}`);
if (fails.length) process.exit(1);
