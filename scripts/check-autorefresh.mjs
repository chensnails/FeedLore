#!/usr/bin/env node
/**
 * 自动刷新 + 「N 条新内容」浮标的端到端验证。
 *
 * 为什么不能只靠 ui-shots：这条链路的时间尺度是**分钟**，而且需要「服务端真的多出一条内容」
 * 才会触发浮标。截图脚本里塞一个 70 秒的等待会把三档实拍拖成十分钟，所以单独一个脚本。
 *
 * 做法：
 * 1. 把 `autoRefreshMinutes` 临时设成 1；
 * 2. 打开页面、滚到列表中间（在顶部时探测会直接套用，根本不显示浮标）；
 * 3. 改一条条目的 publishedAt 让它排到最前 —— 模拟「有新内容」；
 * 4. 等一轮探测（约 65 秒），读浮标；
 * 5. 点浮标，确认列表回到顶部且首条变了；
 * 6. **无论成败都还原**：publishedAt 与 autoRefreshMinutes 都要复原，
 *    否则下一次 ui-shots 的「首条标题」断言会跟着漂。
 *
 * 用法：node scripts/check-autorefresh.mjs http://172.26.1.2:3211 admin <密码>
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const [url = 'http://172.26.1.2:3211', user = 'admin', pass = ''] = process.argv.slice(2);
const HOST = 'root@172.26.1.2';
const KEY = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.ssh/SSHKEY260926-ED25519');
const DB = 'feedlore-v2-v2-db-1';
const DBU = 'feedlore_v2';
const PORT = 9337;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 在测试库上跑一句 SQL，回纯文本（-At 无表头无对齐） */
function psql(sql) {
  /* SQL 必须压成一行：JSON.stringify 会把换行变成字面 `\n`，
   * 远端 psql 收到的就是反斜杠 + n，直接语法错误。 */
  const one = String(sql).replace(/\s+/g, ' ').trim();
  const out = execFileSync(
    'ssh',
    ['-i', KEY, '-o', 'StrictHostKeyChecking=accept-new', HOST,
      `docker exec ${DB} psql -U ${DBU} -d ${DBU} -At -F '|' -c ${JSON.stringify(one)}`],
    { encoding: 'utf8' },
  );
  return out.trim();
}

const profile = mkdtempSync(join(tmpdir(), 'edge-ar-'));
const edge = spawn(
  EDGE,
  ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--window-size=1440,900', 'about:blank'],
  { stdio: 'ignore' },
);

let ws;
let seq = 0;
const pending = new Map();

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
    }, 30000);
  });
}

const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    // 页面上抛的异常不会让 CDP 调用失败，只会静默变成 undefined —— 必须自己说出来
    const d = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? '未知异常';
    console.error(`[eval] ${String(d).slice(0, 140).replace(/\s+/g, ' ')}`);
    return undefined;
  }
  return r.result?.value;
};

/** 还原用的现场：一条条目的原发布时间 + 原来的自动刷新间隔 */
let restore = null;

async function cleanup() {
  try {
    if (restore?.insertedId) {
      psql(`delete from entries where id = ${restore.insertedId}`);
      console.log(`· 已删除临时条目 ${restore.insertedId}`);
    }
    if (restore?.minutes !== undefined) {
      await evalJs(`fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: { autoRefreshMinutes: ${restore.minutes} } }) }).then((r) => r.status)`);
      console.log(`· 已还原 autoRefreshMinutes = ${restore.minutes}`);
    }
  } catch (e) {
    console.error('还原失败（请手动检查）：', e.message);
  }
}

