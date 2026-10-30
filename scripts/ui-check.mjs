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

/** 图片解码统计：naturalWidth > 0 才算「真的显示出来」。
 *  只数 <img> 节点会把「代理 403 / 白图 / 防盗链」全部放过 —— 这几类恰恰是最常见的失败。
 */
async function imgStats(selector) {
  const r = await evalJs(`(() => {
    const imgs = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const loaded = imgs.filter((i) => i.complete && i.naturalWidth > 0);
    const first = loaded[0];
    return {
      total: imgs.length,
      loaded: loaded.length,
      sample: first ? (first.currentSrc.split("u=")[1] || first.currentSrc).slice(0, 48) + " " + first.naturalWidth + "x" + first.naturalHeight : "",
    };
  })()`);
  return r ?? { total: 0, loaded: 0, sample: "" };
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
    /* 原生 confirm/alert 会**同步阻塞渲染进程**，CDP 的 Runtime.evaluate 会一直不返回，
     * 脚本表现成「跑到一半卡死」。这里直接拒掉并记一条错误：
     * 「还用着原生对话框」本身就是本次要守的回归点。 */
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

  // 图片：必须真的解码出来（见 imgStats 注释）。懒加载 + 代理回源需要时间，等一会儿再数。
  await sleep(2000);
  const thumbStats = await imgStats('.card-thumb');
  const iconStats = await imgStats('.feed-icon');
  console.log(`  卡片封面：${thumbStats.loaded}/${thumbStats.total} 已解码 ${thumbStats.sample}`);
  console.log(`  频道图标：${iconStats.loaded}/${iconStats.total} 已解码 ${iconStats.sample}`);
  console.log(`  频道行数：${feedCount}（含「全部频道」）  条目卡片：${cardCount}`);

  // 点开第一条，验证阅读层能拿到详情（列表不带正文，详情才带）
  if (cardCount > 0) {
    await evalJs("document.querySelector('.card').click()");
    await sleep(1500);
    const readerText = (await evalJs("document.querySelector('.reader-body')?.innerText ?? ''")) ?? '';
    const hasSheet = await evalJs("!!document.querySelector('.reader-sheet')");
  const shotStats = await imgStats('.reader-shot');
  console.log(`  正文配图：${shotStats.loaded}/${shotStats.total} 已解码 ${shotStats.sample}`);
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
    const b = [...document.querySelectorAll('.filter-row .btn')].find((x) => x.innerText.includes('全部已读'));
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
  await evalJs("document.querySelector('[aria-label=\"切换主题\"]')?.click()");
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


  // 【管理面板】只有管理员看得到 ⚙；三个页签必须有真实内容（空壳也算失败）
  const gearLabel = await evalJs("document.querySelector('[aria-label=\"打开管理面板\"]') ? 'found' : 'missing'");
  await evalJs("document.querySelector('[aria-label=\"打开管理面板\"]')?.click()");
  await sleep(1800);
  const adminOpen = await evalJs("!!document.querySelector('.admin-sheet')");
  const adminTabs = await evalJs("document.querySelectorAll('.admin-tabs .chip').length");
  const statusText = (await evalJs("document.querySelector('.admin-body')?.innerText ?? ''")) ?? '';
  const statusOk = statusText.includes('数据库') && statusText.includes('采集');
  console.log(`  管理面板：入口=${gearLabel} 打开=${adminOpen} 页签=${adminTabs} 状态页内容=${statusOk ? '有' : '空'}`);
  await shot('ui-admin-status.png');

  const clickTab = (label) =>
    evalJs(`(() => {
      const b = [...document.querySelectorAll('.admin-tabs .chip')].find((x) => x.innerText.includes(${JSON.stringify(label)}));
      if (!b) return 'no-tab';
      b.click();
      return 'ok';
    })()`);

  const cfgTab = await clickTab('采集参数');
  await sleep(1200);
  const cfgInputs = await evalJs("document.querySelectorAll('.admin-field input').length");
  console.log(`  参数页：${cfgTab}，输入框 ${cfgInputs} 个`);

  const userTab = await clickTab('用户');
  await sleep(1200);
  const userRows = await evalJs("document.querySelectorAll('.admin-table tbody tr').length");
  const selfMark = await evalJs("document.body.innerText.includes('当前登录')");
  console.log(`  用户页：${userTab}，${userRows} 行，自己标记=${selfMark}`);
  await shot('ui-admin-users.png');

  /* 关于页：版本号必须是 vX.Y.Z 形态。
   * 这条同时守着「版本只有一个真源」—— 版本号从根 package.json 读，
   * 以后谁再把阶段号硬编码回 env.ts，这里显示的东西就会和 tag 对不上。 */
  const aboutTab = await clickTab('关于');
  await sleep(900);
  const aboutVersion = ((await evalJs("document.querySelector('.admin-grid dd')?.textContent ?? ''")) ?? '').trim();
  const aboutBtns = await evalJs("document.querySelectorAll('.admin-actions .btn').length");
  const aboutOk = /^v\d+\.\d+\.\d+/.test(aboutVersion) && (aboutBtns ?? 0) >= 1;
  console.log(`  关于页：${aboutTab} 版本=${aboutVersion} 按钮=${aboutBtns} ${aboutOk ? '' : '⚠️ 版本号形态不对'}`);
  await shot('ui-admin-about.png');

  await evalJs("document.querySelector('.admin-sheet .reader-close')?.click()");
  await sleep(500);
  const adminClosed = await evalJs("!document.querySelector('.admin-sheet')");
  if (!(adminOpen && adminTabs === 4 && statusOk && cfgInputs >= 11 && userRows >= 1 && aboutOk && adminClosed)) {
    console.log('  ⚠️ 管理面板检查未全部通过');
    process.exitCode = 1;
  }

  // 【日报】▤ 入口 → 面板打开 → 两个页签都有真实内容（空白也当失败）
  const digestLabel = await evalJs("document.querySelector('[aria-label=\"打开日报\"]') ? 'found' : 'missing'");
  await evalJs("document.querySelector('[aria-label=\"打开日报\"]')?.click()");
  await sleep(2200);
  const digestOpen = await evalJs("!!document.querySelector('.digest-sheet')");
  const digestTabs = await evalJs("document.querySelectorAll('.digest-sheet .admin-tabs .chip').length");
  const digestText = (await evalJs("document.querySelector('.digest-sheet .admin-body')?.innerText ?? ''")) ?? '';
  // 要么有真实日报（概览段），要么是「还没有日报」的提示；一片空白说明渲染挂了
  const digestHasBody = digestText.length > 20;
  console.log(
    `  日报：入口=${digestLabel} 打开=${digestOpen} 页签=${digestTabs} 正文=${
      digestHasBody ? digestText.slice(0, 28).replace(/\s+/g, ' ') : '空'
    }`,
  );
  await shot('ui-digest.png');

  const dTab = await evalJs(`(() => {
    const b = [...document.querySelectorAll('.digest-sheet .admin-tabs .chip')].find((x) => x.innerText.includes('设置'));
    if (!b) return 'no-tab';
    b.click();
    return 'ok';
  })()`);
  await sleep(1600);
  const dInputs = await evalJs(
    "document.querySelectorAll('.digest-sheet .admin-field input, .digest-sheet .admin-field select, .digest-sheet .admin-field textarea').length",
  );
  // 「测试连接」在但 apiKey 输入框为空 —— 这两个是本轮最容易被漏掉的界面元素
  const hasTestBtn = await evalJs(
    "[...document.querySelectorAll('.digest-sheet button')].some((b) => b.innerText.includes('测试连接'))",
  );
  const apiKeyEmpty = await evalJs("document.querySelector('.digest-sheet input[type=password]')?.value === ''");
  console.log(`  日报设置：${dTab}，控件 ${dInputs} 个，测试连接=${hasTestBtn}，Key 框为空=${apiKeyEmpty}`);
  await shot('ui-digest-settings.png');

  await evalJs("document.querySelector('.digest-sheet .reader-close')?.click()");
  await sleep(400);
  const digestClosed = await evalJs("!document.querySelector('.digest-sheet')");
  if (!(digestOpen && digestTabs === 2 && digestHasBody && dInputs >= 8 && hasTestBtn && apiKeyEmpty && digestClosed)) {
    console.log('  ⚠️ 日报面板检查未全部通过');
    process.exitCode = 1;
  }
  /* ============ 六项交互回归：无限滚动 / 深链 / 后退 / 确认框 / 分组 / 侧栏宽度 ============ */

  // 【1】无限滚动。滚到底后条目数必须变多 —— 不变化说明 sentinel 没触发，
  // 或者 IntersectionObserver 的 root 没指向 .list（那是最常见的写错法，桌面看不出来）。
  const rowsBefore = (await evalJs("document.querySelectorAll('.cards .card-row').length")) ?? 0;
  await evalJs("(() => { const l = document.querySelector('.list'); if (l) l.scrollTop = l.scrollHeight; return 1; })()");
  await sleep(2800);
  const rowsAfter = (await evalJs("document.querySelectorAll('.cards .card-row').length")) ?? 0;
  const tailText = ((await evalJs("document.querySelector('.list-sentinel, .list-end')?.innerText ?? ''")) ?? '').trim();
  const scrollOk = rowsAfter > rowsBefore;
  console.log(`  无限滚动：${rowsBefore} → ${rowsAfter} 条（尾部="${tailText}"）`);

  // 【2】深链。带 ?r= 强制文档级导航，否则同文档 hash 跳转测不出「冷启动直达」。
  await evalJs("(() => { const l = document.querySelector('.list'); if (l) l.scrollTop = 0; return 1; })()");
  await sleep(400);
  await evalJs("document.querySelector('.cards .card-row .card')?.click()");
  await sleep(1500);
  const deepHash = (await evalJs("location.hash")) ?? '';
  const deepTitle = (await evalJs("document.querySelector('.reader-title')?.textContent ?? ''")) ?? '';
  const bare = url.replace(/\/$/, '');
  await send('Page.navigate', { url: `${bare}/?r=${Date.now()}${deepHash}` });
  await sleep(3600);
  const deepTitle2 = (await evalJs("document.querySelector('.reader-title')?.textContent ?? ''")) ?? '';
  const deepOk = /^#\/a\/\d+$/.test(deepHash) && deepTitle.length > 0 && deepTitle2 === deepTitle;
  console.log(
    `  深链：hash=${deepHash} 打开=${JSON.stringify(deepTitle.slice(0, 16))} 直达=${JSON.stringify(deepTitle2.slice(0, 16))}`,
  );
  await shot('ui-deeplink.png');

  // 【3】后退。深链是历史里的新一条，后退应回到列表（阅读层必须消失）。
  await evalJs("history.back()");
  await sleep(1800);
  const backClosed = await evalJs("!document.querySelector('.reader-sheet')");
  const backHash = (await evalJs("location.hash")) ?? '';
  const backOk = backClosed === true;
  console.log(`  后退：阅读层关闭=${backClosed} hash=${backHash || '(空)'}`);

  // 【4】确认框。删频道的确认必须是应用内对话框；取消后频道数不变（不能误删）。
  const feedsBefore = (await evalJs("document.querySelectorAll('.feed-row').length")) ?? 0;
  await evalJs("document.querySelector('.feed-row .icon-btn.danger')?.click()");
  await sleep(600);
  const confirmShown = await evalJs("!!document.querySelector('.confirm-box')");
  const confirmTitle = ((await evalJs("document.querySelector('.confirm-title')?.textContent ?? ''")) ?? '').slice(0, 22);
  const cancelFocused = await evalJs("document.activeElement?.innerText?.trim() === '取消'");
  await evalJs("[...document.querySelectorAll('.confirm-actions .btn')].find((b) => b.innerText.trim() === '取消')?.click()");
  await sleep(500);
  const confirmGone = await evalJs("!document.querySelector('.confirm-box')");
  const feedsAfter = (await evalJs("document.querySelectorAll('.feed-row').length")) ?? 0;
  const confirmOk = confirmShown === true && confirmGone === true && feedsAfter === feedsBefore;
  console.log(
    `  确认框：弹出=${confirmShown} 标题=${JSON.stringify(confirmTitle)} 默认焦点取消=${cancelFocused} 取消后关闭=${confirmGone} 频道 ${feedsBefore}→${feedsAfter}`,
  );
  await shot('ui-confirm.png');

  // 【5】只看这一组：◎ 按下 → 标题变「组：x」+ hash 走 #/g/ → 一键退出
  const grpName = ((await evalJs("document.querySelector('.feed-group-row .feed-group-name')?.textContent ?? ''")) ?? '').trim();
  let groupOk = null;
  if (grpName) {
    await evalJs("document.querySelector('.feed-group-row .icon-btn')?.click()");
    await sleep(1800);
    const scopeTitle = ((await evalJs("document.querySelector('.list-title')?.textContent ?? ''")) ?? '').trim();
    const pressed = await evalJs("document.querySelector('.feed-group-row .icon-btn')?.getAttribute('aria-pressed')");
    const groupHash = (await evalJs("location.hash")) ?? '';
    const groupRows = (await evalJs("document.querySelectorAll('.cards .card-row').length")) ?? 0;
    await evalJs("document.querySelector('.scope-x')?.click()");
    await sleep(1600);
    const scopeAfter = ((await evalJs("document.querySelector('.list-title')?.textContent ?? ''")) ?? '').trim();
    groupOk =
      scopeTitle.includes(`组：${grpName}`) &&
      pressed === 'true' &&
      groupHash.startsWith('#/g/') &&
      !scopeAfter.startsWith('组：');
    console.log(
      `  分组筛选：组=${JSON.stringify(grpName)} 标题=${JSON.stringify(scopeTitle.slice(0, 20))} hash=${groupHash} 条目=${groupRows} 退出后=${JSON.stringify(scopeAfter.slice(0, 16))}`,
    );
  } else {
    console.log('  分组筛选：库里没有分组，跳过');
  }

  // 【6】侧栏宽度：键盘调宽 → 刷新后仍是这个宽度（证明写进了服务端偏好，不是只改了本地变量）
  const w0 = await evalJs("Math.round(document.querySelector('.sidebar').getBoundingClientRect().width)");
  const wBump = await evalJs(`(() => {
    const h = document.querySelector('.side-resize');
    if (!h) return 'no-handle';
    for (let i = 0; i < 3; i += 1) h.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    return Math.round(document.querySelector('.sidebar').getBoundingClientRect().width);
  })()`);
  await sleep(1600);
  await send('Page.reload');
  await sleep(3600);
  const w1 = await evalJs("Math.round(document.querySelector('.sidebar').getBoundingClientRect().width)");
  const sideOk = typeof wBump === 'number' && typeof w0 === 'number' && wBump > w0 && w1 === wBump;
  console.log(`  侧栏宽度：${w0} → ${wBump}px，刷新后 ${w1}px`);
  // 复位成默认，别把测试库的偏好留在 316
  await evalJs(`(() => {
    const h = document.querySelector('.side-resize');
    if (!h) return 0;
    h.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
    return 1;
  })()`);
  await sleep(1200);

  if (!(scrollOk && deepOk && backOk && confirmOk && sideOk && groupOk !== false)) {
    console.log('  ⚠️ 六项交互回归未全部通过');
    process.exitCode = 1;
  }

  console.log(errors.length ? `  控制台错误：\n  - ${errors.join('\n  - ')}` : '  控制台无错误');
  const imgOk = thumbStats.loaded > 0 || iconStats.loaded > 0;
  if (!imgOk) console.log('  ⚠️ 没有任何图片解码成功（可能库里条目都没图，也可能代理全挂）');
  if (feedCount <= 1 || cardCount === 0) process.exitCode = 1;
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
