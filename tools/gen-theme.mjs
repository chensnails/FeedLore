// 生成并校验主题 token：中性色（亮 + CommaFeed 中性灰深）+ 6 套主色，全部对比度达标后吐出可直接粘进 style.css 的 CSS。
// 用法：node gen-theme.mjs > theme-block.css
//
// 关键设计：主色分三个角色
//   --accent       填充色（按钮底、激活胶囊底、圆点）→ 深色下偏亮，配 --on-accent 文字
//   --accent-text  主色当「文字/图标」用（任何中性底或 accent-soft 底上）→ 深色下再提亮、亮色下压深
//   --accent-strong 填充色的 hover 态
const hx = (h) => h.replace('#', '').match(/../g).map((x) => parseInt(x, 16));
const toHex = (rgb) => '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
const hsl = (h, s, l) => {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return toHex([f(0) * 255, f(8) * 255, f(4) * 255]);
};
const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = (h) => { const [r, g, b] = hx(h); return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); };
const cr = (a, b) => { const l1 = lum(a), l2 = lum(b); const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]; return (hi + 0.05) / (lo + 0.05); };
/** sRGB 空间直接混合 —— 派生浅/深底色用它（线性混合对暗色会偏亮） */
const mixS = (a, b, t) => {
  const A = hx(a), B = hx(b);
  return toHex([0, 1, 2].map((i) => A[i] + (B[i] - A[i]) * t));
};
const rgba = (hex, a) => { const [r, g, b] = hx(hex); return `rgba(${r}, ${g}, ${b}, ${a})`; };
/** 半透明色叠在底色上 —— 浏览器在 sRGB 空间做 alpha 合成 */
const over = (hex, alpha, bg) => {
  const A = hx(hex), B = hx(bg);
  return toHex([0, 1, 2].map((i) => A[i] * alpha + B[i] * (1 - alpha)));
};

/* ============ 中性色 ============ */
// 深色：纯中性灰（饱和度 0），取自 CommaFeed 用的 Mantine dark 调色板
//   dark-7 #242424 页面底 / dark-6 #2e2e2e 卡片 / dark-5 #3b3b3b hover / dark-4 #424242 边框
//   正文照搬 dark-0 #c9c9c9（9.37:1 on 页面底，比原来的 12.53:1 更柔和，不 halation）
// 唯一没照搬的是「弱化文字」：Mantine 的 dark-2 #828282 压在卡片上只有 3.53:1，
// 低于 4.5:1 门槛（这正是上一轮修掉的同类问题），所以把 muted / faint 两档抬到达标。
// text-2 照搬 dark-1 #b8b8b8（6.85:1）没问题。
const DARK = {
  bg: '#242424', panel: '#2e2e2e', 'panel-2': '#292929',
  hover: '#3b3b3b', border: '#424242', 'border-strong': '#575757',
  text: '#c9c9c9', 'text-2': '#b8b8b8', 'text-muted': '#a6a6a6', 'text-faint': '#999999',
};
// GitHub Primer Dark canonical values
const GITHUB = {
  bg: '#0d1117', panel: '#151b23', 'panel-2': '#010409',
  hover: '#1c242e', border: '#3d444d', 'border-strong': '#656c76',
  text: '#f0f6fc', 'text-2': '#c9d1d9', 'text-muted': '#9198a1', 'text-faint': '#8b949e',
};
const LIGHT = {
  bg: '#f4f5f7', panel: '#ffffff', 'panel-2': '#fbfcfd',
  hover: '#f5f7fa', border: '#e5e7ec', 'border-strong': '#d5d9e0',
  text: '#1b1f26', 'text-2': '#333c4a', 'text-muted': '#57616f', 'text-faint': '#66717f',
};

/* ============ 6 套主色：每套只给一个基准值 ============ */
const ACCENTS = {
  blue: { label: '蓝', light: '#1f5ce8', dark: '#7aa2ff' },
  violet: { label: '靛紫', light: '#6a3fe0', dark: '#a68bff' },
  teal: { label: '青', light: '#0b6f74', dark: '#4fd1c5' },
  green: { label: '翠绿', light: '#0e7440', dark: '#5ed68f' },
  amber: { label: '琥珀', light: '#9a4a06', dark: '#f0b45f' },
  rose: { label: '玫红', light: '#c0255c', dark: '#ff8fb1' },
};

