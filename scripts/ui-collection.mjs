/**
 * 针对性验收：采集设置恢复（Edge headless + CDP）
 *   A. 设置 →「采集参数」页签（admin）：12 个控件全部有值、保存后回填真实值；
 *   B. 设置 →「频道」：单频道间隔下拉改 30 分 → PATCH 生效 → 改回跟随全局；
 *   C. 退出后普通用户登录：看不到「采集参数」「用户管理」页签。
 *
 * 用法：node scripts/ui-collection.mjs http://172.26.1.2:3211 admin <管理员密码> <普通用户名> <普通用户密码>
 * ⚠️ 运行前先 taskkill //F //IM msedge.exe。
 */

import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const [url = 'http://172.26.1.2:3211', user = 'admin', pass = '', plainUser = '', plainPass = ''] =
  process.argv.slice(2);
const PORT = 9338;

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

async function login(u, p) {
  // 登出（可能已登录）→ 硬刷新 → 等登录表单
  await evalJs("fetch('/api/auth/logout',{method:'POST'}).catch(()=>1)");
  await send('Page.navigate', { url: `${url.replace(/\/$/, '')}/?r=${Date.now()}` });
  await sleep(2800);
  const r = await evalJs(`(() => {
    const setVal = (el, v) => {
      const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      d.set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const inputs = document.querySelectorAll('.field input');
    if (inputs.length < 2) return 'no-form';
    setVal(inputs[0], ${JSON.stringify(u)});
    setVal(inputs[1], ${JSON.stringify(p)});
    document.querySelector('.btn.primary')?.click();
    return 'clicked';
  })()`);
  await sleep(3000);
  return r;
}

const openSettings = async () => {
  await evalJs("document.querySelector('[aria-label=\"打开设置\"]')?.click()");
  await sleep(600);
};
const closeSettings = async () => {
  await evalJs("document.querySelector('.prefs-sheet .reader-close')?.click()");
  await sleep(400);
};

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
  await send('Page.navigate', { url });
  await sleep(2600);

  console.log(`[ui] 管理员登录：${await login(user, pass)}`);

  /* ---------- A. 全局采集参数页签 ---------- */
  await openSettings();
  const tabThere = await evalJs(
    "[...document.querySelectorAll('.prefs-sheet .admin-tabs .chip')].some((b) => b.innerText.trim() === '采集参数')",
  );
  await evalJs(
    "[...document.querySelectorAll('.prefs-sheet .admin-tabs .chip')].find((b) => b.innerText.trim() === '采集参数')?.click()",
  );
  await sleep(1200);
  const inputs = (await evalJs("document.querySelectorAll('.prefs-sheet .admin-field input').length")) ?? 0;
  const firstVal = (await evalJs("document.querySelector('.prefs-sheet .admin-field input')?.value")) ?? '';
  const proxyInput = await evalJs("!!document.querySelector('.prefs-sheet .admin-field.wide input')");
  await shot('collection-tab.png');

  // 保存（不改值）→ toast + 表单仍为服务端真实值
  await evalJs("[...document.querySelectorAll('.prefs-sheet .admin-actions .btn')].find((b) => b.innerText.includes('保存'))?.click()");
  await sleep(1500);
  const savedToast = (await evalJs("document.querySelector('.toast')?.innerText ?? ''")) ?? '';
  const valAfterSave = (await evalJs("document.querySelector('.prefs-sheet .admin-field input')?.value")) ?? '';
  await evalJs("document.querySelector('.toast')?.click()");
  console.log(
    `  采集参数页签：存在=${tabThere} 控件=${inputs} 首值=${firstVal} 代理框=${proxyInput} 保存提示=${JSON.stringify(savedToast)} 回填=${valAfterSave}`,
  );
  await closeSettings();

  /* ---------- B. 每频道采集间隔 ---------- */
  await openSettings();
  await evalJs(
    "[...document.querySelectorAll('.prefs-sheet .admin-tabs .chip')].find((b) => b.innerText.trim() === '频道')?.click()",
  );
  await sleep(800);
  const before = await evalJs(
    "document.querySelector('.prefs-sheet .feed-row .feed-interval')?.value ?? 'none'",
  );
  await evalJs(`(() => {
    const sel = document.querySelector('.prefs-sheet .feed-row .feed-interval');
    const setVal = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setVal.call(sel, '30');
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return 1;
  })()`);
  await sleep(1500);
  const after = await evalJs(
    "document.querySelector('.prefs-sheet .feed-row .feed-interval')?.value ?? 'none'",
  );
  await shot('feed-interval.png');
  // 还原成跟随全局
  await evalJs(`(() => {
    const sel = document.querySelector('.prefs-sheet .feed-row .feed-interval');
    const setVal = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setVal.call(sel, '');
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return 1;
  })()`);
  await sleep(1500);
  const restored = await evalJs(
    "document.querySelector('.prefs-sheet .feed-row .feed-interval')?.value ?? 'none'",
  );
  console.log(`  单频道间隔：${JSON.stringify(before)} → 30分=${JSON.stringify(after)} → 还原=${JSON.stringify(restored)}`);
  await closeSettings();

  /* ---------- C. 普通用户看不到两个 admin 页签 ---------- */
  let plainOk = null;
  if (plainUser && plainPass) {
    console.log(`[ui] 普通用户登录：${await login(plainUser, plainPass)}`);
    await openSettings();
    const chips = (await evalJs("[...document.querySelectorAll('.prefs-sheet .admin-tabs .chip')].map((b) => b.innerText.trim())")) ?? [];
    plainOk = !chips.includes('采集参数') && !chips.includes('用户管理');
    console.log(`  普通用户页签：${JSON.stringify(chips)} 无 admin 页签=${plainOk}`);
    await closeSettings();
  } else {
    console.log('  普通用户检查：未提供账号，跳过');
  }

  console.log(errors.length ? `  控制台错误：\n  - ${errors.join('\n  - ')}` : '  控制台无错误');

  const aOk = tabThere && inputs === 12 && proxyInput && savedToast.includes('已保存') && valAfterSave === firstVal;
  const bOk = before !== 'none' && after === '30' && restored === '';
  if (!(aOk && bOk && (plainOk !== false))) {
    console.log('  ⚠️ 验收未全部通过');
    process.exitCode = 1;
  } else {
    console.log('  ✅ 采集设置验收通过');
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
