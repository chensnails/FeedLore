/* App Shell：顶栏（品牌 / 视图导航 / 条资源统计 / 刷新 / 添加到手机 / 主题 / 设置）
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
  stat: '—', subtitle: '正在加载频道…', view: 'reader',
  themeLabel: '跟随系统', themeIco: 'theme-auto',
  installReady: false, statVisible: false,
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

  // 顶栏高度 → CSS 变量 --topbar-h（阅读页头部在窄屏下吸在顶栏下面）
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return undefined;
    const apply = () => document.documentElement.style.setProperty('--topbar-h', el.offsetHeight + 'px');
    apply();
    window.addEventListener('resize', apply);
    window.addEventListener('orientationchange', apply);
    let ro = null;
    if (window.ResizeObserver) { ro = new ResizeObserver(apply); ro.observe(el); }
    return () => {
      window.removeEventListener('resize', apply);
      window.removeEventListener('orientationchange', apply);
      if (ro) ro.disconnect();
    };
  }, []);

  const onRefresh = useCallback(async () => {
    setBusy(true);
    try { await core.refresh(); } finally { setBusy(false); }
  }, []);

  const s = core;
  return (
    <div className="wrap topbar-inner" ref={rootRef}>
      <div className="brand">
        <svg className="brand-logo" viewBox="0 0 64 64" role="img" aria-label="笺川">
          <rect width="64" height="64" rx="15" style={{ fill: 'var(--accent)' }} />
          <rect x="8" y="17" width="33" height="37" rx="6" fill="var(--logo-fg)" />
          <rect x="15" y="25" width="19" height="5" rx="2.5" style={{ fill: 'var(--accent)' }} />
          <rect x="15" y="35" width="12" height="5" rx="2.5" style={{ fill: 'var(--accent)' }} />
          <rect x="15" y="45" width="16" height="5" rx="2.5" style={{ fill: 'var(--accent)' }} />
          <path d="M51.5 6 l2.9 7.1 7.1 2.9 -7.1 2.9 -2.9 7.1 -2.9 -7.1 -7.1 -2.9 7.1 -2.9 z" fill="var(--logo-fg)" />
        </svg>
        <div className="brand-text">
          <h1>笺川</h1>
          <p id="subtitle">{snap.subtitle}</p>
        </div>
      </div>
      <div className="topbar-actions">
        <nav className="viewnav" id="viewNav">
          {VIEWS.map((v) => (
            <button
              type="button"
              key={v.id}
              className={'viewnav-btn' + (snap.view === v.id ? ' active' : '')}
              data-view={v.id}
              onClick={() => { if (s.switchView) s.switchView(v.id); }}
            >
              <svg className="ico" aria-hidden="true" focusable="false"><use href={'#i-' + v.ico} /></svg>
              <span className="btn-label">{v.label}</span>
            </button>
          ))}
        </nav>
        <div className="stat" id="stat" hidden={!snap.statVisible}>
          <span id="statCount">{snap.stat}</span>
          <small>条资源</small>
        </div>
        <button className="btn btn-ghost" id="refreshBtn" type="button" title="重新拉取" disabled={busy} onClick={onRefresh}>
          <svg className={'ico' + (busy ? ' spin' : '')} aria-hidden="true" focusable="false"><use href="#i-refresh" /></svg>
          <span className="btn-label">刷新</span>
        </button>
        <button
          className="btn btn-ghost install-trigger" id="installBtn" type="button"
          title="添加到手机" aria-label="添加到手机" hidden={!snap.installReady}
          onClick={() => { if (s.promptInstall) s.promptInstall(); }}
        >
          <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-download" /></svg>
          <span className="btn-label">安装</span>
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
