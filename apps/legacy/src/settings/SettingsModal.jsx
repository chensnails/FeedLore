/* 设置弹层 React 组件（v1.3.0 起外壳 React 化）。
 *
 * 渐进式迁移策略（与命令面板一致的混合期方案）：
 * - 弹层外壳（遮罩 / 标题 / tab 栏 / 关闭）由 React 渲染；
 * - 全部七个面板均已 React 化（本目录 SourcePane / ModelPane / DigestPane /
 *   AppearancePane / AboutPane / AccountPane / StatusPane，P2d 起账号与状态迁出）；
 * - 旧 #legacyPanes 隐藏容器与 legacy-slot 搬运机制随 P2d 一并退役。
 * - 旧 app.js 的 openSettings/closeSettings 委托给本组件注册的宿主。
 */

import { core } from '@core';
import React, { useEffect, useRef, useState } from 'react';
import { AboutPane } from './AboutPane.jsx';
import { AppearancePane } from './AppearancePane.jsx';
import { ModelPane } from './ModelPane.jsx';
import { DigestPane } from './DigestPane.jsx';
import { SourcePane } from './SourcePane.jsx';
import { WatchPane } from './WatchPane.jsx';
import { AccountPane } from './AccountPane.jsx';
import { StatusPane } from './StatusPane.jsx';

// 扁平导航（不分组）：按使用频率排列，数据源在前
const TABS = [
  ['source', '数据源'],
  ['watch', '规则'],
  ['model', '模型'],
  ['digest', '日报'],
  ['account', '账号'],
  ['appearance', '外观'],
  ['status', '状态'],
  ['about', '关于'],
];
// 管理员专属 tab（与管理端约定一致；模型配置每用户独立，普通用户也能配）
const ADMIN_TABS = ['status'];

const S = () => core;   // 核心逻辑单例（@core，v2.0.0 起改为模块引用）
const isAdminNow = () => !!(S() && S().isAdmin && S().isAdmin());

