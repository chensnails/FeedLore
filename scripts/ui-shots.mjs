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
        tabs.find((t) => t.textContent === '关注')?.click();
        await new Promise((r) => setTimeout(r, 400));
        return {
          rules: document.querySelectorAll('.prefs-sheet .rule-row').length,
          // webhook 地址与「推送」勾选：后端一直在用，界面是这一轮才补的
          hookInput: !!document.querySelector('.prefs-sheet .hook-row .input'),
          hookSave: (document.querySelector('.prefs-sheet .hook-row .btn')?.textContent ?? '').trim(),
          pushChecks: document.querySelectorAll('.prefs-sheet .rule-row .rule-on').length,
          actions: document.querySelectorAll('.prefs-sheet .admin-actions .btn').length,
          saveDisabled: [...document.querySelectorAll('.prefs-sheet .admin-actions .btn')]
            .some((b) => b.textContent.includes('已保存')),
          recomputeDisabled: [...document.querySelectorAll('.prefs-sheet .admin-actions .btn')]
            .some((b) => b.disabled && b.textContent.includes('重算')),
        };
      })()`);
      const watchShot = await shot(`${prefix}-${vp.name}-prefs-watch.png`);

      /* 过滤页签：条目过滤规则（抓取写库前的那道闸门）。
       * 重点不是「有几个控件」，而是**非法正则会不会被拦住** ——
       * 服务端对编译不过的正则是静默丢弃，界面不拦就成了「保存了但少一条」。 */
      const filters = await evalJs(`(async () => {
        const tabs = [...document.querySelectorAll('.prefs-sheet .admin-tabs .chip')];
        tabs.find((t) => t.textContent === '过滤')?.click();
        await new Promise((r) => setTimeout(r, 400));
        const before = document.querySelectorAll('.prefs-sheet .filter-rule').length;
        const addBtn = [...document.querySelectorAll('.prefs-sheet .admin-actions .btn')]
          .find((b) => b.textContent.includes('添加规则'));
        addBtn?.click();
        await new Promise((r) => setTimeout(r, 350));
        const after = document.querySelectorAll('.prefs-sheet .filter-rule').length;

        const row = document.querySelector('.prefs-sheet .filter-rule');
        // 第 3 个 select 是「匹配方式」，切到正则
        const kindSel = row?.querySelectorAll('select')[2];
        if (kindSel) {
          const d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
          d.set.call(kindSel, 're');
          kindSel.dispatchEvent(new Event('change', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 300));
        }
        const inp = document.querySelector('.prefs-sheet .filter-pattern');
        if (inp) {
          const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
          d.set.call(inp, '([a-z');
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 350));
        }
        const badMarked = !!document.querySelector('.prefs-sheet .filter-rule.bad');
        const saveBtn = [...document.querySelectorAll('.prefs-sheet .admin-actions .btn')]
          .find((b) => b.textContent.includes('保存'));
        const saveBlocked = saveBtn ? saveBtn.disabled === true : null;

        // 删掉这条临时规则（不保存，避免污染测试库）
        document.querySelector('.prefs-sheet .filter-rule [aria-label="删除规则"]')?.click();
        await new Promise((r) => setTimeout(r, 300));
        return {
          before,
          after,
          badRegexMarked: badMarked,
          saveBlocked,
          cleaned: document.querySelectorAll('.prefs-sheet .filter-rule').length,
        };
      })()`);
      const filterShot = await shot(`${prefix}-${vp.name}-prefs-filter.png`);
      void filterShot;

      rows.push({ viewport: vp.name, prefs: true, ...prefs, applied, reading, watch, filters, shot: prefsShot });
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
        /* 先把视图设回网格再量：上一轮跑完会把 layout.view 存成上一次点的那个，
         * 直接量会把「上次留下的状态」当成初始态，数字每跑一次都不一样。 */
        viewBtns[0]?.click();
        await wait(700);
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

        // ---- 标签 UI 版本判据：v1 在 1.6.0/1.7.0 撤掉了顶部标签云和卡面标签，
        // v2 跟随移除 —— 这里反向断言这些类永远不该再出现（复活即失败）。
        // 正文标签（.mini-tag）的点击闭环在阅读层那段测。
        out.removedUi = {
          tagBar: !!document.querySelector('.tag-bar'),
          tagBtn: !!document.querySelector('.tag-btn'),
          cardTags: !!document.querySelector('.card-tags, .tags-inline'),
          readerNav: !!document.querySelector('.reader-nav, .reader-nav-pos'),
        };

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

        // ---- 列表工具块吸顶：滚动后筛选/排序/视图必须还在视口里 ----
        {
          const l = document.querySelector('.list');
          const bar = document.querySelector('.list-bar');
          const pos = bar ? getComputedStyle(bar).position : null;
          if (l && bar) {
            l.scrollTop = 1200;
            await wait(350);
          }
          const r = bar?.getBoundingClientRect();
          out.listSticky = {
            pos,
            inView: !!r && r.top >= -1 && r.bottom > 0 && r.bottom <= window.innerHeight,
            actionsVisible: !!document.querySelector('.sort-select')?.offsetParent,
          };
          l && (l.scrollTop = 0);
          await wait(250);
        }

        // ---- 动效语言：卡片入场错峰 + 骨架屏规则必须在 CSS 里 ----
        {
          const rules = [...document.styleSheets].flatMap((s) => {
            try { return [...s.cssRules]; } catch { return []; }
          });
          // keyframes 规则的名称字段是 name，普通规则才有 selectorText —— 两种都要认
          const has = (t) => rules.some((r) => (r.selectorText ?? '').includes(t) || (r.name ?? '') === t);
          const cardAnim = getComputedStyle(document.querySelector('.cards > li') ?? document.body).animationName;
          out.motion = {
            cardInApplied: cardAnim === 'card-in',
            cardInKeyframes: has('card-in'),
            skeletonCss: has('.sk-line') && has('.load-dots'),
            stateLayers: has('--state-hover') || rules.some((r) => (r.cssText ?? '').includes('var(--state-hover)')),
          };
        }

        // ---- ⋯ 溢出菜单的键盘契约（桌面档：菜单本身是窄屏控件，这里只查 DOM/ARIA）----
        {
          const more = document.querySelector('.topbar-more');
          out.menuDom = {
            trigger: !!more?.querySelector('button[aria-haspopup="menu"]'),
            expandedAttr: more?.querySelector('button')?.getAttribute('aria-expanded') ?? null,
            hiddenOnWide: more ? !more.offsetParent : true,
          };
        }
        return out;
      })()`);
      rows.push({ viewport: vp.name, toolbar: true, ...feat });

      /* 管理面板「关于」：版本号现在只有一个真源（根 package.json），
       * 这里顺便验证「界面显示的数」和「服务端读到的数」是一回事。 */
      const about = await evalJs(`(async () => {
        document.querySelector('.topbar-admin')?.click();
        await new Promise((r) => setTimeout(r, 700));
        const sheet = document.querySelector('.admin-sheet');
        if (!sheet) return { opened: false };
        const tabs = [...sheet.querySelectorAll('.admin-tabs .chip')];
        tabs.find((t) => t.textContent === '关于')?.click();
        await new Promise((r) => setTimeout(r, 1100));
        const dds = [...sheet.querySelectorAll('.admin-grid dd')].map((x) => x.textContent.trim());
        const btns = [...sheet.querySelectorAll('.admin-actions .btn')].map((b) => b.textContent.trim());
        return {
          opened: true,
          tabs: tabs.length,
          version: dds[0] ?? null,
          repo: dds[1] ?? null,
          channel: dds[2] ?? null,
          buttons: btns.join('/'),
        };
      })()`);
      const aboutShot = await shot(`${prefix}-${vp.name}-admin-about.png`);
      void aboutShot;
      // 关掉管理面板，后面的断言还要用列表
      await evalJs("document.querySelector('.admin-sheet .reader-close')?.click()");
      await sleep(400);
      rows.push({ viewport: vp.name, about: true, ...about });
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
          /* 翻篇已按 v1 1.7.1 的决策移除（上一条/下一条 + 「第几条/共几条」全部下掉）：
           * 反向断言 .reader-nav 不得出现；字号按钮数量仍是正向契约（A-/A+ 在用）。 */
          navGone: !document.querySelector('.reader-nav, .reader-nav-pos'),
          fsBtns: document.querySelectorAll('.reader-fs .btn').length,
          /* 工具条吸顶：正文长到滚动之后，A-/A+/× 必须还在视口里。
           * 用 scrollHeight>clientHeight 确认这篇真的滚得动 —— 滚不动的「吸顶成功」是假的。 */
          toolsSticky: (() => {
            const t = document.querySelector('.reader-tools');
            // 滚动容器是 backdrop（sheet 自己不滚，见 style.css 的滚动条注释）
            const scroller = document.querySelector('.reader-backdrop');
            if (!t || !scroller) return { pos: null, canScroll: false, inView: false };
            const canScroll = scroller.scrollHeight > scroller.clientHeight + 40;
            if (canScroll) scroller.scrollTop = 900;
            const r = t.getBoundingClientRect();
            const sr = scroller.getBoundingClientRect();
            return {
              pos: getComputedStyle(t).position,
              canScroll,
              // 相对滚动口判断：吸顶后工具的顶边应贴着 backdrop 可视区上沿
              inView: r.top >= sr.top - 1 && r.bottom > sr.top && r.top < sr.bottom,
            };
          })(),
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

      /* 正文标签闭环：v2 保留「阅读层正文里的标签可点」（v1 口径），
       * 点 #tag → 关掉阅读层 → 列表出现 #{tag} 范围与唯一出口 ✕ → 点 ✕ 退回。
       * 这是标签筛选现在唯一的入口，断了它「按标签看」整条链路就没了。 */
      const tagFlow = await evalJs(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const tag = document.querySelector('.reader-meta .mini-tag');
        if (!tag) return { skipped: 'article-has-no-tags' };
        const name = tag.textContent.trim();
        tag.click();
        await wait(1500);
        const titleTxt = (document.querySelector('.list-title')?.textContent ?? '');
        const mid = {
          readerClosed: !document.querySelector('.reader-sheet'),
          scopeHasTag: titleTxt.includes(name),
          clearBtn: !!document.querySelector('.list-title .scope-x'),
          cards: document.querySelectorAll('.card').length,
        };
        document.querySelector('.list-title .scope-x')?.click();
        await wait(1200);
        return { tag: name, mid, cleared: !(document.querySelector('.list-title')?.textContent ?? '').includes(name) };
      })()`);
      rows.push({ viewport: vp.name, tagFlow: true, ...tagFlow });

      /* 方向键翻篇已随「上一条/下一条」移除（v1 1.7.1）：反向断言 ——
       * 在阅读层按 ←/→ 标题不许变。Esc 仍然有效，由下面的关闭验证。 */
      const keyNavGone = await evalJs(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const card = document.querySelector('.card');
        (card?.querySelector('.card-title') || card)?.click();
        await wait(1500);
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        const title = () => (document.querySelector('.reader-title')?.textContent ?? '').trim();
        const before = title();
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        await wait(800);
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
        await wait(800);
        return { before, after: title(), unchanged: !!before && before === title() };
      })()`);
      rows.push({ viewport: vp.name, keyNavGone: true, ...keyNavGone });

      const readerShot = await shot(`${prefix}-${vp.name}-reader.png`);
      rows.push({ viewport: vp.name, reader: true, ...reader, shot: readerShot });
      // 关闭阅读层，回到列表再切下一档
      await evalJs("document.querySelector('.reader-close')?.click()");
      await sleep(600);
    }

    /* ⋯ 溢出菜单键盘导航（只在菜单真的可见的窄屏档跑，桌面档查过 DOM 契约）。
     * 真实 keydown 走 window 监听（和实现同一入口），focus 轨迹用 document.activeElement 读 ——
     * 「菜单能点开」不等于「键盘能用」，这一轮补的就是后者。 */
    const menuVisible = await evalJs("!!document.querySelector('.topbar-more')?.offsetParent");
    if (menuVisible) {
      const menuKey = await evalJs(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const trig = document.querySelector('.topbar-more button');
        trig.click();
        await wait(400);
        const items = [...document.querySelectorAll('.more-menu [role="menuitem"]:not(:disabled)')];
        const focusOnOpen = items.includes(document.activeElement);
        const n = items.length;
        document.activeElement?.blur();
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        await wait(150);
        const afterDown = items.indexOf(document.activeElement);
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
        await wait(150);
        const afterUp = items.indexOf(document.activeElement);
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await wait(300);
        return {
          items: n, focusOnOpen, afterDown, afterUp,
          // 实现是首尾环绕：第一项按 ↑ 应落到最后一项，而不是停住
          upWraps: afterUp === n - 1,
          closedByEsc: !document.querySelector('.more-menu'),
          focusRestored: document.activeElement === trig,
        };
      })()`);
      rows.push({ viewport: vp.name, menuKey: true, ...menuKey });
    }
  }

  /* 触屏能力（hover:none / pointer:coarse）。
   *
   * ⚠️ 这一段只能**静态检查 CSSOM**，不能靠 `Emulation.setEmulatedMedia` 读运行结果：
   * Edge headless 不接受对 hover / pointer 的媒体特性覆盖（设了 matchMedia 仍是 false），
   * 而此时读到的 opacity=1 其实是鼠标停在第一行上造成的 hover —— 假阳性。
   * 所以这里退一步：确认「规则确实存在且确实包住了那几个控件」。
   * 规则被删掉 / 选择器被改名，都能被这条断言抓住；「浏览器有没有真的应用」只能靠真机。
   */
  const touch = await evalJs(`(() => {
    const rules = [...document.styleSheets].flatMap((s) => {
      try { return [...s.cssRules]; } catch { return []; }
    });
    const media = (needle) => rules.filter((r) => (r.conditionText ?? '').includes(needle));
    const covers = (blocks, sel) => blocks.some((b) =>
      [...(b.cssRules ?? [])].some((r) => (r.selectorText ?? '').includes(sel)));
    const hoverNone = media('hover: none');
    const coarse = media('pointer: coarse');
    return {
      cssHoverNoneRules: hoverNone.reduce((n, b) => n + (b.cssRules?.length ?? 0), 0),
      coversFeedOps: covers(hoverNone, '.feed-ops'),
      coversFavBtn: covers(hoverNone, '.fav-btn'),
      cssCoarseRules: coarse.reduce((n, b) => n + (b.cssRules?.length ?? 0), 0),
      // v1 实测尺寸：关闭 40 / 行内图标 32 / 收藏 34 / 菜单项 ≥44 —— 规则在，尺寸才可能在
      coversClose40: covers(coarse, '.nav-close'),
      coversTapTarget: covers(coarse, '.icon-btn'),
      coversFav34: covers(coarse, '.fav-btn'),
      coversMenu44: covers(coarse, '.more-menu button'),
    };
  })()`);
  rows.push({ viewport: 'touch', ...touch });

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