const NEUTRAL = {
  light: {
    tint: '#ffffff', softT: 0.92, soft2T: 0.84,
    strongTo: '#000000', strongT: 0.16, textTo: '#000000', textT: 0.1,
    glowA: 0.3, glowSoftA: 0.26, ringA: 0.16, logoA: 0.26, onAccent: '#ffffff',
  },
  dark: {
    tint: DARK.panel, softT: 0.86, soft2T: 0.74,
    strongTo: '#ffffff', strongT: 0.2, textTo: '#ffffff', textT: 0.3,
    glowA: 0.3, glowSoftA: 0.26, ringA: 0.24, logoA: 0.3, onAccent: null,
  },
};

const problems = [];
const need = (label, fg, bg, min) => {
  const r = cr(fg, bg);
  if (r < min) problems.push(`${label}：${fg} on ${bg} = ${r.toFixed(2)}:1（需 ≥${min}）`);
  return r;
};

function accentVars(mode, base, n) {
  const onAccent = n.onAccent || (cr(base, '#ffffff') >= cr(base, '#111111') ? '#ffffff' : '#111111');
  // GitHub 主题的 accent 不派生：Primer 的 hover 蓝比填充蓝更亮，混白派生会不够亮，
  // 而 accent-text 直接用 fgColor-accent 反而比派生值更亮。所以允许 n 显式给值。
  const strong = n.strongOverride || mixS(base, n.strongTo, n.strongT);
  const text = n.textOverride || mixS(base, n.textTo, n.textT);
  const soft = mixS(base, n.tint, n.softT);
  const soft2 = mixS(base, n.tint, n.soft2T);
  const tag = `${mode}/${base}`;
  // 填充：文字压在填充色上
  need(`${tag} 按钮文字`, onAccent, base, 4.5);
  // hover：GitHub 主题只在 n.allowDimHover 时豁免 —— Primer 的 hover 蓝 #4493f8 比填充蓝
  // 更亮，白字压上去只有 3.10:1。这是 GitHub 自己的取舍（按住 hover 是短暂态，非文字对象
  // WCAG 只要求 3:1），用户点名要「成熟的 github dark 方案」，所以刻意忠实而非修正。
  // 我们的主题没有这个豁免，hover 一律混白派生到达标为止。
  const hoverR = cr(onAccent, strong);
  if (hoverR < 4.5 && !n.allowDimHover) problems.push(`${tag} 按钮 hover 文字：${onAccent} on ${strong} = ${hoverR.toFixed(2)}:1（需 ≥4.5）`);
  // 文字：主色当文字，压在各种中性底 / 主色浅底上
  // github 走 GitHub 自己的中性色（比 :root 的亮色更暗），不能落回 LIGHT
  const NEUTRALS_BY_MODE = { light: LIGHT, dark: DARK, github: GITHUB };
  const neutrals = NEUTRALS_BY_MODE[mode] || LIGHT;
  need(`${tag} 主色文字/背景`, text, neutrals.bg, 4.5);
  need(`${tag} 主色文字/卡片`, text, neutrals.panel, 4.5);
  need(`${tag} 主色文字/hover`, text, neutrals.hover, 4.5);
  need(`${tag} 主色文字 on 浅底`, text, soft, 4.5);
  need(`${tag} 主色文字 on 较深浅底`, text, soft2, 4.5);
  return {
    '--accent': base, '--accent-strong': strong, '--accent-text': text,
    '--accent-soft': soft, '--accent-soft-2': soft2,
    '--accent-glow': rgba(base, n.glowA), '--accent-glow-soft': rgba(base, n.glowSoftA),
    '--focus-ring': rgba(base, n.ringA), '--logo-shadow': rgba(base, n.logoA), '--on-accent': onAccent,
  };
}

