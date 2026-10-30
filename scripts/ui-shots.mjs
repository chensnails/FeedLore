/**
 * 响应式实拍：桌面 / 平板 / 手机三档各截一张，并回读布局事实。
 *
 * 为什么要有这个脚本：`ui-check.mjs` 只在一个固定窗口下跑功能，**改断点、改侧栏、
 * 改卡片密度都不会被它发现**。而 v2 是 React 重写，响应式是最容易「看着没坏、实际塌了」
 * 的一块 —— 所以这里不只看截图，还把「侧栏是否可见 / 卡片是几列 / 阅读层是单栏还是双栏」
 * 读成数字打出来，避免靠肉眼判断。
 *
 * 用法：node scripts/ui-shots.mjs http://172.26.1.2:3211 admin <密码> [前缀]
 * ⚠️ 跑前先 taskkill //F //IM msedge.exe（Edge 单实例，已有进程会吞掉新 URL）。
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const [url = 'http://172.26.1.2:3211', user = 'admin', pass = '', prefix = 'rwd'] = process.argv.slice(2);
const PORT = 9334;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 三档视口：桌面 / 平板竖屏 / 手机。宽度选在断点两侧，才能看出降级有没有发生。 */
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, dpr: 1 },
  { name: 'tablet', width: 820, height: 1024, dpr: 2 },
  { name: 'phone', width: 390, height: 844, dpr: 3 },
];

