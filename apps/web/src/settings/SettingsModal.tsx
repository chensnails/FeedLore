/* 设置弹层 React 组件。
 *
 * 渐进式迁移策略（与命令面板一致的混合期方案）：
 * - 弹层外壳（遮罩 / 标题 / tab 栏 / 关闭）由 React 渲染；
 * - 全部七个面板均已 React 化（本目录 SourcePane / ModelPane / DigestPane /
 *   AppearancePane / AboutPane / AccountPane / StatusPane，P2d 起账号与状态迁出）；
 * - 旧 #legacyPanes 隐藏容器与 legacy-slot 搬运机制随 P2d 一并退役。
 * - 旧 app.js 的 openSettings/closeSettings 委托给本组件注册的宿主。
 */

import { core } from '@core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { get, provide, revoke } from '../kernel/bridge.ts';
import { clearAutofilledInput, NO_AUTOFILL_PROPS, useNoAutofillName } from '../ui/noAutofill.ts';
import { AboutPane } from './AboutPane.tsx';
import { AccountPane } from './AccountPane.tsx';
import { AppearancePane } from './AppearancePane.tsx';
import { DigestPane } from './DigestPane.tsx';
import { McpPane } from './McpPane.tsx';
import { ModelPane } from './ModelPane.tsx';
import { SourcePane } from './SourcePane.tsx';
import { StatusPane } from './StatusPane.tsx';
import {
  ADMIN_TABS,
  matchTabs,
  READONLY_TABS,
  TAB_BY_NAME,
  TAB_GROUPS,
  visibleTabs,
} from './tabs.ts';
import { WatchPane } from './WatchPane.tsx';

const S = () => core; // 核心逻辑单例（@core，v2.0.0 起改为模块引用）
const isAdminNow = () => !!(S() && S().isAdmin && S().isAdmin());
const isReadonlyNow = () => !!(S() && S().isReadonly && S().isReadonly());