/* ---- 校验中性色 ----
   GitHub 主题单独一组：它的正文 #f0f6fc on #0d1117 = 17.39:1，远超本项目的 13:1
   舒适上限，但这是用户点名要的成熟方案，不是缺陷 —— 所以 strict 只对 CommaFeed
   暗色开。github 仍走全部下限校验（正文 ≥7、次级 ≥5、muted/faint ≥4.5）。 */
for (const [mode, p, strict] of [
  ['暗色（CommaFeed）', DARK, true], ['亮色', LIGHT, false], ['GitHub', GITHUB, false],
]) {
  need(`${mode} 正文/背景`, p.text, p.bg, 7);
  need(`${mode} 正文/卡片`, p.text, p.panel, 7);
  need(`${mode} 次级/卡片`, p['text-2'], p.panel, 5);
  need(`${mode} muted/卡片`, p['text-muted'], p.panel, 4.5);
  need(`${mode} faint/卡片`, p['text-faint'], p.panel, 4.5);
  need(`${mode} muted/背景`, p['text-muted'], p.bg, 4.5);
  need(`${mode} faint/背景`, p['text-faint'], p.bg, 4.5);
  need(`${mode} 次级/背景`, p['text-2'], p.bg, 4.5);
  if (strict) {
    const c = cr(p.text, p.bg);
    if (c > 13) problems.push(`${mode} 正文对比度过高 ${c.toFixed(2)}:1（需 ≤13，否则深色下白字会发光）`);
    if (c < 8) problems.push(`${mode} 正文对比度过低 ${c.toFixed(2)}:1（需 ≥8）`);
  }
}

/* ---- 语义色 ---- */
const SEM = {
  light: {
    green: '#0f7a43', danger: '#c62828', 'danger-border': '#f0c4c4',
    'ok-bg': '#e9f7ee', 'ok-border': '#bfe6cd', 'ok-text': '#0b6b3a',
    'err-bg': '#fdecec', 'err-border': '#f5c9c9', 'err-text': '#b91c1c',
    'warn-bg': '#fdf3e0', 'warn-text': '#8a5a08',
    star: '#a8710a', 'star-soft': 'rgba(168, 113, 10, .14)',
  },
  dark: {
    green: '#5ed68f', danger: '#ff8a8a', 'danger-border': 'rgba(255, 138, 138, .42)',
    'ok-bg': '#14261b', 'ok-border': '#28563a', 'ok-text': '#7ee2a4',
    'err-bg': '#2b1919', 'err-border': '#552c2c', 'err-text': '#ff9c9c',
    'warn-bg': '#2b2416', 'warn-text': '#e8b761',
    star: '#f0b45f', 'star-soft': 'rgba(240, 180, 95, .18)',
  },
};
need('亮色 danger/卡片', SEM.light.danger, LIGHT.panel, 4.5);
need('亮色 ok-text/ok-bg', SEM.light['ok-text'], SEM.light['ok-bg'], 4.5);
need('亮色 err-text/err-bg', SEM.light['err-text'], SEM.light['err-bg'], 4.5);
need('亮色 warn-text/warn-bg', SEM.light['warn-text'], SEM.light['warn-bg'], 4.5);
need('暗色 danger/卡片', SEM.dark.danger, DARK.panel, 4.5);
need('暗色 ok-text/ok-bg', SEM.dark['ok-text'], SEM.dark['ok-bg'], 4.5);
need('暗色 err-text/err-bg', SEM.dark['err-text'], SEM.dark['err-bg'], 4.5);
need('暗色 warn-text/warn-bg', SEM.dark['warn-text'], SEM.dark['warn-bg'], 4.5);
need('暗色 green/卡片', SEM.dark.green, DARK.panel, 4.5);
need('亮色 green/卡片', SEM.light.green, LIGHT.panel, 4.5);

