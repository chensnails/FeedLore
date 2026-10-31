#!/usr/bin/env node
/**
 * 构建产物校验（CI 用，不需要起服务、不需要数据库）。
 *
 * 为什么单独一个脚本而不是塞进单测：这里查的是**打包之后**的事实。
 * 单元测试跑的是源码，而下面这些坑全都只在 dist 里才看得出来：
 * - `public/` 里的 PWA 文件没进产物（manifest 404 → 装到主屏没名字没图标）
 * - 静态资源没带内容哈希（固定文件名 + CDN = 新 HTML 配旧 CSS，1.4.0 事故）
 * - CSS 里的触屏媒体查询被工具链吞掉（手机上「hover 才出现」的按钮等于不存在）
 *
 * 用法：pnpm --filter @feedlore/web build && node scripts/verify-dist.mjs
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIST = 'apps/web/dist';
const fails = [];
const oks = [];
const check = (ok, msg) => (ok ? oks.push(msg) : fails.push(msg));

if (!existsSync(DIST)) {
  console.error(`✗ 找不到 ${DIST}，先跑 pnpm --filter @feedlore/web build`);
  process.exit(1);
}

/* ---------------- 入口 HTML ---------------- */
const htmlPath = join(DIST, 'index.html');
check(existsSync(htmlPath), 'index.html 存在');
const html = existsSync(htmlPath) ? readFileSync(htmlPath, 'utf8') : '';
check(/<link[^>]+rel="manifest"[^>]+href="\/manifest\.json"/.test(html), 'index.html 引用了 /manifest.json');
check(/<meta[^>]+name="theme-color"/.test(html), 'index.html 有 theme-color');

// 静态资源必须带内容哈希：固定名会被 CDN/浏览器缓存住，导致「新 HTML + 旧 CSS」
const assets = html.match(/\/assets\/[A-Za-z0-9._-]+/g) ?? [];
const unhashed = assets.filter((a) => /\/assets\/(index|main|style)\.(js|css)$/.test(a));
check(assets.length > 0, `index.html 引用了 ${assets.length} 个带哈希资源`);
check(unhashed.length === 0, `没有未加哈希的固定资源名${unhashed.length ? `（${unhashed.join(', ')}）` : ''}`);

