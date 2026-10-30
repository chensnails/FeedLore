/**
 * UI 真机检查（Edge headless + CDP）：
 *   1) 打开 v2 测试站，截图登录页；
 *   2) 用原生 setter 填表并提交（React 受控输入必须这样触发）；
 *   3) 截图登录后的频道/条目页，点开一条验证阅读层，并回读页面文本 / 控制台错误。
 *
 * ⚠️ 运行前先 `taskkill //F //IM msedge.exe`：Edge 是单实例的，已有实例时新进程会把
 *    URL 甩给老实例就退出，于是 --user-data-dir 指定的干净 profile 根本没生效 ——
 *    表现是「首屏已经是登录态、填表步骤报 no-form」，看着像脚本 bug，其实是复用了旧会话。
 *
 * 用法：node scripts/ui-check.mjs http://172.26.1.2:3211 admin <密码>
 */

import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const [url = 'http://172.26.1.2:3211', user = 'admin', pass = ''] = process.argv.slice(2);
const PORT = 9333;

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

async function shot(name) {
  const msg = await send('Page.captureScreenshot', { format: 'png' });
  const data = msg.result?.data;
  if (!data) throw new Error('截图数据为空');
  const p = join(process.cwd(), name);
  writeFileSync(p, Buffer.from(data, 'base64'));
  console.log(`  截图 → ${p}`);
}

function evalJs(expression) {
  return send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }).then((r) => r.result?.result?.value);
}

/**
 * 等一条 toast 出现并读它。
 * ⚠️ 不能「睡够时间再读一次」：toast 只显示两三秒，而刷新全部要 2~10 秒，
 * 睡 12s 再读必然读到空字符串 —— 那就成了「测试通过但什么都没验证」。
 * 这里每 250ms 轮询，抓到第一条非空就返回。
 */
async function waitToast(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const t = await evalJs("document.querySelector('.toast')?.innerText ?? ''");
    if (t) last = t;
    if (last && !(await evalJs("!!document.querySelector('.toast')"))) return last;
    if (last) return last;
    await sleep(250);
  }
  return last;
}

/** 点掉当前 toast（toast 点击即关闭）。否则下一步会读到上一条操作的残留文案。 */
async function clearToast() {
  await evalJs("document.querySelector('.toast')?.click()");
  await sleep(200);
}