/* ---- GitHub 主题专属：语义色 / misc / 阴影（取自 Primer Dark） ---- */
const SEM_GITHUB = {
  green: '#3fb950', danger: '#f85149', 'danger-border': 'rgba(248, 81, 73, .42)',
  'ok-bg': '#0f2a17', 'ok-border': '#1f5132', 'ok-text': '#56d364',
  'err-bg': '#2b1416', 'err-border': '#5c2327', 'err-text': '#ff7b72',
  'warn-bg': '#2b2210', 'warn-text': '#e3b341',
  star: '#d29922', 'star-soft': 'rgba(210, 153, 34, .18)',
};
const MISC_GITHUB = {
  'toast-bg': '#e6edf3', 'toast-text': '#0d1117', 'toast-ok': '#1f7a35',
  'badge-bg': 'rgba(0, 0, 0, .68)', 'badge-text': '#e6edf3',
  'chip-bg': 'rgba(255, 255, 255, .09)', 'chip-bg-strong': 'rgba(255, 255, 255, .12)',
  'chip-text': '#c9d1d9', 'chip-solid': 'rgba(255, 255, 255, .07)',
  'sk-a': '#21262d', 'sk-b': '#2a313a',
  'media-bg': '#161b22', 'media-grad': 'linear-gradient(135deg, #21262d, #1a1f26)', 'media-ico': '#8b949e',
  'switch-knob': '#e6edf3', 'overlay': 'rgba(0, 0, 0, .68)',
};
const shadowGitHub = [
  '  --shadow: 0 1px 2px rgba(1, 4, 9, .5), 0 4px 16px rgba(1, 4, 9, .4);',
  '  --shadow-hover: 0 8px 28px rgba(1, 4, 9, .58);',
  '  --shadow-lg: 0 20px 60px rgba(1, 4, 9, .7);',
  '  --shadow-sm: 0 1px 3px rgba(1, 4, 9, .62);',
  '  --shadow-toast: 0 8px 28px rgba(1, 4, 9, .6);',
].join('\n');
const ACCENTS_GITHUB = {
  // fgColor-accent #4493f8（文字用）vs accent-emphasis #1f6feb（填充用），白字压其上 4.63:1
  blue: { light: '#1f6feb', dark: '#4493f8' },
};
const NEUTRAL_GITHUB = {
  dark: {
    // soft2T 比其它主题更大（更淡）而不是更浓：GitHub 的 accent-subtle 只有一档
    // （rgba(56,139,253,.15)），没有"更浓的浅主色底"，做浓了 accent-text 会压不住。
    tint: GITHUB.panel, softT: 0.86, soft2T: 0.80,
    strongTo: '#ffffff', strongT: 0.14, textTo: '#ffffff', textT: 0.22,
    strongOverride: '#4493f8', textOverride: '#4493f8', allowDimHover: true,
    glowA: 0.3, glowSoftA: 0.26, ringA: 0.24, logoA: 0.3, onAccent: '#ffffff',
  },
};
// GitHub 主题单独校验：on-accent 的白色要压在填充蓝上
need('GitHub 白字/主色填充', '#ffffff', '#1f6feb', 4.5);

