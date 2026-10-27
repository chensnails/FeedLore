/* App Shell：顶栏（品牌 / 视图导航 / 刷新 / 添加到手机 / 主题 / 设置）
 * 与顶部阅读进度条。
 *
 * P4a 起 React 化：这两块 DOM 由本模块渲染，核心逻辑不再直接操作它们。
 *   - 数据经核心单例 `core.getShell()` 读取（一次性快照），核心派发 `window.__shellTick`
 *     时组件重读快照重绘；
 *   - 交互经 `core`：`switchView` / `refresh` / `cycleTheme` / `openSettings` / `promptInstall`；
 *   - 「顶栏高度 → CSS 变量 --topbar-h」（阅读页头部吸顶需要）也在此维护，用 ResizeObserver
 *     实测，覆盖字体加载完成 / 横竖屏切换等时机。
 *
 * 注意：`#topbarRoot` 就是 `<header class="topbar">` 本身（sticky），
 * 故本组件只渲染其内部内容，不能嵌套第二个 header。 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { core } from '@core';

/* 顶栏统一样式（v1.1.17）：所有可点项都是「图标 + 文字」，
 * 窄屏（≤560px）由 CSS 统一收掉文字只留图标（.btn-label 隐藏），
 * 所以导航与操作按钮共用 .btn-label 这一套约定。 */
const VIEWS = [
  { id: 'reader', label: '文章', ico: 'inbox' },
  { id: 'cards', label: '卡片', ico: 'grid' },
  { id: 'ai', label: '日报', ico: 'sparkle' },
];

/** shell 快照的兜底（核心尚未就绪时） */
const EMPTY = {
  subtitle: '正在加载频道…', view: 'reader',
  themeLabel: '跟随系统', themeIco: 'theme-auto',
  installReady: false, digestVisible: true,
};

function readShell() {
  try { return Object.assign({}, EMPTY, core.getShell()); } catch (_) { return EMPTY; }
}

export function TopBar() {
  const [snap, setSnap] = useState(readShell);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef(null);

  // 订阅 app.js 的 shell 变更通知
  useEffect(() => {
    const onTick = () => setSnap(readShell());
    window.addEventListener('__shellTick', onTick);
    onTick();
    return () => window.removeEventListener('__shellTick', onTick);
  }, []);

  // 顶栏高度 → CSS 变量 --topbar-h（阅读页 / 卡片页头部吸顶时贴在它下面）
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return undefined;
    const apply = () => {
      // 量外层 <header class="topbar">，不是内部那行 .topbar-inner：
      // 外层还带 1px 底边线，只量内层会让吸顶条少算 1px，头部顶端被顶栏压住一条缝。
      const host = el.closest('.topbar') || el;
      document.documentElement.style.setProperty('--topbar-h', Math.ceil(host.getBoundingClientRect().height) + 'px');
    };
    apply();
    // 首帧里字体 / 图标还没落位，高度可能是旧值；下一帧与字体加载完成各补一次
    const raf = requestAnimationFrame(apply);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(apply).catch(() => {});
    window.addEventListener('resize', apply);
    window.addEventListener('orientationchange', apply);
    let ro = null;
    if (window.ResizeObserver) { ro = new ResizeObserver(apply); ro.observe(el.closest('.topbar') || el); }
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', apply);
      window.removeEventListener('orientationchange', apply);
      if (ro) ro.disconnect();
    };
  }, []);

  /* 滚动状态 → body.is-scrolled。
   * 吸顶条静止时不必画边界线，一旦有内容从它下面穿过就需要一条 1px 的分隔
   * （见 style.css 的 body.is-scrolled 规则）。只切一个类，rAF 合并高频 scroll。 */
  useEffect(() => {
    let raf = 0;
    const apply = () => {
      raf = 0;
      const y = window.scrollY || window.pageYOffset || 0;
      document.body.classList.toggle('is-scrolled', y > 2);
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(apply); };
    apply();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  const onRefresh = useCallback(async () => {
    setBusy(true);
    try { await core.refresh(); } finally { setBusy(false); }
  }, []);
  const s = core;
  // 日报被账号关掉时整个入口不渲染（不是 disabled 灰着）：留着只会让人以为点坏了
  const views = snap.digestVisible === false ? VIEWS.filter((v) => v.id !== 'ai') : VIEWS;
  return (
    <div className="wrap topbar-inner" ref={rootRef}>
      <div className="brand">
        <svg className="brand-logo" viewBox="0 0 64 64" role="img" aria-label="笺川">
          <rect width="64" height="64" rx="15" fill="var(--accent)" />
          <rect x="8" y="17" width="33" height="37" rx="6" fill="var(--logo-fg)" />
          <rect x="15" y="25" width="19" height="5" rx="2.5" fill="var(--accent)" />
          <rect x="15" y="35" width="12" height="5" rx="2.5" fill="var(--accent)" />
          <rect x="15" y="45" width="16" height="5" rx="2.5" fill="var(--accent)" />
          <path d="M51.5 6 l2.9 7.1 7.1 2.9 -7.1 2.9 -2.9 7.1 -2.9 -7.1 -7.1 -2.9 7.1 -2.9 z" fill="var(--logo-fg)" />
        </svg>
        <div className="brand-text">
          <h1>笺川</h1>
          <p id="subtitle">{snap.subtitle}</p>
        </div>
      </div>
      <div className="topbar-actions">
        <nav className="viewnav" id="viewNav" role="navigation" aria-label="视图切换">
          {views.map((v) => {
            const active = snap.view === v.id;
            return (
              <button
                type="button"
                key={v.id}
                className={'viewnav-btn' + (active ? ' active' : '')}
                data-view={v.id}
                /* 窄屏把 .btn-label 设为 display:none（移出无障碍树），按钮就只剩一枚无名图标。
                   名字必须显式给到 aria-label，title 只作鼠标提示。 */
                aria-label={v.label}
                title={v.label}
                aria-current={active ? 'page' : undefined}
                onClick={() => { if (s.switchView) s.switchView(v.id); }}
              >
                <svg className="ico" aria-hidden="true" focusable="false"><use href={'#i-' + v.ico} /></svg>
                <span className="btn-label" aria-hidden="true">{v.label}</span>
              </button>
            );
          })}
        </nav>
        <button className="btn btn-ghost" id="refreshBtn" type="button" title="重新拉取" disabled={busy} onClick={onRefresh}>
          <svg className={'ico' + (busy ? ' spin' : '')} aria-hidden="true" focusable="false"><use href="#i-refresh" /></svg>
          <span className="btn-label">刷新</span>
        </button>
        <button
          className="btn btn-ghost" id="themeBtn" type="button"
          title={'主题：' + snap.themeLabel + '（点击切换）'} aria-label={'主题：' + snap.themeLabel}
          onClick={() => { if (s.cycleTheme) s.cycleTheme(); }}
        >
          <svg className="ico" id="themeIco" aria-hidden="true" focusable="false"><use href={'#i-' + snap.themeIco} /></svg>
          <span className="btn-label">主题</span>
        </button>
        <button className="btn btn-ghost" id="settingsBtn" type="button" title="设置" onClick={() => { if (s.openSettings) s.openSettings(); }}>
          <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-settings" /></svg>
          <span className="btn-label">设置</span>
        </button>
      </div>
    </div>
  );
}
