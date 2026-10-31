/**
 * 针对性验收（Edge headless + CDP）：
 *   A. 移动端边缘手势 —— 左缘右滑打开频道抽屉 / 抽屉开着左滑关闭 / 纵向滑动不误触；
 *   B. 复制链接 —— 单链接直接复制（不弹菜单）；多链接弹选择菜单，
 *      点某条只复制该条、「全部复制」拿整份文本、Esc 只关菜单不关阅读层；
 *      窄屏下菜单贴底弹出（fixed，不溢出视口）。
 *
 * 用法：node scripts/ui-copy-swipe.mjs http://172.26.1.2:3211 admin <密码>
 * ⚠️ 运行前先 taskkill //F //IM msedge.exe（单实例坑见 ui-check.mjs 头注）。
 */

import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const [url = 'http://172.26.1.2:3211', user = 'admin', pass = ''] = process.argv.slice(2);
const PORT = 9334;

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
    '--window-size=400,860',
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

async function shot(name) {
  const msg = await send('Page.captureScreenshot', { format: 'png' });
  if (!msg.result?.data) throw new Error('截图数据为空');
  writeFileSync(join(process.cwd(), name), Buffer.from(msg.result.data, 'base64'));
  console.log(`  截图 → ${name}`);
}

function evalJs(expression) {
  return send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }).then((r) => {
    const ex = r.result?.exceptionDetails;
    if (ex) throw new Error(`页面内异常: ${ex.exception?.description ?? ex.text} @ ${String(expression).slice(0, 90)}`);
    return r.result?.result?.value;
  });
}

/** 一串真实触点（CDP 会派发成原生 touch 事件，window 级监听才收得到）。 */
async function swipe(points) {
  for (const [type, pts] of points) {
    await send('Input.dispatchTouchEvent', {
      type,
      touchPoints: pts === null ? [] : pts.map(([x, y]) => ({ x, y })),
    });
    await sleep(40);
  }
  await sleep(500);
}

async function metrics(w, h, mobile) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: w,
    height: h,
    deviceScaleFactor: 2,
    mobile,
  });
  await send('Emulation.setTouchEmulationEnabled', { enabled: mobile });
  await sleep(700);
}

/* 装一个剪贴板探针：headless + **纯 HTTP（非安全上下文）** 下 navigator.clipboard
 * 根本不存在，应用走 legacyCopy（execCommand + 临时 textarea）。
 * 光看 toast 证明不了复制内容，直接挂住 textarea.select 记下入参。
 * （HTTPS 环境下 clipboard.writeText 也可用，两路都挂。） */
const CLIP_SPY = `(() => {
  window.__copied = null;
  if (navigator.clipboard) navigator.clipboard.writeText = (t) => { window.__copied = t; return Promise.resolve(); };
  if (!HTMLTextAreaElement.prototype.__spied) {
    const orig = HTMLTextAreaElement.prototype.select;
    HTMLTextAreaElement.prototype.select = function () { window.__copied = this.value; return orig.call(this); };
    HTMLTextAreaElement.prototype.__spied = true;
  }
  return 1;
})()`;