/* ---------------- PWA ---------------- */
const mfPath = join(DIST, 'manifest.json');
check(existsSync(mfPath), 'manifest.json 进了产物');
if (existsSync(mfPath)) {
  let mf = null;
  try {
    mf = JSON.parse(readFileSync(mfPath, 'utf8'));
  } catch {
    fails.push('manifest.json 不是合法 JSON');
  }
  if (mf) {
    check(Boolean(mf.name), `manifest 有 name（${mf.name ?? '缺失'}）`);
    check(Boolean(mf.start_url), 'manifest 有 start_url');
    check(Array.isArray(mf.icons) && mf.icons.length >= 3, `manifest 有 ${mf.icons?.length ?? 0} 个图标（≥3）`);
    // 每个图标文件都要真的存在，否则装到桌面是一个白框
    for (const ic of mf.icons ?? []) {
      const f = join(DIST, String(ic.src ?? '').replace(/^\//, ''));
      check(existsSync(f), `图标存在：${ic.src}`);
    }
  }
}

const swPath = join(DIST, 'sw.js');
check(existsSync(swPath), 'sw.js 进了产物');
if (existsSync(swPath)) {
  const sw = readFileSync(swPath, 'utf8');
  check(sw.length > 200, 'sw.js 非空');
  /* 预缓存清单里不能出现带哈希的产物名：每次构建名字都变，
   * 写死的结果是「装好的 PWA 永远取不到新版本」。
   *
   * ⚠️ 只查 PRECACHE 数组本身，不能对整份文件跑正则 —— sw.js 顶部的注释里
   * 举了个 `/assets/index-<hash>.css` 的反例，全文匹配会把注释当成违规。 */
  const pre = sw.match(/const PRECACHE\s*=\s*\[([\s\S]*?)\]/);
  check(Boolean(pre), 'sw 有 PRECACHE 清单');
  if (pre) {
    check(!/\/assets\//.test(pre[1]), 'PRECACHE 里没有带哈希的 /assets/ 路径');
    check(pre[1].includes("'/'"), 'PRECACHE 含应用外壳 /（离线导航回退要用）');
  }
  check(/\/api\//.test(sw) && /(skip|passthrough|return)/i.test(sw), 'sw 对 /api 有明确的放行策略');
}

for (const icon of [
  'favicon.ico',
  'favicon.svg',
  'favicon-32.png',
  'apple-touch-icon.png',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
]) {
  check(existsSync(join(DIST, icon)), `图标文件在产物里：${icon}`);
}

/* ---------------- CSS 关键规则 ---------------- */
const cssDir = join(DIST, 'assets');
const cssFile = existsSync(cssDir) ? readdirSync(cssDir).find((f) => f.endsWith('.css')) : undefined;
check(Boolean(cssFile), 'CSS 产物存在');
if (cssFile) {
  const css = readFileSync(join(cssDir, cssFile), 'utf8');
  // 触屏适配：这两条媒体查询没了，手机上隐藏式操作就永远点不到
  check(/hover:\s*none/.test(css), 'CSS 含 @media (hover: none)');
  check(/pointer:\s*coarse/.test(css), 'CSS 含 @media (pointer: coarse)');
  // 阅读层令牌：正文排版全靠这几个变量，被改名/删掉会让设置项变成死开关
  check(/--reader-fs/.test(css), 'CSS 含 --reader-fs 令牌');
  check(/--reader-width/.test(css), 'CSS 含 --reader-width 令牌');
  // 抽屉：窄屏导航的唯一实现方式
  check(/\.sidebar\.open/.test(css), 'CSS 含抽屉展开态 .sidebar.open');

  /* ---- P10.10 版本判据 ----
   * 每条都是「少了会坏体验 / 多了会坏性能」的双向闸门，全部来自这一轮的决策记录。 */
  check(/\.list-bar\s*\{[^}]*position: *sticky/.test(css), '列表工具块 .list-bar 是 sticky（滚下去筛选/排序还在）');
  check(/\.reader-tools\s*\{[^}]*position: *sticky/.test(css), '阅读层工具条 .reader-tools 是 sticky');
  check(/\.sk-line/.test(css) && /@keyframes *sk\b/.test(css), '骨架屏规则与 shimmer 关键帧在产物里');
  check(/@keyframes *card-in\b/.test(css), '卡片入场错峰 card-in 关键帧在产物里');
  check(/\.mini-tag/.test(css), '正文标签按钮 .mini-tag 在（阅读层点标签筛列表的唯一入口）');

  // v1 后续版本删掉的东西，v2 必须也不在（被哪轮顺手加回来，这里拦住）
  check(!/\.tag-btn/.test(css), 'CSS 无已删除的 .tag-btn（顶部标签云）');
  check(!/\.tag-bar/.test(css), 'CSS 无已删除的 .tag-bar');
  check(!/\.reader-nav[^-a-z]/.test(css), 'CSS 无已删除的 .reader-nav（阅读层翻篇）');

  /* 玻璃模糊预算：backdrop-filter 只允许出现在「静止表面」（顶栏 / 浮层 sheet）。
   * 滚动容器和吸顶层每帧重采样必掉帧 —— v1 用性能实测换来的规矩，加了 sticky 之后
   * 最容易复发的就是「给 sticky 条补一层模糊好看一点」。6 条规则 × webkit 双写 = 12 为上限。 */
  const blurDecls = (css.match(/backdrop-filter:\s*var\(--glass-blur\)/g) ?? []).length;
  check(blurDecls <= 12, `活跃 backdrop-filter 声明 ${blurDecls} 条（≤12：6 个静止表面 × webkit 双写）`);
}

/* ---------------- JS 侧：阅读层 ↔ 路由 ---------------- */
const jsRef = html.match(/\/assets\/index-[A-Za-z0-9._-]+\.js/)?.[0];
const js = jsRef ? readFileSync(join(DIST, jsRef.replace(/^\//, '')), 'utf8') : '';
/* 「点正文标签 = 筛列表 + 退出阅读层」必须是一次 store 写入。写成 setTag() + close()
 * 两行时，路由先 push 一条带标签的阅读层、再对它执行关闭时的 back()，落回的那条历史
 * 没有标签 —— 实测表现是「点了标签：文章还开着、列表也没筛」。 */
check(/tagFromEntry/.test(js), '阅读层标签走一次性 tagFromEntry（拆回两行就红）');

/* ---------------- 汇总 ---------------- */
for (const m of oks) console.log(`✓ ${m}`);
if (fails.length) {
  console.error('');
  for (const m of fails) console.error(`✗ ${m}`);
  console.error(`\n产物校验失败：${fails.length} 项`);
  process.exit(1);
}
console.log(`\n产物校验通过：${oks.length} 项`);