try {
  // 等 CDP 端口就绪
  let targets = null;
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      targets = await res.json();
      if (targets?.length) break;
    } catch {
      /* 还没起来 */
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
  });
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });

  await send('Page.enable');
  await send('Runtime.enable');

  console.log(`[ui] 打开 ${url}`);
  await send('Page.navigate', { url });
  await sleep(2500);

  const bootText = (await evalJs('document.body.innerText')) ?? '';
  console.log(`  首屏文本：${JSON.stringify(bootText.slice(0, 80))}`);
  await shot('ui-login.png');

  if (!pass) throw new Error('缺少密码参数');

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
    const btn = document.querySelector('.btn.primary');
    if (!btn) return 'no-btn';
    btn.click();
    return 'clicked';
  })()`);
  console.log(`  填表：${filled}`);

  await sleep(3000);
  const afterText = (await evalJs('document.body.innerText')) ?? '';
  console.log(`  登录后文本：${JSON.stringify(afterText.slice(0, 160))}`);
  await shot('ui-feeds.png');

  const feedCount = await evalJs("document.querySelectorAll('.feed').length");
  const cardCount = await evalJs("document.querySelectorAll('.card').length");
  console.log(`  频道行数：${feedCount}（含「全部频道」）  条目卡片：${cardCount}`);

  // 点开第一条，验证阅读层能拿到详情（列表不带正文，详情才带）
  if (cardCount > 0) {
    await evalJs("document.querySelector('.card').click()");
    await sleep(1500);
    const readerText = (await evalJs("document.querySelector('.reader-body')?.innerText ?? ''")) ?? '';
    const hasSheet = await evalJs("!!document.querySelector('.reader-sheet')");
    console.log(`  阅读层：${hasSheet ? '已打开' : '未打开'}，正文 ${readerText.length} 字`);
    await shot('ui-reader.png');

    // 阅读层里的收藏按钮（写操作的最短路径：点完看它自己变没变）
    const favBefore = await evalJs("document.querySelector('.reader-actions .btn.ghost')?.innerText ?? ''");
    await evalJs("document.querySelector('.reader-actions .btn.ghost')?.click()");
    await sleep(1200);
    const favAfter = await evalJs("document.querySelector('.reader-actions .btn.ghost')?.innerText ?? ''");
    console.log(`  阅读层收藏：${JSON.stringify(favBefore)} → ${JSON.stringify(favAfter)}`);
    // 撤回，别改测试库状态
    await evalJs("document.querySelector('.reader-actions .btn.ghost')?.click()");
    await sleep(900);

    await evalJs("document.querySelector('.reader-close')?.click()");
    await sleep(400);
  }

  // 【写操作】列表里的收藏按钮
  if (cardCount > 0) {
    await evalJs("document.querySelector('.card-row .fav-btn')?.click()");
    await sleep(1200);
    const on = await evalJs("document.querySelector('.card-row .fav-btn')?.classList.contains('on')");
    console.log(`  列表收藏按钮：${on ? '已收藏（★ 高亮）' : '未生效'}`);
    if (on) {
      await evalJs("document.querySelector('.card-row .fav-btn')?.click()");
      await sleep(900);
    }
  }

  // 【写操作】全部已读
  await clearToast();
  const readAllBtn = await evalJs(`(() => {
    const b = [...document.querySelectorAll('.list-actions .btn')].find((x) => x.innerText.includes('全部已读'));
    if (!b) return 'no-btn';
    b.click();
    return 'clicked';
  })()`);
  const toastText = await waitToast(8000);
  console.log(`  全部已读：${readAllBtn}，提示=${JSON.stringify(toastText)}`);

  // 【写操作】刷新全部（会真的回源，等得比普通操作久）
  await clearToast();
  const refreshClicked = await evalJs(`(() => {
    const b = document.querySelector('[aria-label="刷新全部频道"]');
    if (!b) return 'no-btn';
    b.click();
    return 'clicked';
  })()`);
  await sleep(800);
  const refreshToast = await waitToast(20000);
  const cardsAfterRefresh = await evalJs("document.querySelectorAll('.card').length");
  console.log(`  刷新全部：${refreshClicked}，提示=${JSON.stringify(refreshToast)}，卡片 ${cardCount} → ${cardsAfterRefresh}`);
  await shot('ui-refresh.png');

  // 【写操作】单频道刷新（频道行 hover 才出现的 ⟳，headless 下用 click() 直接触发）
  await clearToast();
  const oneRefresh = await evalJs(`(() => {
    const b = document.querySelector('.feed-row .feed-ops .icon-btn');
    if (!b) return 'no-btn';
    b.click();
    return b.getAttribute('aria-label') || 'clicked';
  })()`);
  const oneToast = await waitToast(20000);
  console.log(`  单频道刷新：${oneRefresh}，提示=${JSON.stringify(oneToast)}`);

  // 【写操作】主题切换 → 验证 data-theme 真的变了 → 还原
  const themeBefore = await evalJs("document.documentElement.dataset.theme || 'auto'");
  await evalJs("document.querySelector('.topbar-right .btn.icon')?.click()");
  await sleep(1200);
  const themeAfter = await evalJs("document.documentElement.dataset.theme || 'auto'");
  console.log(`  主题切换：${themeBefore} → ${themeAfter}`);
  await evalJs(
    `fetch('/api/prefs',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({appearance:{theme:${JSON.stringify(themeBefore)}}})}).then(r=>r.status)`,
  );
  await sleep(600);

  // 【写操作】添加频道（会立即抓一次；example.com/ui-check.xml 是 404，
  //   所以期望提示是「已添加，但源站报错：HTTP 404」——这同时验证了「抓取失败不算创建失败」）
  await evalJs("[...document.querySelectorAll('.add-toggle')].find((b)=>b.innerText.includes('添加频道'))?.click()");
  await sleep(300);
  await clearToast();
  const added = await evalJs(`(() => {
    const setVal = (el, v) => {
      const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      d.set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const inputs = document.querySelectorAll('.add-feed .input');
    if (inputs.length < 1) return 'no-input';
    setVal(inputs[0], 'https://example.com/ui-check.xml');
    const form = document.querySelector('.add-feed form');
    if (!form) return 'no-form';
    form.requestSubmit();
    return 'submitted';
  })()`);
  const addToast = await waitToast(20000);
  const feedRowsAfter = await evalJs("document.querySelectorAll('.feed-row').length");
  console.log(`  添加频道：${added}，频道行 ${feedCount - 1} → ${feedRowsAfter}，提示=${JSON.stringify(addToast)}`);
  const cleanup = await evalJs(`(async () => {
    const j = await (await fetch('/api/feeds')).json();
    const f = (j.feeds || []).find((x) => x.url.includes('ui-check.xml'));
    if (!f) return 'not-found';
    const r = await fetch('/api/feeds/' + f.id, { method: 'DELETE' });
    return 'deleted:' + r.status;
  })()`);
  console.log(`  清理测试频道：${cleanup}`);
  await shot('ui-write.png');

  console.log(errors.length ? `  控制台错误：\n  - ${errors.join('\n  - ')}` : '  控制台无错误');
  process.exitCode = feedCount > 1 && cardCount > 0 ? 0 : 1;
} catch (e) {
  console.error('[ui] 失败：', e.message);
  process.exitCode = 1;
} finally {
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  edge.kill();
}