try {
  // 等 CDP 起来
  let targets = null;
  for (let i = 0; i < 40; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      targets = await r.json();
      if (targets?.length) break;
    } catch {
      /* 还没起来 */
    }
    await sleep(300);
  }
  const target = targets?.find((t) => t.type === 'page');
  if (!target) throw new Error('找不到调试目标');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('WebSocket 连接失败'));
  });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  /* 1. 记录现场（只需要记住原来的自动刷新间隔；临时条目在 cleanup 里删掉） */
  const refId = psql(`select id from entries order by published_at desc limit 1`);
  if (!refId) throw new Error('库里没有可参照的条目');
  const cfg = psql(`select value->'source'->>'autoRefreshMinutes' from settings where key = 'source'`);
  restore = { refId: Number(refId), minutes: Number(cfg || 0) };
  console.log(`· 现场：参照条目 ${restore.refId}、autoRefreshMinutes=${restore.minutes}`);

  // 2. 登录
  await send('Page.navigate', { url });
  await sleep(2500);
  await evalJs(`(async () => {
    if (document.querySelector('.app-shell, .layout')) return 'already';
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: ${JSON.stringify(user)}, password: ${JSON.stringify(pass)} }) });
    return r.status;
  })()`);
  await send('Page.navigate', { url });
  await sleep(3000);

  /* 3. 把自动刷新设成 1 分钟（必须早于页面加载，否则要等第一个 interval） */
  const setRes = await evalJs(`fetch('/api/config', { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: { autoRefreshMinutes: 1 } }) }).then((r) => r.status)`);
  console.log(`· 设置 autoRefreshMinutes=1 → HTTP ${setRes}`);

  await send('Page.navigate', { url });
  await sleep(3500);

  const head0 = await evalJs(`(() => {
    const list = document.querySelector('.list');
    if (list) list.scrollTop = 900;
    return {
      first: (document.querySelector('.card-title')?.textContent ?? '').trim(),
      cards: document.querySelectorAll('.card').length,
      scrollTop: list ? list.scrollTop : -1,
      pill: !!document.querySelector('.fresh-pill'),
    };
  })()`);
  console.log(`· 页面就绪：首条「${head0.first}」，已滚动到 ${head0.scrollTop}px，浮标=${head0.pill}`);

  /* 4. 真的插入一条新条目。
   *
   * ⚠️ 第一版是「把一条老条目的 publishedAt 改成未来」——那是错的：它的 id 本来就在
   * 用户看到的 30 条里，探测逻辑（从新数据头部数「连续不在旧头部里」的条数）会算成 0 条，
   * 于是永远不提示。真实场景里新条目的 id 一定是没见过的。 */
  /* psql 的返回是两行：第一行是 returning 的 id，第二行是命令标签 "INSERT 0 1"。
   * 取第一个数字就够了（命令标签里的 0/1 在它后面）。 */
  const insertOut = psql(`insert into entries (feed_id, guid, title, link, description, published_at)
    select feed_id, 'artest-' || floor(random() * 1000000000)::text,
           '【自动刷新验证】新条目 ' || floor(random() * 1000000)::text,
           link, '用于验证「N 条新内容」浮标',
           now() + interval '1 minute'
    from entries where id = ${restore.refId}
    returning id`);
  const newId = Number(/(\d+)/.exec(insertOut)?.[1] ?? 0);
  if (!newId) throw new Error(`插入临时条目失败：${insertOut.slice(0, 120)}`);
  restore.insertedId = Number(newId);
  console.log(`· 已插入临时条目 ${newId}（排在列表最前）`);
  const t0 = Date.now();

  /* 5. 等探测。interval 是 1 分钟，从页面加载算起，多留 20 秒余量 */
  let pill = null;
  for (let i = 0; i < 26; i += 1) {
    await sleep(3000);
    pill = await evalJs(`(() => {
      const p = document.querySelector('.fresh-pill');
      return p ? { text: p.textContent.trim(), scrollTop: document.querySelector('.list')?.scrollTop ?? -1 } : null;
    })()`);
    if (pill) break;
  }
  const waited = Math.round((Date.now() - t0) / 1000);

  if (!pill) {
    console.error(`✗ 等了 ${waited}s 没出现浮标 —— 自动刷新没生效，或探测没识别出新内容`);
    process.exitCode = 1;
  } else {
    console.log(`✓ ${waited}s 后出现浮标：「${pill.text}」，此时列表仍停在 ${pill.scrollTop}px（没有被强行掀动）`);
    /* 6. 点浮标：列表应回到顶部，且首条变化 */
    const after = await evalJs(`(async () => {
      document.querySelector('.fresh-go')?.click();
      await new Promise((r) => setTimeout(r, 2000));
      return {
        first: (document.querySelector('.card-title')?.textContent ?? '').trim(),
        scrollTop: document.querySelector('.list')?.scrollTop ?? -1,
        pillGone: !document.querySelector('.fresh-pill'),
      };
    })()`);
    const changed = after.first !== head0.first;
    const atTop = after.scrollTop < 60;
    console.log(`${changed ? '✓' : '✗'} 点浮标后首条变化：「${after.first}」`);
    console.log(`${atTop ? '✓' : '✗'} 点浮标后回到顶部（scrollTop=${after.scrollTop}）`);
    console.log(`${after.pillGone ? '✓' : '✗'} 浮标已消失`);
    if (!changed || !atTop || !after.pillGone) process.exitCode = 1;
  }
} catch (e) {
  console.error('脚本异常：', e.message);
  process.exitCode = 1;
} finally {
  await cleanup();
  try {
    ws?.close();
  } catch {
    /* noop */
  }
  edge.kill();
}