export function SettingsModal() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('source');
  const [summary, setSummary] = useState('');
  const [admin, setAdmin] = useState(isAdminNow);
  // 移动端（≤820）用「首页列表 → 分区内容」的两级下钻；桌面端忽略这两个状态
  const [isMobile, setIsMobile] = useState(false);
  const [mobilePane, setMobilePane] = useState(false);
  const modalRef = useRef(null);
  const openerRef = useRef(null);
  // 宿主回调是 [] 依赖的闭包，读 state 会读到首次渲染的旧值；Esc / 返回要判断
  // 「现在是不是窄屏、是不是停在分区内容里」，所以镜像一份最新值到 ref。
  const isMobileRef = useRef(false);
  const paneOpenRef = useRef(false);
  const tabRef = useRef(tab);

  useEffect(() => { isMobileRef.current = isMobile; }, [isMobile]);
  useEffect(() => { paneOpenRef.current = mobilePane; }, [mobilePane]);
  useEffect(() => { tabRef.current = tab; }, [tab]);

  // 切分区：移动端同时进入「分区内容」这一层（桌面端忽略 mobilePane）
  function selectTab(name) {
    setTab(name);
    if (!isMobile) return;
    setMobilePane(true);
    // 进分区后原来的 tab 列表已经被隐藏，焦点必须搬进内容层（返回键），
    // 否则焦点会掉回 body，键盘用户直接丢失位置。
    setTimeout(() => {
      const el = modalRef.current && modalRef.current.querySelector('.settings-back');
      if (el) el.focus();
    }, 0);
  }

  // 退回设置列表（移动端）。返回按钮与 Esc 共用：焦点落到刚才所在分区的 tab 上，
  // 键盘用户不至于丢了位置。
  function goHome() {
    setMobilePane(false);
    setTimeout(() => {
      const el = modalRef.current && modalRef.current.querySelector('.tab[data-tab="' + tabRef.current + '"]');
      if (el) el.focus();
    }, 0);
  }

  // 窄屏感知（jsdom 里 matchMedia 恒 false → 走桌面路径，测试不受影响）
  useEffect(() => {
    const mq = window.matchMedia ? window.matchMedia('(max-width: 820px)') : null;
    if (!mq) return undefined;
    const on = () => setIsMobile(!!mq.matches);
    on();
    if (mq.addEventListener) mq.addEventListener('change', on);
    else if (mq.addListener) mq.addListener(on);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', on);
      else if (mq.removeListener) mq.removeListener(on);
    };
  }, []);

  // 宿主注册：旧 app 的 openSettings/closeSettings 委托到这里
  useEffect(() => {
    const host = {
      open(t) {
        const adm = isAdminNow();
        setAdmin(adm);
        let next = t || 'source';
        if (ADMIN_TABS.indexOf(next) >= 0 && !adm) next = 'source';   // 普通用户看不到管理 tab
        setSummary((S() && S().getSettingsSummary && S().getSettingsSummary()) || '');
        setTab(next);
        // 指定了目标分区（深链 / 关于页）就直接进内容；否则移动端先停在首页列表
        setMobilePane(!!t);
        setOpen(true);
      },
      close() { setOpen(false); },
      /** Esc 的第一处理权交回宿主：移动端停在分区内容里时，Esc 应该退回设置列表
       *  （和「返回」按钮一致），只有已经在列表上时 Esc 才整层关闭。
       *  返回 true 表示这一击已被消化，core/ui.js 那边就不再 closeSettings。 */
      escape() {
        if (isMobileRef.current && paneOpenRef.current) { goHome(); return true; }
        return false;
      },
      setSummary,
      setAdminFlag(a) { setAdmin(!!a); },
    };
    window.__settingsHost = host;
    return () => { delete window.__settingsHost; };
  }, []);

  // 开合状态同步给旧代码（Escape 关闭 / 自动刷新的判据）
  useEffect(() => {
    window.__settingsOpen = open;
    return () => { window.__settingsOpen = false; };
  }, [open]);

  // 打开时锁背景滚动（计数式，与图片灯箱共存的旧约定兼容），关闭时解锁
  useEffect(() => {
    const s = S();
    if (!open) return;
    if (s && s.lockPageScroll) s.lockPageScroll();
    return () => { if (s && s.unlockPageScroll) s.unlockPageScroll(); };
  }, [open]);

  // 焦点：打开时记住来源、把焦点送进弹层；关闭时还给来源（此前两头都不管，
  // 键盘用户关掉设置后焦点会丢到 body，得从头 Tab）。
  useEffect(() => {
    if (open) {
      openerRef.current = document.activeElement;
      const t = setTimeout(() => {
        const el = modalRef.current && modalRef.current.querySelector('.modal-close');
        if (el) el.focus();
      }, 0);
      return () => clearTimeout(t);
    }
    const back = openerRef.current;
    openerRef.current = null;
    if (back && back.focus && document.contains(back)) back.focus();
    return undefined;
  }, [open]);

  // 焦点陷阱：Tab / Shift+Tab 在弹层内循环，不会跑到背后的页面上
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (ev) => {
      if (ev.key !== 'Tab') return;
      const root = modalRef.current;
      if (!root) return;
      const nodes = root.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      const list = Array.prototype.filter.call(nodes, (el) => !el.disabled && el.offsetParent !== null);
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (ev.shiftKey && (document.activeElement === first || document.activeElement === root)) {
        ev.preventDefault(); last.focus();
      } else if (!ev.shiftKey && document.activeElement === last) {
        ev.preventDefault(); first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const close = () => setOpen(false);
  const onMaskClick = (ev) => { if (ev.target === ev.currentTarget) close(); };

  const tabs = TABS.filter(([name]) => !(ADMIN_TABS.indexOf(name) >= 0 && !admin));

  // tablist 的键盘约定：↑↓（竖排）或 ←→ 移动并选中，Home/End 跳首尾；
  // 焦点跟着走，避免「按了方向键但焦点还在原处」。
  const onTabsKey = (ev) => {
    const k = ev.key;
    if (k !== 'ArrowDown' && k !== 'ArrowUp' && k !== 'ArrowLeft' && k !== 'ArrowRight' && k !== 'Home' && k !== 'End') return;
    const names = tabs.map(([n]) => n);
    const i = names.indexOf(tab);
    if (i < 0) return;
    let next = i;
    if (k === 'ArrowDown' || k === 'ArrowRight') next = (i + 1) % names.length;
    else if (k === 'ArrowUp' || k === 'ArrowLeft') next = (i - 1 + names.length) % names.length;
    else if (k === 'Home') next = 0;
    else next = names.length - 1;
    ev.preventDefault();
    // 桌面端方向键直接切分区（自动激活，符合 tablist 习惯）；移动端只用方向键
    // 移动焦点、回车才进分区 —— 否则第一次按方向键就把列表换成了内容层，
    // 列表消失、焦点无处可落。
    if (!isMobile) selectTab(names[next]);
    const el = modalRef.current && modalRef.current.querySelector('.tab[data-tab="' + names[next] + '"]');
    if (el) el.focus();
  };

  return (
    <div className="modal-mask" hidden={!open} onClick={onMaskClick}>
      <div className={'modal settings-modal' + (isMobile ? (mobilePane ? ' mobile-pane' : ' mobile-home') : '')}
        role="dialog" aria-modal="true" aria-labelledby="settingsTitle" ref={modalRef} tabIndex={-1}>
        <div className="modal-head">
          <div className="modal-head-lead">
            {isMobile && mobilePane ? (
              <button className="settings-back" type="button" aria-label="返回设置列表" onClick={goHome}>
                <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-chevron-right" /></svg>
              </button>
            ) : null}
            <div className="modal-head-txt">
              <h2 id="settingsTitle">设置</h2>
              <p className="modal-sub" id="settingsSummary">{summary || '加载中…'}</p>
            </div>
          </div>
          <button className="modal-close" id="settingsClose" type="button" aria-label="关闭" onClick={close}>
            <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-x" /></svg>
          </button>
        </div>

        <div className="tabs" id="tabs" role="tablist" aria-label="设置分区" aria-orientation="vertical" onKeyDown={onTabsKey}>
          {tabs.map(([name, label]) => (
            <button
              key={name}
              type="button"
              role="tab"
              id={'settingsTab-' + name}
              className={'tab' + (tab === name ? ' active' : '')}
              data-tab={name}
              aria-selected={tab === name ? 'true' : 'false'}
              aria-controls="settingsPanel"
              tabIndex={tab === name ? 0 : -1}
              onClick={() => selectTab(name)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="modal-body" id="settingsPanel" role="tabpanel" aria-labelledby={'settingsTab-' + tab}>
          {tab === 'source' && open && <SourcePane admin={admin} />}
          {tab === 'watch' && open && <WatchPane />}
          {tab === 'appearance' && open && <AppearancePane />}
          {tab === 'model' && open && <ModelPane />}
          {tab === 'digest' && open && <DigestPane />}
          {tab === 'account' && open && <AccountPane />}
          {tab === 'status' && open && <StatusPane />}
          {tab === 'about' && open && <AboutPane />}
        </div>
      </div>
    </div>
  );
}