export function SettingsModal() {
  const [open, setOpen] = useState<any>(false);
  const [tab, setTab] = useState<any>('source');
  const [summary, setSummary] = useState<any>('');
  const [query, setQuery] = useState<any>('');
  // 当前面板是否有未保存的改动：面板通过 onDirtyChange 上报，切换 / 关闭前据此拦截
  const [dirty, setDirty] = useState<any>(false);
  const [admin, setAdmin] = useState<any>(isAdminNow);
  const [role, setRole] = useState<any>(() => (S().state && S().state.role) || '');
  // 移动端（≤820）用「首页列表 → 分区内容」的两级下钻；桌面端忽略这两个状态
  const [isMobile, setIsMobile] = useState<any>(false);
  const [mobilePane, setMobilePane] = useState<any>(false);
  const modalRef: any = useRef<any>(null);
  const openerRef: any = useRef<any>(null);
  // 搜索框绝不能带登录语义：Chrome Android 会把保存的账号启发式填进来。
  const searchName = useNoAutofillName('settings-q');
  // 宿主回调是 [] 依赖的闭包，读 state 会读到首次渲染的旧值；Esc / 返回要判断
  // 「现在是不是窄屏、是不是停在分区内容里」，所以镜像一份最新值到 ref。
  const isMobileRef: any = useRef(false);
  const paneOpenRef: any = useRef(false);
  const tabRef: any = useRef(tab);
  const dirtyRef: any = useRef(false);
  // 确认框开着时忽略第二次切换/关闭，避免叠出两个「放弃更改」
  const guardingRef: any = useRef(false);

  useEffect(() => {
    isMobileRef.current = isMobile;
  }, [isMobile]);
  useEffect(() => {
    paneOpenRef.current = mobilePane;
  }, [mobilePane]);
  useEffect(() => {
    tabRef.current = tab;
  }, [tab]);

  // 面板上报脏状态时同步写 ref：仅靠 effect 镜像会晚一个被动副作用周期，
  // 用户在刚改完就立刻切分区时可能漏拦。
  const reportDirty = useCallback(
    /** @param {*} [v] */ (v: any) => {
      dirtyRef.current = !!v;
      setDirty(!!v);
    },
    [],
  );

  /** 有未保存改动时先确认；返回 true 表示可以继续（无改动或用户选择放弃）。 */
  async function askDiscard() {
    if (!dirtyRef.current) return true;
    if (guardingRef.current) return false;
    guardingRef.current = true;
    try {
      const ok = await S().confirm({
        title: '放弃未保存的更改？',
        desc: '切换或关闭设置后，这些修改会丢失。',
        confirmText: '放弃更改',
        cancelText: '继续编辑',
        danger: true,
      });
      if (ok) {
        dirtyRef.current = false;
        setDirty(false);
      }
      return !!ok;
    } finally {
      guardingRef.current = false;
    }
  }

  // 切分区：移动端同时进入「分区内容」这一层（桌面端忽略 mobilePane）
  /**
   * @param {*} [name]
   */
  async function selectTab(name: any) {
    // 移动端在首页点当前分区只是进入内容层，草稿还在，不该弹「放弃更改」
    if (name === tabRef.current) {
      if (!isMobile || paneOpenRef.current) return;
      setMobilePane(true);
      setTimeout(() => {
        const el = modalRef.current && modalRef.current.querySelector('.settings-back');
        if (el) el.focus();
      }, 0);
      return;
    }
    if (!(await askDiscard())) return;
    tabRef.current = name; // 立即生效，别等被动副作用，否则连点两下会误判成「点当前分区」
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
      const el =
        modalRef.current &&
        modalRef.current.querySelector('.tab[data-tab="' + tabRef.current + '"]');
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
      /**
       * @param {*} [t]
       */
      open(t: any) {
        const adm = isAdminNow();
        const ro = isReadonlyNow();
        setAdmin(adm);
        setRole((S().state && S().state.role) || '');
        let next = t || (ro ? 'appearance' : 'source');
        // 角色没有权限进入的分区一律回落到该角色可见的默认页
        if (ADMIN_TABS.indexOf(next) >= 0 && !adm) next = ro ? 'appearance' : 'source';
        if (ro && READONLY_TABS.indexOf(next) < 0) next = 'appearance';
        setSummary((S() && S().getSettingsSummary && S().getSettingsSummary()) || '');
        tabRef.current = next;
        setTab(next);
        setQuery('');
        setDirty(false);
        dirtyRef.current = false;
        // 指定了目标分区（深链 / 关于页）就直接进内容；否则移动端先停在首页列表
        setMobilePane(!!t);
        setOpen(true);
      },
      close() {
        requestClose();
      },
      /** Esc 的第一处理权交回宿主：移动端停在分区内容里时，Esc 应该退回设置列表
       *  （和「返回」按钮一致），只有已经在列表上时 Esc 才整层关闭。
       *  返回 true 表示这一击已被消化，core/ui.ts 那边就不再 closeSettings。 */
      escape() {
        if (isMobileRef.current && paneOpenRef.current) {
          goHome();
          return true;
        }
        return false;
      },
      setSummary,
      /**
       * @param {*} [a]
       */
      setAdminFlag(a: any) {
        setAdmin(!!a);
      },
      /**
       * @param {*} [r]
       */
      setRoleFlag(r: any) {
        setRole(r || '');
      },
    };
    provide('settingsHost', host);
    // 按需挂载：入口在 chunk 下载前就记下了这次要打开的分区，宿主注册后补开一次。
    // 只消费一次（StrictMode 会重复跑 effect，开启状态在重复挂载之间保留）。
    const pending = get('settingsPending');
    if (pending) {
      revoke('settingsPending');
      host.open(pending.tab);
    }
    return () => {
      revoke('settingsHost');
    };
  }, []);

  // 开合状态同步给旧代码（Escape 关闭 / 自动刷新的判据）
  useEffect(() => {
    provide('settingsOpen', open);
    return () => {
      revoke('settingsOpen');
    };
  }, [open]);

  // 打开时锁背景滚动（计数式，与图片灯箱共存的旧约定兼容），关闭时解锁
  useEffect(() => {
    const s = S();
    if (!open) return;
    if (s && s.lockPageScroll) s.lockPageScroll();
    return () => {
      if (s && s.unlockPageScroll) s.unlockPageScroll();
    };
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
    /**
     * @param {*} [ev]
     */
    const onKey = (ev: any) => {
      if (ev.key !== 'Tab') return;
      const root = modalRef.current;
      if (!root) return;
      const nodes = root.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      // roving tabIndex 的非激活页签不该进 Tab 序：它们是 button，会被上面的选择器命中，
      // 但按一次 Tab 要穿过 8 个「不可激活」的页签才到内容区。
      const list = Array.prototype.filter.call(
        nodes,
        /** @param {*} [el] */ (el: any) =>
          !el.disabled && el.offsetParent !== null && el.getAttribute('tabindex') !== '-1',
      );
      if (!list.length) return;
      const first = list[0] as any;
      const last = list[list.length - 1] as any;
      if (ev.shiftKey && (document.activeElement === first || document.activeElement === root)) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && document.activeElement === last) {
        ev.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const requestClose = async () => {
    if (!(await askDiscard())) return false;
    setOpen(false);
    return true;
  };
  /**
   * @param {*} [ev]
   */
  const onMaskClick = (ev: any) => {
    if (ev.target === ev.currentTarget) requestClose();
  };

  // 手机上是贴底整屏弹层，出口只有 × / Esc（下滑关闭 v2.5.3 下线：真机会闪屏）。
  // 系统返回键栈已随 V5 移除；移动端两级返回的等价路径由 Esc 的 host.escape() → goHome() 承接。
  const attachModal = useCallback(
    /** @param {*} [el] */ (el: any) => {
      modalRef.current = el;
    },
    [],
  );

  // 浏览器可能在弹层打开之后又填一次：state 说空、DOM 却有值，直接纠偏。
  // 全局哨兵（main.tsx → installAutofillGuard）负责填充发生当刻，这里兜「打开时已填好」。
  useEffect(() => {
    if (!open || query) return;
    const el = modalRef.current && modalRef.current.querySelector('#settingsSearch');
    if (el && el.value) clearAutofilledInput(el);
  }, [open, query]);

  const readonly = role === 'readonly';
  const tabs = visibleTabs(admin, readonly);
  const matched = matchTabs(tabs, query);
  const matchedNames = matched.map(/** @param {*} [t] */ (t: any) => t.name);
  const activeTab = TAB_BY_NAME[tab];
  const activeVisible = matchedNames.indexOf(tab) >= 0;
  // 搜索把当前分区过滤掉时，把 tablist 的 roving tabIndex 落到第一个可见项
  const focusTab = activeVisible ? tab : matchedNames[0];
  const navGroups = TAB_GROUPS.map(
    /** @param {*} [group] */ (group: any) => ({
      group,
      items: matched.filter(/** @param {*} [t] */ (t: any) => t.group === group),
    }),
  ).filter(/** @param {*} [g] */ (g: any) => g.items.length);

  // 角色在弹层打开期间被改成只读（或反过来）时，把停在不允许分区上的用户带回可见页
  useEffect(() => {
    if (readonly && READONLY_TABS.indexOf(tab) < 0) {
      tabRef.current = 'appearance';
      setTab('appearance');
    }
  }, [readonly, tab]);

  // tablist 的键盘约定：↑↓（竖排）或 ←→ 移动并选中，Home/End 跳首尾；
  // 焦点跟着走，避免「按了方向键但焦点还在原处」。
  /**
   * @param {*} [ev]
   */
  const onTabsKey = (ev: any) => {
    const k = ev.key;
    if (
      k !== 'ArrowDown' &&
      k !== 'ArrowUp' &&
      k !== 'ArrowLeft' &&
      k !== 'ArrowRight' &&
      k !== 'Home' &&
      k !== 'End'
    )
      return;
    const names = matchedNames;
    if (!names.length) return;
    const i = names.indexOf(tab);
    let next = i;
    if (i < 0) next = 0;
    else if (k === 'ArrowDown' || k === 'ArrowRight') next = (i + 1) % names.length;
    else if (k === 'ArrowUp' || k === 'ArrowLeft') next = (i - 1 + names.length) % names.length;
    else if (k === 'Home') next = 0;
    else next = names.length - 1;
    ev.preventDefault();
    // 桌面端方向键直接切分区（自动激活，符合 tablist 习惯）；移动端只用方向键
    // 移动焦点、回车才进分区 —— 否则第一次按方向键就把列表换成了内容层，
    // 列表消失、焦点无处可落。
    if (!isMobile) selectTab(names[next]);
    const el =
      modalRef.current && modalRef.current.querySelector('.tab[data-tab="' + names[next] + '"]');
    if (el) el.focus();
  };

  return (
    <div className="modal-mask" hidden={!open} onClick={onMaskClick}>
      <div
        className={
          'modal settings-modal' + (isMobile ? (mobilePane ? ' mobile-pane' : ' mobile-home') : '')
        }
        role="dialog"
        aria-modal="true"
        aria-labelledby="settingsTitle"
        ref={attachModal}
        tabIndex={-1}
      >
        <div className="modal-head">
          <div className="modal-head-lead">
            {isMobile && mobilePane ? (
              <button
                className="settings-back"
                type="button"
                aria-label="返回设置列表"
                onClick={goHome}
              >
                <svg className="ico" aria-hidden="true" focusable="false">
                  <use href="#i-chevron-right" />
                </svg>
              </button>
            ) : null}
            <div className="modal-head-txt">
              <h2 id="settingsTitle">
                {isMobile && mobilePane && activeTab ? activeTab.label : '设置'}
              </h2>
              <p className="modal-sub" id="settingsSummary">
                {isMobile && mobilePane && activeTab ? activeTab.desc : summary || '加载中…'}
              </p>
              {dirty ? (
                <span className="settings-dirty" role="status">
                  未保存
                </span>
              ) : null}
            </div>
          </div>
          <button
            className="modal-close"
            id="settingsClose"
            type="button"
            aria-label="关闭"
            onClick={requestClose}
          >
            <svg className="ico" aria-hidden="true" focusable="false">
              <use href="#i-x" />
            </svg>
          </button>
        </div>

        <div className="settings-nav">
          <div className="settings-search">
            <svg className="ico" aria-hidden="true" focusable="false">
              <use href="#i-search" />
            </svg>
            <input
              id="settingsSearch"
              type="search"
              name={searchName}
              value={query}
              placeholder="搜索设置"
              aria-label="搜索设置分区"
              onChange={/** @param {*} [ev] */ (ev: any) => setQuery(ev.target.value)}
              {...NO_AUTOFILL_PROPS}
            />
            {query ? (
              <button
                className="settings-search-clear"
                type="button"
                aria-label="清除搜索"
                onClick={() => setQuery('')}
              >
                <svg className="ico" aria-hidden="true" focusable="false">
                  <use href="#i-x" />
                </svg>
              </button>
            ) : null}
          </div>
          {query && !activeVisible && matched.length ? (
            <p className="settings-search-miss hint">
              当前「{activeTab ? activeTab.label : ''}」不在搜索结果中，点上方结果切换
            </p>
          ) : null}
          <div
            className="tabs"
            id="tabs"
            role="tablist"
            aria-label="设置分区"
            aria-orientation="vertical"
            onKeyDown={onTabsKey}
          >
            {navGroups.map(
              /** @param {*} opts */ ({ group, items }) => (
                <div className="tab-group" key={group} role="presentation">
                  <div className="tab-group-label" aria-hidden="true">
                    {group}
                  </div>
                  {items.map(
                    /** @param {*} [t] */ (t: any) => (
                      <button
                        key={t.name}
                        type="button"
                        role="tab"
                        id={'settingsTab-' + t.name}
                        className={'tab' + (tab === t.name ? ' active' : '')}
                        data-tab={t.name}
                        aria-selected={tab === t.name ? 'true' : 'false'}
                        aria-controls="settingsPanel"
                        tabIndex={focusTab === t.name ? 0 : -1}
                        title={dirty && tab === t.name ? '有未保存的更改' : undefined}
                        onClick={() => selectTab(t.name)}
                      >
                        <svg className="tab-ico ico" aria-hidden="true" focusable="false">
                          <use href={'#i-' + t.icon} />
                        </svg>
                        <span className="tab-label">{t.label}</span>
                        {isMobile ? <span className="tab-desc">{t.desc}</span> : null}
                        {dirty && tab === t.name ? (
                          <span className="tab-dirty" aria-hidden="true" />
                        ) : null}
                      </button>
                    ),
                  )}
                </div>
              ),
            )}
            {!matched.length ? <div className="settings-empty">没有匹配的设置</div> : null}
          </div>
        </div>

        <div
          className="modal-body"
          id="settingsPanel"
          role="tabpanel"
          aria-labelledby={activeVisible ? 'settingsTab-' + tab : undefined}
          aria-label={activeVisible ? undefined : activeTab ? activeTab.label + '设置' : '设置'}
        >
          {tab === 'source' && open && !readonly && (
            <SourcePane admin={admin} onDirtyChange={reportDirty} />
          )}
          {tab === 'watch' && open && !readonly && <WatchPane onDirtyChange={reportDirty} />}
          {tab === 'appearance' && open && <AppearancePane />}
          {tab === 'model' && open && !readonly && <ModelPane onDirtyChange={reportDirty} />}
          {tab === 'digest' && open && !readonly && <DigestPane onDirtyChange={reportDirty} />}
          {tab === 'account' && open && <AccountPane onDirtyChange={reportDirty} />}
          {tab === 'mcp' && open && !readonly && <McpPane />}
          {tab === 'status' && open && <StatusPane />}
          {tab === 'about' && open && <AboutPane />}
        </div>
      </div>
    </div>
  );
}
