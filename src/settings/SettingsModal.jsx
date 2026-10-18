/* 设置弹层 React 组件（v1.3.0 起外壳 React 化）。
 *
 * 渐进式迁移策略（与命令面板一致的混合期方案）：
 * - 弹层外壳（遮罩 / 标题 / tab 栏 / 关闭）由 React 渲染；
 * - 全部六个面板均已 React 化（本目录 SourcePane / ModelPane / AppearancePane /
 *   AboutPane / AccountPane / StatusPane，P2d 起账号与状态迁出）；
 * - 旧 #legacyPanes 隐藏容器与 legacy-slot 搬运机制随 P2d 一并退役。
 * - 旧 app.js 的 openSettings/closeSettings 委托给本组件注册的宿主。
 */

import { core } from '@core';
import React, { useEffect, useState } from 'react';
import { AboutPane } from './AboutPane.jsx';
import { AppearancePane } from './AppearancePane.jsx';
import { ModelPane } from './ModelPane.jsx';
import { SourcePane } from './SourcePane.jsx';
import { AccountPane } from './AccountPane.jsx';
import { StatusPane } from './StatusPane.jsx';

const TABS = [
  ['source', '数据源'],
  ['model', '模型'],
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
        setOpen(true);
      },
      close() { setOpen(false); },
      setSummary,
      setAdminFlag(a) { setAdmin(!!a); },
    };
    window.__settingsHost = host;
    return () => { delete window.__settingsHost; };
  }, []);

  // 开合状态同步给旧代码（Escape 关闭 / j/k 键盘导航 / 自动刷新的判据）
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

  const close = () => setOpen(false);
  const onMaskClick = (ev) => { if (ev.target === ev.currentTarget) close(); };

  const tabs = TABS.filter(([name]) => !(ADMIN_TABS.indexOf(name) >= 0 && !admin));

  return (
    <div className="modal-mask" hidden={!open} onClick={onMaskClick}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="settingsTitle">
        <div className="modal-head">
          <div>
            <h2 id="settingsTitle">设置</h2>
            <p className="modal-sub" id="settingsSummary">{summary || '加载中…'}</p>
          </div>
          <button className="modal-close" id="settingsClose" type="button" aria-label="关闭" onClick={close}>
            <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-x" /></svg>
          </button>
        </div>

        <div className="tabs" id="tabs">
          {tabs.map(([name, label]) => (
            <button
              key={name}
              type="button"
              className={'tab' + (tab === name ? ' active' : '')}
              data-tab={name}
              aria-pressed={tab === name ? 'true' : 'false'}
              onClick={() => setTab(name)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="modal-body">
          {tab === 'source' && open && <SourcePane admin={admin} />}
          {tab === 'appearance' && open && <AppearancePane />}
          {tab === 'model' && open && <ModelPane />}
          {tab === 'account' && open && <AccountPane />}
          {tab === 'status' && open && <StatusPane />}
          {tab === 'about' && open && <AboutPane />}
        </div>
      </div>
    </div>
  );
}