/* ---- toast / badge / chip / 骨架屏 / 媒体占位 ---- */
const MISC = {
  light: {
    'toast-bg': '#22252b', 'toast-text': '#f5f7fa', 'toast-ok': '#6ee7a0',
    'badge-bg': 'rgba(15, 20, 28, .72)', 'badge-text': '#ffffff',
    'chip-bg': 'rgba(255, 255, 255, .9)', 'chip-bg-strong': 'rgba(255, 255, 255, .92)',
    'chip-text': '#333c4a', 'chip-solid': '#eef1f7',
    'sk-a': '#eef1f6', 'sk-b': '#e4e9f0',
    'media-bg': '#eef1f6', 'media-grad': 'linear-gradient(135deg, #f2f5fa, #e7ecf4)', 'media-ico': '#7b8694',
    'switch-knob': '#ffffff', 'overlay': 'rgba(18, 22, 30, .42)',
  },
  dark: {
    'toast-bg': '#e6e6e6', 'toast-text': '#1a1a1a', 'toast-ok': '#0f7a43',
    'badge-bg': 'rgba(0, 0, 0, .62)', 'badge-text': '#e6e6e6',
    'chip-bg': 'rgba(255, 255, 255, .1)', 'chip-bg-strong': 'rgba(255, 255, 255, .13)',
    'chip-text': '#c2c2c2', 'chip-solid': 'rgba(255, 255, 255, .08)',
    'sk-a': '#2b2b2b', 'sk-b': '#353535',
    'media-bg': '#232323', 'media-grad': 'linear-gradient(135deg, #2b2b2b, #222222)', 'media-ico': '#7d7d7d',
    'switch-knob': '#e6e6e6', 'overlay': 'rgba(0, 0, 0, .62)',
  },
};
need('亮色 toast', MISC.light['toast-text'], MISC.light['toast-bg'], 4.5);
need('暗色 toast', MISC.dark['toast-text'], MISC.dark['toast-bg'], 4.5);
need('亮色 toast 图标', MISC.light['toast-ok'], MISC.light['toast-bg'], 3);
need('暗色 toast 图标', MISC.dark['toast-ok'], MISC.dark['toast-bg'], 3);
need('亮色 chip', MISC.light['chip-text'], MISC.light['chip-solid'], 4.5);
need('暗色 chip', MISC.dark['chip-text'], over('#ffffff', 0.08, DARK.hover), 4.5);
need('亮色 badge', MISC.light['badge-text'], over('#0f141c', 0.72, '#ffffff'), 4.5);
need('暗色 badge', MISC.dark['badge-text'], over('#000000', 0.62, '#ffffff'), 4.5);
need('亮色 骨架/文字', LIGHT['text-faint'], MISC.light['sk-a'], 3);
need('亮色 媒体图标', MISC.light['media-ico'], MISC.light['media-bg'], 3);
need('暗色 媒体图标', MISC.dark['media-ico'], MISC.dark['media-bg'], 3);
need('GitHub 媒体图标', MISC_GITHUB['media-ico'], MISC_GITHUB['media-bg'], 3);
need('GitHub danger/卡片', SEM_GITHUB.danger, GITHUB.panel, 4.5);
need('GitHub ok-text/ok-bg', SEM_GITHUB['ok-text'], SEM_GITHUB['ok-bg'], 4.5);
need('GitHub err-text/err-bg', SEM_GITHUB['err-text'], SEM_GITHUB['err-bg'], 4.5);
need('GitHub warn-text/warn-bg', SEM_GITHUB['warn-text'], SEM_GITHUB['warn-bg'], 4.5);
need('GitHub green/卡片', SEM_GITHUB.green, GITHUB.panel, 4.5);
need('GitHub toast', MISC_GITHUB['toast-text'], MISC_GITHUB['toast-bg'], 4.5);
need('GitHub badge', MISC_GITHUB['badge-text'], over('#000000', 0.68, '#0d1117'), 4.5);

/* ---- 输出 ---- */
const fmt = (o) => Object.entries(o).map(([k, v]) => `  ${k.startsWith('--') ? k : '--' + k}: ${v};`).join('\n');
const shadowLight = [
  '  --shadow: 0 1px 2px rgba(20, 24, 30, .04), 0 4px 16px rgba(20, 24, 30, .05);',
  '  --shadow-hover: 0 6px 24px rgba(20, 24, 30, .10);',
  '  --shadow-lg: 0 20px 60px rgba(16, 18, 22, .28);',
  '  --shadow-sm: 0 1px 3px rgba(20, 24, 30, .1);',
  '  --shadow-toast: 0 8px 28px rgba(16, 18, 22, .3);',
].join('\n');
const shadowDark = [
  '  --shadow: 0 1px 2px rgba(0, 0, 0, .34), 0 4px 16px rgba(0, 0, 0, .3);',
  '  --shadow-hover: 0 8px 28px rgba(0, 0, 0, .46);',
  '  --shadow-lg: 0 20px 60px rgba(0, 0, 0, .58);',
  '  --shadow-sm: 0 1px 3px rgba(0, 0, 0, .48);',
  '  --shadow-toast: 0 8px 28px rgba(0, 0, 0, .52);',
].join('\n');
const arrow = (stroke) => `  --select-arrow: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'><path d='M2 4l4 4 4-4' stroke='%23${stroke.replace('#', '')}' stroke-width='1.6' fill='none' stroke-linecap='round'/></svg>");`;
/** 外观页的色块：6 套主色各给一个变量，深浅两模式取各自那一档 */
const swatches = (mode) => Object.fromEntries(
  Object.entries(ACCENTS).map(([k, a]) => [`--sw-${k}`, mode === 'dark' ? a.dark : a.light])
);

