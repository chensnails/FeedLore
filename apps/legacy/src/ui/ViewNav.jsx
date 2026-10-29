/* 常驻视图导航（P0 #1，v1.7.0-test1）：把「文章 / 卡片 / 日报」三视图切换从 ⋮ 溢出菜单
 * 提升为各视图顶栏右簇的常驻分段导航，与 App Shell 原来的 #viewNav 共用同一套
 * .viewnav / .viewnav-btn 结构与 .seg 同族样式（窄屏规则也已由守门测试约束）。
 *
 * 之前视图切换埋在溢出菜单里（二级操作），对三视图产品的核心导航而言层级太深；
 * 现在三视图各自顶栏右簇都有常驻入口，点哪切哪，当前视图用 --accent-soft 打底高亮。 */
import React, { useEffect, useState } from 'react';
import { core } from '@core';

const VIEWS = [
  { id: 'reader', label: '文章', ico: 'inbox' },
  { id: 'cards', label: '卡片', ico: 'grid' },
  { id: 'ai', label: '日报', ico: 'sparkle' },
];

function readShell() {
  try { return core.getShell(); } catch (_) { return {}; }
}

export function ViewNav() {
  const [view, setView] = useState(() => (core.state && core.state.tab) || 'reader');

  useEffect(() => {
    const onTick = () => setView((core.state && core.state.tab) || 'reader');
    window.addEventListener('__viewChanged', onTick);
    window.addEventListener('__shellTick', onTick);
    return () => {
      window.removeEventListener('__viewChanged', onTick);
      window.removeEventListener('__shellTick', onTick);
    };
  }, []);

  const snap = readShell();
  const views = snap.digestVisible === false ? VIEWS.filter((v) => v.id !== 'ai') : VIEWS;

  return (
    <nav className="viewnav" role="navigation" aria-label="视图切换">
      {views.map((v) => {
        const active = view === v.id;
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
            onClick={() => core.switchView(v.id)}
          >
            <svg className="ico" aria-hidden="true" focusable="false"><use href={'#i-' + v.ico} /></svg>
            <span className="btn-label" aria-hidden="true">{v.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