const profile = mkdtempSync(join(tmpdir(), 'edge-shots-'));
const edge = spawn(
  EDGE,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1440,900',
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

async function evalJs(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
}

async function shot(name) {
  const msg = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const data = msg.result?.data;
  if (!data) throw new Error('截图数据为空');
  const p = join(process.cwd(), name);
  writeFileSync(p, Buffer.from(data, 'base64'));
  return p;
}

/** 回读布局事实。用 getComputedStyle 而不是 offsetWidth：前者对 display:none/transform 也成立。 */
const LAYOUT_PROBE = `(() => {
  const q = (s) => document.querySelector(s);
  const cs = (s, p) => { const el = q(s); return el ? getComputedStyle(el)[p] : null; };
  const sidebar = q('.sidebar');
  const cards = q('.cards') || q('.grid');
  const cols = cards ? getComputedStyle(cards).gridTemplateColumns.split(' ').filter(Boolean).length : 0;
  const imgs = [...document.querySelectorAll('.card-thumb img, .card img')];
  return {
    vw: window.innerWidth,
    sidebarVisible: !!sidebar && getComputedStyle(sidebar).display !== 'none' && sidebar.getBoundingClientRect().width > 0,
    sidebarWidth: sidebar ? Math.round(sidebar.getBoundingClientRect().width) : 0,
    layoutDisplay: cs('.layout', 'display'),
    cardsDisplay: cards ? getComputedStyle(cards).display : 'none',
    cardCols: cols,
    cardCount: document.querySelectorAll('.card').length,
    images: { total: imgs.length, loaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length },
    navToggle: !!document.querySelector('[aria-label*="频道"],[aria-label*="菜单"],[aria-label*="导航"]'),
    // 开关「可见」指真的能点到：display:none 的按钮 offsetParent 为 null
    navToggleVisible: !!document.querySelector('.nav-toggle')?.offsetParent,
    searchBox: !!q('.search-input'),
    settingsBtn: !!q('[aria-label="打开设置"]'),
    bodyOverflowX: document.documentElement.scrollWidth > window.innerWidth,
    topbarHeight: q('.topbar') ? Math.round(q('.topbar').getBoundingClientRect().height) : 0,
    /* 顶栏折行判据：直接子元素的 offsetTop 是否分成了两层。
     * 不能用「高度 > N」—— 按钮本身有内边距，单行也有 60px 上下，会误报。 */
    topbarWrapped: (() => {
      /* 判据是「各元素的垂直中心是否在同一条线上」。
       * 不能用 offsetTop：顶栏是 align-items:center，同一排里高矮不同的元素
       * offsetTop 本来就差几像素，会把单行误判成折行（第一版就这么误报的）。 */
      const centers = [...(q('.topbar')?.children ?? [])]
        .filter((c) => c.offsetParent !== null)
        .map((c) => {
          const r = c.getBoundingClientRect();
          return Math.round(r.top + r.height / 2);
        });
      return centers.length > 0 && Math.max(...centers) - Math.min(...centers) > 8;
    })(),
  };
})()`;

try {
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

  /* 先在桌面档登录：登录表单只在未登录时出现，登录态由 Cookie 保持，
   * 后面切视口只需要 reload，不用重复登录（也就不会触发登录限流）。 */
  await send('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORTS[0].width,
    height: VIEWPORTS[0].height,
    deviceScaleFactor: VIEWPORTS[0].dpr,
    mobile: false,
  });
  await send('Page.navigate', { url });
  await sleep(2500);

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
    document.querySelector('.btn.primary')?.click();
    return 'ok';
  })()`);
  if (filled !== 'ok') throw new Error(`登录表单异常：${filled}`);
  await sleep(3000);

  const rows = [];
  for (const vp of VIEWPORTS) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: vp.width,
      height: vp.height,
      deviceScaleFactor: vp.dpr,
      mobile: vp.width < 700,
    });
    // 视口变了要重排：重载一次比等 ResizeObserver 稳，且顺带验证「窄屏首屏不炸」
    await send('Page.navigate', { url });
    await sleep(2600);
    const info = await evalJs(LAYOUT_PROBE);
    const listShot = await shot(`${prefix}-${vp.name}-list.png`);

    /* 抽屉：只有开关可见时才测（桌面侧栏常驻，点不到 ☰）。
     * 判据是**抽屉左边进入视口** —— 只查 class 会放过「transform 没生效」这种塌法。 */
    if (info.navToggleVisible) {
      await evalJs("document.querySelector('.nav-toggle')?.click()");
      await sleep(400);
      const drawer = await evalJs(`(() => {
        const s = document.querySelector('.sidebar');
        const r = s.getBoundingClientRect();
        return {
          open: s.classList.contains('open'),
          left: Math.round(r.left),
          width: Math.round(r.width),
          onScreen: r.left >= -2 && r.width > 100,
          scrim: !!document.querySelector('.nav-scrim'),
        };
      })()`);
      // 先拍再关：现在拍的是「关掉之后」的列表，跟 list 截图长得一模一样
      const drawerShot = await shot(`${prefix}-${vp.name}-drawer.png`);
      await evalJs("document.querySelector('.nav-scrim')?.click()");
      await sleep(350);
      drawer.closedAfterScrim = await evalJs("!document.querySelector('.sidebar')?.classList.contains('open')");
      rows.push({ viewport: vp.name, drawer: true, ...drawer, shot: drawerShot });
    }

    // 设置面板：页签 / 分段控件 / 色板数量，确认七项外观偏好都有入口
    const prefs = await evalJs(`(async () => {
      document.querySelector('[aria-label="打开设置"]')?.click();
      await new Promise((r) => setTimeout(r, 400));
      const sheet = document.querySelector('.prefs-sheet');
      return {
        open: !!sheet,
        tabs: document.querySelectorAll('.prefs-sheet .admin-tabs .chip').length,
        segRows: document.querySelectorAll('.prefs-sheet .seg-row').length,
        accents: document.querySelectorAll('.prefs-sheet .accent-dot').length,
        widthPct: sheet ? Math.round((sheet.getBoundingClientRect().width / window.innerWidth) * 100) : 0,
      };
    })()`);
    if (prefs && prefs.open) {
      const prefsShot = await shot(`${prefix}-${vp.name}-prefs.png`);

      /* 点一个色板，确认 --accent 真的变了再点回去。
       * 只数控件个数是不够的：控件在、点了不生效（没接上 applyAppearance）
       * 视觉上一模一样，只有读 CSS 变量才看得出来。 */
      const applied = await evalJs(`(async () => {
        const root = document.documentElement;
        const read = () => getComputedStyle(root).getPropertyValue('--accent').trim();
        const dots = [...document.querySelectorAll('.prefs-sheet .accent-dot')];
        const cur = dots.findIndex((d) => d.classList.contains('on'));
        if (cur < 0 || dots.length < 2) return { skipped: true };
        const before = read();
        dots[(cur + 1) % dots.length].click();
        await new Promise((r) => setTimeout(r, 900));
        const after = read();
        dots[cur].click();               // 还原，别给下一个视口留下改过的偏好
        await new Promise((r) => setTimeout(r, 700));
        return { accentBefore: before, accentAfter: after, changed: before !== after, restored: read() === before };
      })()`);

      // 阅读页签：点「大」正文字号，读 --reader-fs 是否跟着变
      const reading = await evalJs(`(async () => {
        const tabs = [...document.querySelectorAll('.prefs-sheet .admin-tabs .chip')];
        tabs.find((t) => t.textContent === '阅读')?.click();
        await new Promise((r) => setTimeout(r, 300));
        const root = document.documentElement;
        const read = () => getComputedStyle(root).getPropertyValue('--reader-fs').trim();
        const before = read();
        const big = [...document.querySelectorAll('.prefs-sheet .seg-btn')].find((b) => b.textContent === '大');
        big?.click();
        await new Promise((r) => setTimeout(r, 900));
        const after = read();
        const segRows = document.querySelectorAll('.prefs-sheet .seg-row').length;
        return { segRows, fsBefore: before, fsAfter: after, changed: before !== after };
      })()`);
      const readingShot = await shot(`${prefix}-${vp.name}-prefs-reading.png`);

      // 关注规则页签：只截图，不点保存（避免污染测试库的规则）
      const watch = await evalJs(`(async () => {
        const tabs = [...document.querySelectorAll('.prefs-sheet .admin-tabs .chip')];
        tabs.find((t) => t.textContent === '关注规则')?.click();
        await new Promise((r) => setTimeout(r, 400));
        return {
          rules: document.querySelectorAll('.prefs-sheet .rule-row').length,
          actions: document.querySelectorAll('.prefs-sheet .admin-actions .btn').length,
          saveDisabled: [...document.querySelectorAll('.prefs-sheet .admin-actions .btn')]
            .some((b) => b.textContent.includes('已保存')),
          recomputeDisabled: [...document.querySelectorAll('.prefs-sheet .admin-actions .btn')]
            .some((b) => b.disabled && b.textContent.includes('重算')),
        };
      })()`);
      const watchShot = await shot(`${prefix}-${vp.name}-prefs-watch.png`);

      rows.push({ viewport: vp.name, prefs: true, ...prefs, applied, reading, watch, shot: prefsShot });
      // 阅读页签把正文字号改成了「大」，恢复默认「中」
      await evalJs(`(async () => {
        const tabs = [...document.querySelectorAll('.prefs-sheet .admin-tabs .chip')];
        tabs.find((t) => t.textContent === '阅读')?.click();
        await new Promise((r) => setTimeout(r, 250));
        /* 按「标签名 + 第几档」定位，不能用 index：
         * 阅读页里「正文行高」也有一个「中」，按序号取会点错行（第一版就这么错的）。 */
        const fsRow = [...document.querySelectorAll('.prefs-sheet .seg-row')]
          .find((r) => (r.querySelector('.seg-label')?.textContent ?? '').startsWith('正文字号'));
        fsRow?.querySelectorAll('.seg-btn')[1]?.click();
        await new Promise((r) => setTimeout(r, 500));
      })()`);
      await evalJs("document.querySelector('.prefs-sheet .reader-close')?.click()");
      await sleep(300);
      void readingShot;
      void watchShot;
    }

    // 搜索：先输一个必然搜不到的词 —— 命中 0 条才算真的走了服务端 q 参数
    let search = null;
    if (info.searchBox) {
      search = await evalJs(`(async () => {
        const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        const type = async (word) => {
          // 每次重查：列表若被卸载重挂，旧引用会写到游离节点上，测出假结果
          const inp = document.querySelector('.search-input');
          d.set.call(inp, word);
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 1300));
          return {
            cards: document.querySelectorAll('.card').length,
            head: (document.querySelector('.list-head span')?.textContent ?? '').slice(0, 18),
          };
        };
        const before = document.querySelectorAll('.card').length;
        /* 只测常见词（比如「的」）是测不出真假的：全库几乎每条都含它，条数不变，
         * 前端过滤和服务端搜索的结果看起来一模一样。 */
        const rare = await type('zzz-not-a-real-word-zzz');
        const common = await type('\\u7684');
        return { before, rare, common, clearBtn: !!document.querySelector('.search-clear') };
      })()`);
      await evalJs("document.querySelector('.search-clear')?.click()");
      await sleep(600);
    }

    /* 工具栏特性（只在桌面档跑，三档重复测同样的东西是浪费时间）：
     * 视图切换 / 排序 / 筛选档 / 标签筛选 / 命令面板 / PWA。
     * 每一项都读**结果**而不是「按钮存在」—— 「控件在、点了不生效」是这一轮
     * 最容易犯也最难发现的错（外观设置当初就是这么漏过去的）。 */
    if (vp.name === 'desktop') {
      const feat = await evalJs(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const cards = () => document.querySelectorAll('.card');
        const firstTitle = () => (document.querySelector('.card-title')?.textContent ?? '').trim();
        const out = {};

        // ---- 视图切换 ----
        const viewBtns = [...document.querySelectorAll('.seg[aria-label="视图"] .seg-btn')];
        out.viewBtns = viewBtns.length;
        const colsOf = () => {
          const c = document.querySelector('.cards');
          if (!c) return 0;
          const g = getComputedStyle(c);
          return g.display === 'grid' ? g.gridTemplateColumns.split(' ').filter(Boolean).length : 1;
        };
        out.colsGrid = colsOf();
        viewBtns[1]?.click();
        await wait(700);
        out.afterList = {
          cls: document.querySelector('.cards')?.className ?? '',
          display: getComputedStyle(document.querySelector('.cards')).display,
          cols: colsOf(),
        };
        viewBtns[0]?.click();
        await wait(700);
        out.afterGrid = { cls: document.querySelector('.cards')?.className ?? '', cols: colsOf() };

        // ---- 排序：切到「旧→新」后首条标题应变化 ----
        const sel = document.querySelector('.sort-select');
        const newFirst = firstTitle();
        const setSel = (v) => {
          const d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
          d.set.call(sel, v);
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        };
        setSel('old');
        await wait(1600);
        const oldFirst = firstTitle();
        out.sort = { newFirst, oldFirst, changed: newFirst !== oldFirst, value: sel.value };
        setSel('name');
        await wait(1300);
        out.sort.nameValue = sel.value;
        setSel('new');
        await wait(1300);
        out.sort.restored = sel.value === 'new';

        // ---- 筛选档 ----
        const filterBtns = [...document.querySelectorAll('.filter-row .seg-btn')];
        out.filterBtns = filterBtns.length;
        const allCount = cards().length;
        filterBtns.find((b) => b.textContent === '未读')?.click();
        await wait(1600);
        out.filter = {
          unreadCount: cards().length,
          hasReadRow: !!document.querySelector('.card-row.read'),
          allCount,
        };
        filterBtns.find((b) => b.textContent === '全部')?.click();
        await wait(1300);

        // ---- 标签筛选 ----
        const tagBtn = document.querySelector('.tag-btn');
        if (tagBtn) {
          tagBtn.click();
          await wait(1600);
          out.tag = {
            on: !!document.querySelector('.tag-btn.on'),
            count: cards().length,
            clearBtn: !!document.querySelector('.tag-btn.clear'),
            headHasTag: (document.querySelector('.list-title')?.textContent ?? '').includes('#'),
          };
          document.querySelector('.tag-btn.on')?.click();
          await wait(1300);
          out.tag.cleared = !document.querySelector('.tag-btn.on');
        } else {
          out.tag = { skipped: 'no-tag' };
        }

        // ---- 命令面板（自带拼音别名：wg 应命中「视图：网格」）----
        document.querySelector('.cmdk-btn')?.click();
        await wait(500);
        out.cmdkOpen = !!document.querySelector('.cmdk');
        const cin = document.querySelector('.cmdk-input');
        if (cin) {
          const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
          d.set.call(cin, 'wg');
          cin.dispatchEvent(new Event('input', { bubbles: true }));
          await wait(400);
          out.cmdkFirst = (document.querySelector('.cmdk-item .cmdk-label')?.textContent ?? '').trim();
          out.cmdkCount = document.querySelectorAll('.cmdk-item').length;
        }
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        await wait(400);
        out.cmdkClosed = !document.querySelector('.cmdk');

        // ---- PWA ----
        const mf = await fetch('/manifest.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
        const swText = await fetch('/sw.js').then((r) => (r.ok ? r.text() : '')).catch(() => '');
        out.pwa = {
          link: !!document.querySelector('link[rel="manifest"]'),
          name: mf?.name ?? null,
          icons: mf?.icons?.length ?? 0,
          swServed: swText.length > 100,
          // 预缓存清单里不该出现带哈希的构建产物（每次构建文件名都变，写死等于每次 404）
          swPrecacheClean: !/index-[A-Za-z0-9_-]+\\.(js|css)/.test(swText),
        };
        return out;
      })()`);
      rows.push({ viewport: vp.name, toolbar: true, ...feat });
    }

    rows.push({ viewport: vp.name, ...info, search, shot: listShot });

    // 打开第一条进入阅读层，再量一次（单栏 / 双栏 / 抽屉式）
    const opened = await evalJs(`(() => {
      const card = document.querySelector('.card');
      if (!card) return 'no-card';
      (card.querySelector('.card-title') || card).click();
      return 'ok';
    })()`);
    if (opened === 'ok') {
      await sleep(1800);
      const reader = await evalJs(`(() => {
        const sheet = document.querySelector('.reader-sheet');
        const body = document.querySelector('.reader-body');
        return {
          readerOpen: !!sheet && getComputedStyle(sheet).display !== 'none',
          readerWidthPct: sheet ? Math.round((sheet.getBoundingClientRect().width / window.innerWidth) * 100) : 0,
          readerBodyWidth: body ? Math.round(body.getBoundingClientRect().width) : 0,
          paragraphs: document.querySelectorAll('.reader-body p').length,
          imagesInReader: document.querySelectorAll('.reader-body img').length,
          artImgs: document.querySelectorAll('.reader-body .art-img').length,
          imgGroups: document.querySelectorAll('.reader-body .art-imgs').length,
          fontFamily: body ? getComputedStyle(body).fontFamily.split(',')[0] : '',
          fontSize: body ? getComputedStyle(body).fontSize : '',
          lineHeight: body ? getComputedStyle(body).lineHeight : '',
          backdrop: !!document.querySelector('.reader-backdrop'),
          // 翻篇：位置文本形如 "3 / 30"，有它就说明从列表缓存里定位成功了
          navPos: (document.querySelector('.reader-nav-pos')?.textContent ?? '').trim(),
          navBtns: document.querySelectorAll('.reader-nav .btn').length,
          fsBtns: document.querySelectorAll('.reader-fs .btn').length,
        };
      })()`);

      // 灯箱：点正文图 → 覆盖层出现 → 点空白关闭
      const hasArt = await evalJs("document.querySelector('.reader-body .art-img') ? 'yes' : 'no'");
      if (hasArt === 'yes') {
        await evalJs("document.querySelector('.reader-body .art-img').click()");
        await sleep(700);
        const lb = await evalJs(`(() => ({
          lightbox: !!document.querySelector('.lightbox'),
          hint: (document.querySelector('.lightbox-hint')?.textContent ?? '').trim(),
        }))()`);
        const lbShot = await shot(`${prefix}-${vp.name}-lightbox.png`);
        rows.push({ viewport: vp.name, lightbox: true, ...lb, shot: lbShot });
        await evalJs("document.querySelector('.lightbox')?.click()");
        await sleep(300);
      }

      /* A+ / A- 必须真的改掉 --reader-fs。点完不生效（没接上 applyAppearance）
       * 在截图里完全看不出来，只有读 CSS 变量能分辨。 */
      const fsStep = await evalJs(`(async () => {
        const read = () => getComputedStyle(document.documentElement).getPropertyValue('--reader-fs').trim();
        const before = read();
        const plus = [...document.querySelectorAll('.reader-fs .btn')].find((b) => b.textContent === 'A+');
        plus?.click();
        await new Promise((r) => setTimeout(r, 1100));
        const after = read();
        const minus = [...document.querySelectorAll('.reader-fs .btn')].find((b) => b.textContent === 'A-');
        minus?.click();
        await new Promise((r) => setTimeout(r, 1000));
        return { before, after, changed: before !== after, restored: read() === before };
      })()`);
      rows.push({ viewport: vp.name, fontStep: true, ...fsStep });

      // 下一条：标题应变化、位置文本应递增（读的是同一份列表缓存）
      const nextNav = await evalJs(`(async () => {
        const title = () => (document.querySelector('.reader-title')?.textContent ?? '').trim();
        const before = title();
        const posBefore = (document.querySelector('.reader-nav-pos')?.textContent ?? '').trim();
        [...document.querySelectorAll('.reader-nav .btn')]
          .find((b) => b.textContent.includes('下一条'))?.click();
        await new Promise((r) => setTimeout(r, 1800));
        return {
          before,
          after: title(),
          changed: before !== title() && !!title(),
          posBefore,
          posAfter: (document.querySelector('.reader-nav-pos')?.textContent ?? '').trim(),
        };
      })()`);
      rows.push({ viewport: vp.name, nextNav: true, ...nextNav });

      const readerShot = await shot(`${prefix}-${vp.name}-reader.png`);
      rows.push({ viewport: vp.name, reader: true, ...reader, shot: readerShot });
      // 关闭阅读层，回到列表再切下一档
      await evalJs("document.querySelector('.reader-close')?.click()");
      await sleep(600);
    }
  }

  console.log(`\n[shots] ${url}\n`);
  for (const r of rows) {
    const q = Object.entries(r)
      .filter(([k]) => k !== 'shot' && k !== 'viewport' && k !== 'reader')
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join(' ');
    console.log(`${r.viewport}${r.reader ? '(阅读层)' : ''}\t${q}`);
  }
  console.log(`\n控制台错误 ${errors.length} 条${errors.length ? '：' + errors.slice(0, 3).join(' | ') : ''}`);
  process.exitCode = errors.length ? 1 : 0;
} finally {
  try {
    ws?.close();
  } catch {
    /* noop */
  }
  edge.kill();
}