const out = [];
out.push('/* ---------- 亮色（默认 · 主色 = 蓝） ---------- */');
out.push(':root {');
out.push('  color-scheme: light;');
out.push(fmt({ ...LIGHT, ...MISC.light, ...SEM.light }));
out.push(fmt(accentVars('light', ACCENTS.blue.light, NEUTRAL.light)));
out.push(arrow(LIGHT['text-muted']));
out.push(shadowLight);
out.push('  --radius: 14px;');
out.push('');
out.push('  /* ---------- 外观偏好（字号 / 阅读字体 / 行高 / 阅读宽度） ----------');
out.push('     由 <head> 内联脚本按 localStorage 写进 html 的属性上，首屏即生效。');
out.push('     页面里所有 font-size 都是 rem，所以改 html 的 font-size 就能整体缩放。 */');
out.push('  --font-ui: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB",');
out.push('    "Microsoft YaHei", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;');
out.push('  --font-read: var(--font-ui);');
out.push('  --reader-lh: 1.75;');
out.push('  --reader-width: 51.25rem;');
out.push('');
out.push('  /* 外观页的 6 个主色色块：跟着「当前主题」深浅换，但不跟选中的主色走，');
out.push('     所以 6 个色始终能一眼分辨 */');
out.push(fmt(swatches('light')));
out.push('}');

out.push('');
out.push('/* ---------- 亮色 · 其它主色 ---------- */');
for (const [k, a] of Object.entries(ACCENTS)) {
  if (k === 'blue') continue;
  out.push(`html[data-accent="${k}"] {`);
  out.push(fmt(accentVars('light', a.light, NEUTRAL.light)));
  out.push('}');
}

out.push('');
out.push('/* ---------- 深色（CommaFeed 中性灰 · 主色 = 蓝） ---------- */');
out.push('html[data-theme="dark"] {');
out.push('  color-scheme: dark;');
out.push(fmt({ ...DARK, ...MISC.dark, ...SEM.dark }));
out.push(fmt(accentVars('dark', ACCENTS.blue.dark, NEUTRAL.dark)));
out.push(arrow(DARK['text-faint']));
out.push(shadowDark);
out.push('');
out.push(fmt(swatches('dark')));
out.push('}');

out.push('');
out.push('/* ---------- 深色 · 其它主色 ---------- */');
for (const [k, a] of Object.entries(ACCENTS)) {
  if (k === 'blue') continue;
  out.push(`html[data-theme="dark"][data-accent="${k}"] {`);
  out.push(fmt(accentVars('dark', a.dark, NEUTRAL.dark)));
  out.push('}');
}

/* GitHub 主题：自带一套主色，不和 [data-accent] 联动。
   放在最后是刻意的 —— 它对 --accent-* 的声明特异性 (0,1,1) 高于 :root，
   但和 html[data-accent="x"] 同级，靠源码顺序赢。 */
out.push('');
out.push('/* ---------- GitHub Primer Dark（整套主题，主色固定 GitHub 蓝） ---------- */');
out.push('html[data-theme="github"] {');
out.push('  color-scheme: dark;');
out.push(fmt({ ...GITHUB, ...SEM_GITHUB, ...MISC_GITHUB }));
// 注意 base 取 .light（= 填充色 #1f6feb）；.dark（= fgColor-accent #4493f8）另作校验
out.push(fmt(accentVars('github', ACCENTS_GITHUB.blue.light, NEUTRAL_GITHUB.dark)));
out.push(arrow(GITHUB['text-faint']));
out.push(shadowGitHub);
out.push('}');
out.push('/* GitHub 主题下不显示主色色板，但 --sw-* 仍要有值（外观页色板可能先渲染） */');
out.push(fmt(swatches('dark')));

if (problems.length) {
  console.error('!! 有 ' + problems.length + ' 项不达标：');
  problems.forEach((p) => console.error('   ' + p));
  process.exit(1);
}
console.error('✓ 全部对比度校验通过（' + (Object.keys(ACCENTS).length * 2) + ' 套配色 × 深浅两模式）');
console.log(out.join('\n'));