try {
  let targets = null;
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      targets = await res.json();
      if (targets?.length) break;
    } catch {}
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
    if (msg.method === 'Runtime.exceptionThrown')
      errors.push(msg.params?.exceptionDetails?.exception?.description ?? '异常');
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error')
      errors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  });
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });

  await send('Page.enable');
  await send('Runtime.enable');

  console.log(`[ui] 打开 ${url}（390×844 触屏）`);
  await metrics(390, 844, true);
  await send('Page.navigate', { url });
  await sleep(2600);

  const filled = await evalJs(`(() => {
    const setVal = (el, v) => {
      const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      d.set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const inputs = document.querySelectorAll('.field input');
    if (inputs.length < 2) return 'no-form';
    setVal(inputs[0], ${JSON.stringify(user)});
    setVal(inputs[1], ${JSON.stringify(pass)});
    document.querySelector('.btn.primary')?.click();
    return 'clicked';
  })()`);
  console.log(`  登录：${filled}`);
  await sleep(3200);

  /* ---------- A. 边缘手势 ---------- */
  const drawerOpen = () => evalJs("!!document.querySelector('.sidebar.open')");

  await swipe([
    ['touchStart', [[5, 420]]],
    ['touchMove', [[50, 420]]],
    ['touchMove', [[100, 420]]],
    ['touchEnd', null],
  ]);
  const openedBySwipe = await drawerOpen();
  console.log(`  左缘右滑 → 抽屉打开=${openedBySwipe}`);
  await shot('swipe-open.png');

  // 打开着再从左缘右滑：不应有额外反应（仍是打开态）
  await swipe([
    ['touchStart', [[5, 420]]],
    ['touchMove', [[100, 420]]],
    ['touchEnd', null],
  ]);
  const stillOpen = await drawerOpen();

  await swipe([
    ['touchStart', [[260, 420]]],
    ['touchMove', [[190, 420]]],
    ['touchMove', [[120, 420]]],
    ['touchEnd', null],
  ]);
  const closedBySwipe = !(await drawerOpen());
  console.log(`  抽屉开着左滑 → 关闭=${closedBySwipe}（重复打开手势无副作用=${stillOpen}）`);

  // 纵向滑动：列表滚动，不应打开抽屉
  await swipe([
    ['touchStart', [[5, 300]]],
    ['touchMove', [[10, 380]]],
    ['touchMove', [[12, 460]]],
    ['touchEnd', null],
  ]);
  const verticalSafe = !(await drawerOpen());
  console.log(`  纵向滑动不误触=${verticalSafe}`);

  // 阅读层开着时手势让路：先滑动打开抽屉，再点一条条目，左滑不应关抽屉（抽屉本来就该被关掉）
  await swipe([
    ['touchStart', [[5, 420]]],
    ['touchMove', [[100, 420]]],
    ['touchEnd', null],
  ]);
  await evalJs("document.querySelector('.cards .card-row .card')?.click()");
  await sleep(1500);
  const readerUp = await evalJs("!!document.querySelector('.reader-sheet')");
  const drawerAfterOpenEntry = !(await drawerOpen());
  await swipe([
    ['touchStart', [[260, 420]]],
    ['touchMove', [[120, 420]]],
    ['touchEnd', null],
  ]);
  const readerStillUp = await evalJs("!!document.querySelector('.reader-sheet')");
  console.log(
    `  打开条目：阅读层=${readerUp} 抽屉已收=${drawerAfterOpenEntry} 阅读层内左滑不关层=${readerStillUp}`,
  );
  await evalJs("document.querySelector('.reader-close')?.click()");
  await sleep(500);

  const swipeOk = openedBySwipe && stillOpen && closedBySwipe && verticalSafe && readerUp && drawerAfterOpenEntry && readerStillUp;

  /* ---------- B0. 窄屏贴底菜单（必须在切桌面视口之前做：
      触摸模拟开↔关 + 视口切换后，合成 click 会进入「点了没反应」的残留状态） ---------- */
  let bottomOk = null;
  await evalJs(`(() => {
    const row = document.querySelectorAll('.cards .card-row')[0];
    row?.querySelector('.card')?.click();
    return 1;
  })()`);
  await sleep(1500);
  await evalJs(
    "[...document.querySelectorAll('.reader-actions .btn')].find((b) => b.innerText.includes('复制链接'))?.click()",
  );
  await sleep(500);
  const mrect = await evalJs(`(() => {
    const m = document.querySelector('.copy-menu');
    const r = m?.getBoundingClientRect();
    return r ? { left: Math.round(r.left), right: Math.round(r.right), bottom: Math.round(r.bottom), vh: innerHeight, vw: innerWidth, fixed: getComputedStyle(m).position } : null;
  })()`);
  if (mrect) {
    bottomOk =
      mrect.fixed === 'fixed' &&
      mrect.left >= 0 &&
      mrect.right <= mrect.vw &&
      Math.abs(mrect.bottom - (mrect.vh - 12)) < 24;
    console.log(`  窄屏贴底菜单：${JSON.stringify(mrect)} 合法=${bottomOk}`);
  } else {
    console.log('  窄屏贴底菜单：#0 非多链接或菜单未开，跳过');
  }
  await shot('copy-menu-mobile.png');
  await evalJs("document.querySelector('.reader-close')?.click()");
  await sleep(500);

  /* ---------- B. 复制链接 ---------- */
  await metrics(1280, 860, false);
  // ⚠️ 触摸模拟开↔关切换后，前面真实 touch 序列会残留某种输入状态，
  // 合成 click 不再触发 React 处理器（点击后 hash 都不变）。刷新给复制段一个干净环境；
  // 手势段的真实触摸验收已经跑完，不受影响。
  await send('Page.reload');
  await sleep(3600);
  await evalJs(CLIP_SPY);
  // 插桩：原生层点击计数，判断「事件没发出」还是「React 没响应」
  await evalJs(`(() => {
    window.__cap = 0;
    window.addEventListener('click', () => { window.__cap += 1; }, true);
    return 1;
  })()`);

  let multi = null; // {idx, count}
  let single = null; // {idx, copied}
  const total = (await evalJs("document.querySelectorAll('.cards .card-row').length")) ?? 0;
  console.log(`  扫描 ${total} 条找多/单链接样本`);
  const scan = Math.min(total, 16);
  for (let i = 0; i < scan && !(multi && single); i += 1) {
    const clickRet = await evalJs(`(() => {
      const row = document.querySelectorAll('.cards .card-row')[${i}];
      if (!row) return 'no-row';
      const card = row.querySelector('.card');
      if (!card) return 'no-card';
      card.click();
      return 'clicked:' + card.tagName + ':' + (card.className || '');
    })()`);
    if (i === 0) console.log(`  #0 点击返回：${clickRet}`);
    await sleep(1300);
    const label = await evalJs(
      "[...document.querySelectorAll('.reader-actions .btn')].find((b) => b.innerText.includes('复制链接'))?.innerText ?? ''",
    );
    if (!label) {
      console.log(
        `  #${i}：无复制链接按钮（reader=${await evalJs("!!document.querySelector('.reader-sheet')")} cap=${await evalJs('window.__cap')} hash=${await evalJs('location.hash')} cards=${await evalJs("document.querySelectorAll('.cards').length")}`,
      );
      await evalJs("document.querySelector('.reader-close')?.click()");
      await sleep(400);
      continue;
    }
    const m = label.match(/（(\d+)）/);
    await evalJs(CLIP_SPY);
    if (m) {
      // 多链接：点按钮应弹菜单而不是直接复制
      await evalJs(
        "[...document.querySelectorAll('.reader-actions .btn')].find((b) => b.innerText.includes('复制链接'))?.click()",
      );
      await sleep(400);
      const menuUp = await evalJs("!!document.querySelector('.copy-menu')");
      const items = (await evalJs("document.querySelectorAll('.copy-menu .copy-url').length")) ?? 0;
      const itemCount = (await evalJs("document.querySelector('.copy-menu .copy-all')?.innerText ?? ''")) ?? '';
      if (menuUp && items === Number(m[1])) {
        // 点第一条：只复制那一条
        await evalJs("document.querySelector('.copy-menu .copy-url')?.click()");
        await sleep(500);
        const firstCopied = (await evalJs('window.__copied')) ?? '';
        // Esc 只关菜单不关阅读层（只派发一次：派两次会「关菜单→菜单没了→第二次关整层」）
        await evalJs(
          "[...document.querySelectorAll('.reader-actions .btn')].find((b) => b.innerText.includes('复制链接'))?.click()",
        );
        await sleep(300);
        await evalJs("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
        await sleep(400);
        const menuGone = await evalJs("!document.querySelector('.copy-menu')");
        const readerStill = await evalJs("!!document.querySelector('.reader-sheet')");
        // 全部复制
        await evalJs(
          "[...document.querySelectorAll('.reader-actions .btn')].find((b) => b.innerText.includes('复制链接'))?.click()",
        );
        await sleep(300);
        await evalJs("document.querySelector('.copy-menu .copy-all')?.click()");
        await sleep(500);
        const allCopied = (await evalJs('window.__copied')) ?? '';
        const allLineCount = allCopied ? allCopied.split('\n').length : 0;
        multi = { idx: i, count: Number(m[1]), firstCopied, allLineCount, menuGone, readerStill };
        console.log(`  多链接条目 #${i}：菜单=${menuUp} 条目数=${items}/${m[1]}`);
        console.log(`    单条复制=${JSON.stringify(firstCopied.slice(0, 60))}`);
        console.log(`    全部复制行数=${allLineCount} Esc关菜单=${menuGone} 阅读层仍在=${readerStill}`);
      } else {
        multi = { idx: i, count: Number(m[1]), firstCopied: '', allLineCount: 0, menuGone: false, readerStill: false };
        console.log(`  ⚠️ 多链接条目 #${i}：菜单=${menuUp} 条目数=${items}/${m[1]}（不符）`);
      }
    } else {
      // 单链接：直接复制、不弹菜单
      await evalJs(
        "[...document.querySelectorAll('.reader-actions .btn')].find((b) => b.innerText.includes('复制链接'))?.click()",
      );
      await sleep(500);
      const menuUp = await evalJs("!!document.querySelector('.copy-menu')");
      const copied = (await evalJs('window.__copied')) ?? '';
      single = { idx: i, copied, menuUp };
      console.log(`  单链接条目 #${i}：无菜单=${!menuUp} 复制=${JSON.stringify(copied.slice(0, 60))}`);
    }
    await evalJs("document.querySelector('.reader-close')?.click()");
    await sleep(400);
  }

  await shot('copy-swipe-final.png');
  console.log(errors.length ? `  控制台错误：\n  - ${errors.join('\n  - ')}` : '  控制台无错误');

  const copyOk = multi ? multi.menuGone && multi.readerStill && multi.firstCopied.startsWith('http') : true;
  const singleOk = single ? !single.menuUp && single.copied.startsWith('http') : true;
  if (!(swipeOk && copyOk && singleOk && (multi ? bottomOk !== false : true))) {
    console.log('  ⚠️ 验收未全部通过');
    process.exitCode = 1;
  } else {
    console.log('  ✅ 边缘手势 + 复制链接 验收通过');
  }
} catch (e) {
  console.error('[ui] 失败：', e.message);
  process.exitCode = 1;
} finally {
  try {
    ws?.close();
  } catch {}
  edge.kill();
}
