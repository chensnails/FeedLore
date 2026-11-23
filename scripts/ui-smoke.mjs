/**
 * 界面运行期冒烟（Edge headless + CDP）。
 *
 * 守的是 jsdom 单测与产物校验都看不见的那一层：
 * - 未登录 → /login.html 的真实跳转（服务端没有拦住，是前端 bootstrap 在跳）；
 * - 登录后服务端注入的 window.__LAYOUT__（布局按账号走，首屏靠它）；
 *   外观已改存本机 localStorage，服务端不再注入 __APPEARANCE__；
 * - 列表 / 阅读层 / 三视图切换 / 设置页签这些只有真浏览器 + 真接口才跑得通的路。
 *
 * 用法：node scripts/ui-smoke.mjs http://172.26.1.2:3211 admin <密码>
 * ⚠️ 运行前先 `taskkill //F //IM msedge.exe`：Edge 单实例，已有实例时新进程会把 URL
 *    甩给老实例就退出，--user-data-dir 指定的干净 profile 不生效（= 首屏已是登录态）。
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const [url = 'http://172.26.1.2:3211', user = 'admin', pass = ''] = process.argv.slice(2);
// 用随机高位端口：固定端口撞上上次残留的 headless Edge 时，新实例会连到旧进程，
// 旧 profile 已是登录态，导致「未登录 → 登录页」那几条假失败（真机验证踩过）。
const PORT = 9300 + Math.floor(Math.random() * 600);

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
  return send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }).then(
    (r) => r.result?.result?.value,
  );
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
  await shot('ui-login.png');

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
  check(
    await waitFor("document.querySelectorAll('.viewnav-btn').length >= 2"),
    '顶栏视图导航已渲染',
  );
  /* 布局仍由服务端按账号注入；外观只存本机，服务端不该再注入 __APPEARANCE__ */
  check(
    await evalJs("typeof window.__LAYOUT__ === 'object' && window.__LAYOUT__ != null"),
    '服务端注入了 window.__LAYOUT__',
  );
  check(
    await evalJs('window.__APPEARANCE__ === undefined'),
    '服务端不再注入 window.__APPEARANCE__（外观只存本机）',
  );
  // 外观只存本机；applyTheme 启动时会把当前主题写回（{"theme":"auto"}），
  // 所以不要求为空，只要求它不含账号维度的字段、且服务端不注入（上一条已断言）。
  const apprSafe = await evalJs(
    "(()=>{try{const a=JSON.parse(localStorage.getItem('feedlore.appearance.v2')||'null');return a===null||(typeof a==='object'&&!('username' in a)&&!('userId' in a));}catch(e){return false;}})()",
  );
  check(apprSafe, '外观只存本机、不含账号字段');
  /* 首页里带着这个账号的外观/布局；一旦可被缓存，代理就会把 A 的偏好发给 B。
   * Hono 的 compress 在 finalized 后补 Vary 会重建 Response、丢掉 c.res.headers 上的头，
   * 这条断言就是那个坑的哨兵。 */
  const rootCC = await evalJs("fetch('/').then((r) => r.headers.get('cache-control'))");
  check(rootCC === 'no-cache', `首页 Cache-Control=${rootCC}（必须 no-cache）`);

  /* 3) 文章页：频道栏 + 列表 + 展开正文 */
  check(await waitFor("document.querySelectorAll('.rd-ch').length > 0"), '文章页频道栏有频道');
  check(
    await waitFor("document.querySelectorAll('#readerList .art-item').length > 0", 20000),
    '文章列表加载出条目',
  );

  const expanded = await evalJs(`(() => {
    const head = document.querySelector('#readerList .art-item .art-head');
    if (!head) return 'no-item';
    head.click();
    return 'clicked';
  })()`);
  check(expanded === 'clicked', '点开第一条');
  check(
    await waitFor(
      "!!document.querySelector('#readerList .art-item.open .art-body .art-inner')",
      20000,
    ),
    '阅读层展开并出现正文容器',
  );
  /* 正文是异步拉的：容器先出现、内容后到，所以等「有字」而不是等容器。 */
  const bodyLen = await (async () => {
    const deadline = Date.now() + 20000;
    let n = 0;
    while (Date.now() < deadline) {
      n =
        (await evalJs(
          "document.querySelector('#readerList .art-item.open .art-body')?.innerText.length ?? 0",
        )) ?? 0;
      if (n > 20) break;
      await sleep(300);
    }
    return n;
  })();
  check(bodyLen > 20, `正文已渲染（${bodyLen} 字）`);
  const artHash = await evalJs('location.hash');
  check(/^#reader\/art\/.+/.test(artHash), `展开后 hash 指向条目（${artHash}）`);
  await shot('ui-reader.png');

  /* 4) 卡片页：切过去有卡片，视图导航高亮跟着走 */
  await evalJs('document.querySelector(\'.viewnav-btn[data-view="cards"]\')?.click()');
  check(
    await waitFor("!!document.querySelector('#grid .card, #grid .row-item')", 20000),
    '卡片页渲染出卡片',
  );
  /* 三视图各自渲染一份 ViewNav，DOM 里有多组同名按钮；只认「看得见的那组」高亮。 */
  check(
    await waitFor(
      `[...document.querySelectorAll('.viewnav-btn[data-view="cards"]')]
    .some((b) => b.classList.contains('active') && b.getBoundingClientRect().width > 0)`,
      5000,
    ),
    '卡片视图导航高亮',
  );
  await shot('ui-cards.png');

  await evalJs('document.querySelector(\'.viewnav-btn[data-view="reader"]\')?.click()');
  check(await waitFor("!!document.querySelector('#readerList')"), '切回文章页');

  /* 5) 日报：关掉时入口本就不该在，开着才验 */
  const hasDigest = await evalJs('!!document.querySelector(\'.viewnav-btn[data-view="ai"]\')');
  if (hasDigest) {
    await evalJs('document.querySelector(\'.viewnav-btn[data-view="ai"]\')?.click()');
    check(
      await waitFor("(document.querySelector('#aiRoot')?.innerText.length ?? 0) > 10", 20000),
      '日报页渲染出内容',
    );
    await evalJs('document.querySelector(\'.viewnav-btn[data-view="reader"]\')?.click()');
  } else {
    console.log('  - 日报已关闭，跳过入口检查');
  }

  /* 6) 设置：入口在 ⋮ 溢出菜单，检查页签数量 + 数据源里的每频道采集间隔 */
  await evalJs("document.querySelector('.overflow-btn')?.click()");
  check(await waitFor("!!document.querySelector('.overflow-menu')"), '⋮ 溢出菜单可展开');
  await evalJs(`[...document.querySelectorAll('.overflow-menu .overflow-item')]
    .find((b) => b.innerText.trim() === '设置')?.click()`);
  check(
    await waitFor("!!document.querySelector('.modal-mask:not([hidden]) .settings-modal')"),
    '设置弹层打开',
  );
  const tabCount = (await evalJs("document.querySelectorAll('#tabs .tab').length")) ?? 0;
  check(tabCount >= 7, `设置页签 ${tabCount} 个（≥7）`);
  await evalJs('document.querySelector(\'#tabs .tab[data-tab="source"]\')?.click()');
  check(
    await waitFor("!!document.querySelector('#settingsPanel #srcRefresh')"),
    '数据源页渲染出全局采集间隔',
  );
  // feed-freq 在「列表 + 详情两层」重构后只存在于频道详情层（FeedSheet）内，
  // 冒烟这里没打开任何频道，所以要先点开一行再数（否则恒为 0）。
  await evalJs("document.querySelector('#settingsPanel .feed-row')?.click()");
  await waitFor("!!document.querySelector('.ds-sheet')", 5000);
  const freqCount = (await evalJs("document.querySelectorAll('.ds-sheet .feed-freq').length")) ?? 0;
  check(freqCount > 0, `每频道采集间隔下拉 ${freqCount} 个（详情层内）`);
  await shot('ui-settings.png');
  await evalJs("document.querySelector('#settingsClose')?.click()");
  check(await waitFor("!document.querySelector('.modal-mask:not([hidden])')"), '设置弹层可关闭');

  /* 7) 窄屏：频道抽屉是手机端唯一入口，桌面断点下打不开就是死路。
     开触摸模拟：真机是 touch 而非 mouse，纯 .click() 会漏掉「触屏才触发」的回归。 */
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
  });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await sleep(600);
  const menuVisible = await evalJs(`(() => {
    const b = document.querySelector('#readerMenuBtn');
    return !!b && getComputedStyle(b).display !== 'none';
  })()`);
  check(menuVisible, '390px 下频道抽屉按钮可见');
  /* 用真实 touch 事件（CDP dispatchTouchEvent）点开抽屉，而非合成 DOM click：
     确保触屏命中区 / pointer 事件这条路径真的通。 */
  const menuRect = await evalJs(`(() => {
    const r = document.querySelector('#readerMenuBtn')?.getBoundingClientRect();
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  })()`);
  if (menuRect) {
    await send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: menuRect.x, y: menuRect.y }],
    });
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  check(
    await waitFor("document.body.classList.contains('reader-drawer-open')"),
    'touch 点按钮后 body 进入抽屉态',
  );
  /* 抽屉是 transition 滑入的，class 先到、位移后到，要等它真正进到视口里。 */
  check(
    await waitFor(
      `(() => {
    const r = document.querySelector('#readerSide')?.getBoundingClientRect();
    return !!r && r.width > 0 && r.left >= 0;
  })()`,
      5000,
    ),
    '抽屉滑入视口',
  );
  const sideRect = await evalJs(`(() => {
    const el = document.querySelector('#readerSide');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), left: Math.round(r.left) };
  })()`);
  check(
    !!sideRect && sideRect.w > 0 && sideRect.w < 390,
    `抽屉宽度合理（${sideRect?.w ?? 0}px，left ${sideRect?.left ?? '-'}）`,
  );
  await shot('ui-phone-drawer.png');
  await evalJs("document.querySelector('#readerSideClose')?.click()");
  check(await waitFor("!document.body.classList.contains('reader-drawer-open')"), '抽屉可收起');

  /* 7b) 窄屏输入字号：iOS 聚焦 <16px 输入框会放大整页且缩不回。
       走真实⋮→设置，读设置面板文本输入的 computed font-size。 */
  await evalJs("document.querySelector('.overflow-btn')?.click()");
  check(await waitFor("!!document.querySelector('.overflow-menu')"), '窄屏 ⋮ 菜单可展开');
  await evalJs(`[...document.querySelectorAll('.overflow-menu .overflow-item')]
    .find((b) => b.innerText.trim() === '设置')?.click()`);
  await waitFor(
    "!!document.querySelector('.settings-modal :is(input, textarea):not([type=checkbox]):not([type=radio])')",
    6000,
  );
  const fsPx =
    (await evalJs(`(() => {
      const el = document.querySelector('.settings-modal :is(input, textarea):not([type=checkbox]):not([type=radio])');
      return el ? parseFloat(getComputedStyle(el).fontSize) : 0;
    })()`)) ?? 0;
  check(fsPx >= 16, `窄屏设置输入字号 ${fsPx}px ≥16（iOS 聚焦不缩放）`);
  await evalJs("document.querySelector('#settingsClose')?.click()");
  check(
    await waitFor("!document.querySelector('.modal-mask:not([hidden])')"),
    '窄屏设置弹层可关闭',
  );

  /* 7c) 窄屏确认框几何：V5 曾把 .modal 用 Portal 甩出遮罩，长页面被推到视口外只剩黑遮罩。
       ⋮ 菜单里的「全部已读」只在文章页且有未读时出现，数据状态会变——所以这里软触发：
       能触发就断言矩形在视口内（守回归），触发不到只记提示、不算失败（避免数据被标光时假红）。 */
  {
    await evalJs("document.querySelector('.overflow-btn')?.click()");
    await waitFor("!!document.querySelector('.overflow-menu')", 5000);
    const readAllClicked = await evalJs(`(() => {
      const b = [...document.querySelectorAll('.overflow-menu .overflow-item')]
        .find((x) => x.innerText.includes('全部已读'));
      if (!b) return false;
      b.click();
      return true;
    })()`);
    if (readAllClicked) {
      await waitFor("!!document.querySelector('#confirmBox')", 6000);
      const cg =
        (await evalJs(`(() => {
          const el = document.querySelector('#confirmBox');
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 ? { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: innerHeight } : null;
        })()`)) ?? null;
      check(
        !!cg && cg.top >= 0 && cg.top < cg.vh && cg.bottom > 0 && cg.bottom <= cg.vh + 1,
        `窄屏确认框在视口内（top ${cg?.top ?? '-'} / bottom ${cg?.bottom ?? '-'} / vh ${cg?.vh ?? '-'}）`,
      );
      await shot('ui-phone-confirm.png');
      await evalJs("document.querySelector('.confirm-foot .btn-ghost')?.click()");
      check(await waitFor("!document.querySelector('#confirmBox')"), '窄屏确认框可取消');
    } else {
      console.log('  - 当前视图无「全部已读」入口，跳过确认框几何断言（数据/视图依赖）');
      // 不能点第一个菜单项来关菜单：那是「刷新」，会触发一次列表重拉，
      // 后面的 7d 有时正好撞上重拉中的空菜单。Esc 才是菜单自己的关闭路径。
      await evalJs(
        "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))",
      );
      await waitFor("!document.querySelector('.overflow-menu')", 3000);
    }
  }

  /* 7d) 模态与抽屉手势互斥：弹层打开时右滑不能把背后的频道抽屉拉出来。
       只等 .overflow-menu 存在不够：7c 的刷新重拉期会留下空菜单壳，必须等菜单项真的渲染出来。 */
  let modalOpened = false;
  for (let attempt = 0; attempt < 2 && !modalOpened; attempt += 1) {
    await evalJs(`(() => {
      const b = [...document.querySelectorAll('.overflow-btn')].find((x) => x.getClientRects().length && !x.disabled);
      b?.click();
      return !!b;
    })()`);
    await waitFor("document.querySelectorAll('.overflow-menu .overflow-item').length > 0", 4000);
    await evalJs(`[...document.querySelectorAll('.overflow-menu .overflow-item')]
      .find((b) => b.innerText.trim() === '设置')?.click()`);
    modalOpened = await waitFor(
      "!!document.querySelector('.modal-mask:not([hidden]) .settings-modal')",
      6000,
    );
  }
  check(modalOpened, '模态守门：设置弹层已打开');
  await send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: 40, y: 600 }],
  });
  for (const x of [110, 180, 260]) {
    await send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y: 602 }],
    });
  }
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  check(
    !(await evalJs(
      "document.body.classList.contains('reader-drawer-open') || document.body.classList.contains('cards-drawer-open')",
    )),
    '模态守门：右滑没有拉出背后的频道抽屉',
  );
  await evalJs("document.querySelector('#settingsClose')?.click()");
  check(
    await waitFor("!document.querySelector('.modal-mask:not([hidden])')"),
    '模态守门：设置弹层可关闭',
  );

  await send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await send('Emulation.clearDeviceMetricsOverride');

  /* 8) 深链启动分派：真 reload 带 hash → bootstrap 按 hash 选视图并清筛选。
   * 这是 V4.0 就标注的测试缺口：此前只有 util.hash / bootstrap 的源码文本守卫，
   * 没有「hash 真的把视图切过去」的行为断言。纯函数 matchViewHash 已有 kernel 单测，
   * 但 bootstrap 里的启动分派（hash → switchView + 清 rd* 筛选）此前无 DOM 覆盖。 */
  const base = new URL(url).origin + new URL(url).pathname.replace(/\/$/, '');
  /* 条目级深链用前面展开第一条时记下的 hash（真实存在的 id），重载后应自动展开。 */
  const deepCases = [
    [
      '#cards',
      '卡片页',
      () => waitFor("!!document.querySelector('#grid .card, #grid .row-item')", 20000),
    ],
    [
      '#ai',
      'AI 页',
      () => waitFor("(document.querySelector('#aiRoot')?.innerText.length ?? 0) > 10", 20000),
    ],
  ];
  for (const [hash, label, ready] of deepCases) {
    await send('Page.navigate', { url: base + hash });
    check(await ready(), `深链 ${hash} reload → ${label}渲染`);
    check(
      await waitFor(
        `[...document.querySelectorAll('.viewnav-btn[data-view="${hash.slice(1)}"]')]
          .some((b) => b.classList.contains('active') && b.getBoundingClientRect().width > 0)`,
        5000,
      ),
      `深链 ${hash} reload → ${label}导航高亮`,
    );
  }
  /* 展开态 hash 为 #reader/art/<id>：重载后应自动展开该篇，且筛选被清空
   * （rdScope=all / rdQ='' 等由源码守卫钉住，这里断言可观察的后果：条目可见且已展开）。 */
  if (artHash && /^#reader\/art\/.+/.test(artHash)) {
    await send('Page.navigate', { url: base + artHash });
    check(
      await waitFor("document.querySelectorAll('#readerList .art-item').length > 0", 20000),
      '条目深链 reload → 文章列表加载',
    );
    check(
      await waitFor(
        "!!document.querySelector('#readerList .art-item.open .art-body .art-inner')",
        20000,
      ),
      '条目深链 reload → 目标文章自动展开（筛选已让位）',
    );
    check(
      await waitFor('!!document.querySelector(\'.viewnav-btn[data-view="reader"].active\')', 5000),
      '条目深链 reload → 文章页导航高亮',
    );
  }

  /* 控制台：真机上不该有任何未捕获错误 */
  const realErrors = errors.filter((e) => !/favicon/i.test(e));
  check(
    realErrors.length === 0,
    `控制台错误 ${realErrors.length} 条${realErrors.length ? `：${realErrors.slice(0, 3).join(' | ')}` : ''}`,
  );
} catch (err) {
  fails.push(String(err?.message ?? err));
  console.error(`✗ 冒烟中断：${err?.message ?? err}`);
} finally {
  try {
    ws?.close();
  } catch {
    /* 忽略 */
  }
  try {
    edge.kill();
  } catch {
    /* 忽略 */
  }
}

console.log(`\n冒烟结果：通过 ${oks.length}，失败 ${fails.length}`);
if (fails.length) process.exit(1);
