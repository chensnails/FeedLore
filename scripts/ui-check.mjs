/**
 * UI 真机检查（Edge headless + CDP）：
 *   1) 打开 v2 测试站，截图登录页；
 *   2) 用原生 setter 填表并提交（React 受控输入必须这样触发）；
 *   3) 截图登录后的频道页，并回读页面文本 / 控制台错误。
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
  console.log(`  频道行数：${feedCount}`);

  console.log(errors.length ? `  控制台错误：\n  - ${errors.join('\n  - ')}` : '  控制台无错误');
  process.exitCode = feedCount > 0 ? 0 : 1;
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
