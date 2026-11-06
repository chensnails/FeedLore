/* 设置弹层「外观」面板（v1.3.0 起 React 化，原 index.html 内联 DOM + app.js 绑定迁移至此）。
 * 行为与旧实现等价且实现更干净：
 * - 选中态不再由旧 applyAppearance 回写 DOM，React 从偏好数据直接推导；
 * - 「GitHub 主题固定主色」不再轮询 <html data-fixed-accent>，由 theme === 'github' 等价推导
 *   （旧 THEME_FIXED_ACCENT 的唯一键就是 github）；
 * - 主题分段控件 / 调板 / 其余分段控件的点击分别走桥的 applyTheme / setAppearance，
 *   外部改动（顶栏主题按钮、恢复默认）经 window.__appearanceChanged 事件回流同步。
 * - 外观偏好只存本机（feedlore.appearance.v2），不随账号跨设备同步。
 * - 控件仍是一行一项（.appr-row），外面按主题 / 界面 / 文章列表 / 正文阅读加了分组标题；
 *   每项的类名、data 属性与 aria 保持原样，样式与测试可以继续按单行定位。 */

import { core } from '@core';
import React, { useEffect, useState } from 'react';
import { PaneFoot } from './primitives.jsx';

const S = () => core;   // 核心逻辑单例（@core，v2.0.0 起改为模块引用）

// 分段控件行：key 为外观偏好键，attr 即旧控件上标值的 data 属性名，options 与旧 HTML 一一对应
const ROWS = {
  theme: {
    key: 'theme', label: '主题', attr: 'data-theme-mode',
    small: '前三套可跟随系统；GitHub 暗黑是整套配色包，主色固定为 GitHub 蓝',
    options: [['auto', '跟随系统'], ['light', '浅色'], ['dark', 'CommaFeed 暗色'], ['github', 'GitHub 暗黑']],
  },
  fontSize: {
    key: 'fontSize', label: '界面字号', attr: 'data-font-size',
    small: '整站等比缩放（含正文）；正文大小可再用下面的「正文字号」微调',
    options: [['s', '小'], ['m', '中'], ['l', '大']],
  },
  density: {
    key: 'density', label: '卡片密度', attr: 'data-density',
    small: '紧凑 = 同屏更多卡片；舒适 = 更大的卡片与留白（默认）',
    options: [['cozy', '舒适'], ['compact', '紧凑']],
  },
  listThumbs: {
    key: 'listThumbs', label: '列表配图', attr: 'data-list-thumbs',
    small: '缩略图 = 右侧显示首图；纯文字 = 连图片都不加载，同屏放下更多标题',
    options: [['on', '缩略图'], ['off', '纯文字']],
  },
  listSummary: {
    key: 'listSummary', label: '文章摘要', attr: 'data-list-summary',
    small: '在标题下补两行摘要（抓取到的描述）；展开文章时不再重复',
    options: [['off', '隐藏'], ['on', '显示']],
  },
  readerFont: {
    key: 'readerFont', label: '正文字体', attr: 'data-reader-font',
    small: '只作用于文章正文，界面字体不变',
    options: [['sans', '无衬线'], ['serif', '衬线']],
  },
  readerLh: {
    key: 'readerLh', label: '正文行高', attr: 'data-reader-lh',
    small: '',
    options: [['s', '紧凑'], ['m', '标准'], ['l', '宽松']],
  },
  readerFs: {
    key: 'readerFs', label: '正文字号', attr: 'data-reader-fs',
    small: '只作用于文章正文，界面字号不受影响',
    options: [['xs', '特小'], ['s', '小'], ['m', '中'], ['l', '大'], ['xl', '特大']],
  },
  readerWidth: {
    key: 'readerWidth', label: '阅读宽度', attr: 'data-reader-width',
    small: '越窄每行字数越少，读起来越省力',
    options: [['s', '窄'], ['m', '标准'], ['l', '宽'], ['full', '全宽']],
  },
};

// 分组：从「主题怎么长」到「列表怎么长」再到「正文怎么读」，后者影响范围更小。
// 主色调属于主题组，单独渲染（色块控件不是分段控件）。
const GROUPS = [
  { title: '主题与配色', accent: true, rows: [ROWS.theme] },
  { title: '界面', rows: [ROWS.fontSize, ROWS.density] },
  { title: '文章列表', rows: [ROWS.listThumbs, ROWS.listSummary] },
  { title: '正文阅读', rows: [ROWS.readerFont, ROWS.readerLh, ROWS.readerFs, ROWS.readerWidth] },
];

// 主色调板：与旧 HTML 的 title / aria-label 一致
const ACCENTS = [
  ['blue', '蓝'], ['violet', '靛紫'], ['teal', '青'],
  ['green', '翠绿'], ['amber', '琥珀'], ['rose', '玫红'],
];

const ACCENT_HINT_DEFAULT = '中性底色只有一套且已校准，这里只换强调色';
const ACCENT_HINT_FIXED = 'GitHub 暗黑是整套配色包，主色固定为 GitHub 蓝，切换主题后即可调整';

// 与 style.css 的 720px 断点保持一致：窄屏下所有阅读宽度档位都大于屏宽，调了也没区别
const NARROW_QUERY = '(max-width: 720px)';

function useNarrowViewport() {
  const [narrow, setNarrow] = useState(() => {
    try { return !!(window.matchMedia && window.matchMedia(NARROW_QUERY).matches); } catch (_) { return false; }
  });
  useEffect(() => {
    let mq = null;
    try { mq = window.matchMedia ? window.matchMedia(NARROW_QUERY) : null; } catch (_) { mq = null; }
    if (!mq) return undefined;
    const onChange = (e) => setNarrow(e.matches);
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', onChange);
      else if (mq.removeListener) mq.removeListener(onChange);
    };
  }, []);
  return narrow;
}

export function AppearancePane() {
  const [pref, setPref] = useState(() => {
    const s = S();
    return (s && s.getAppearance && s.getAppearance()) || null;
  });

  // 外部改动回流：顶栏主题按钮、恢复默认都会触发 applyAppearance，
  // 桥在该函数末尾派发 __appearanceChanged；这里重新读偏好同步选中态
  useEffect(() => {
    const sync = () => {
      const s = S();
      if (s && s.getAppearance) setPref(s.getAppearance());
    };
    sync();
    window.addEventListener('__appearanceChanged', sync);
    return () => window.removeEventListener('__appearanceChanged', sync);
  }, []);

  const narrow = useNarrowViewport();
  if (!pref) return null;

  // GitHub 主题自带主色（旧 THEME_FIXED_ACCENT 唯一键）：整套调板禁用，选中态退还真实主色
  const fixedAccent = pref.theme === 'github';

  const onSeg = (key, value) => {
    const s = S();
    if (key === 'theme') {
      // 主题是全局状态，走桥的 applyTheme（会持久化 + 联动顶栏按钮）
      if (s && s.applyTheme) s.applyTheme(value, true);
    } else if (s && s.setAppearance) {
      s.setAppearance(key, value);
    }
  };

  const onAccent = (value) => {
    if (fixedAccent) return;   // GitHub 主题下连点也不改（与旧逻辑一致）
    const s = S();
    if (s && s.setAppearance) s.setAppearance('accent', value);
  };

  const onReset = () => {
    const s = S();
    if (s && s.resetAppearance) s.resetAppearance();
  };

  const renderRow = (row) => {
    const widthLocked = row.key === 'readerWidth' && narrow;
    const hint = widthLocked ? '窄屏下自动铺满整行，桌面端可调' : row.small;
    return (
      <div className={'appr-row' + (widthLocked ? ' is-locked' : '')} key={row.key}>
        <div className="appr-label">
          {row.label}
          {hint && <small>{hint}</small>}
        </div>
        <div className="appr-ctl">
          <div className="seg" id={row.key === 'theme' ? 'apprTheme' : undefined}>
            {row.options.map(([value, text]) => {
              const on = pref[row.key] === value;
              return (
                <button
                  key={value}
                  className={'seg-btn' + (on ? ' active' : '')}
                  type="button"
                  {...{ [row.attr]: value }}
                  aria-pressed={on ? 'true' : 'false'}
                  disabled={widthLocked}
                  aria-disabled={widthLocked ? 'true' : undefined}
                  onClick={() => onSeg(row.key, value)}
                >
                  {text}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    );
  };

  const accentRow = (
    <div className="appr-row" key="accent">
      <div className="appr-label">
        主色调
        <small>{fixedAccent ? ACCENT_HINT_FIXED : ACCENT_HINT_DEFAULT}</small>
      </div>
      <div className="appr-ctl">
        <div className={'swatches' + (fixedAccent ? ' disabled' : '')} id="apprAccent">
          {ACCENTS.map(([value, title]) => {
            const on = !fixedAccent && pref.accent === value;
            return (
              <button
                key={value}
                className={'swatch' + (on ? ' active' : '')}
                type="button"
                data-accent={value}
                title={title}
                aria-label={title}
                aria-pressed={on ? 'true' : 'false'}
                aria-disabled={fixedAccent ? 'true' : 'false'}
                onClick={() => onAccent(value)}
              />
            );
          })}
        </div>
      </div>
    </div>
  );

  return (
    <div className="tab-pane" data-pane="appearance">
      <div className="pane-scroll">
        <div className="appr">
          {GROUPS.map((group) => (
            <section className="appr-group" key={group.title}>
              <h3 className="appr-group-h">{group.title}</h3>
              {group.rows.map(renderRow)}
              {group.accent ? accentRow : null}
            </section>
          ))}

          {/* 预览：不用切回文章页就能看出字号 / 字体 / 行高的效果 */}
          <div className="appr-preview">
            <p className="appr-preview-h">正文预览</p>
            <p className="appr-preview-t">笺川是一个自托管的 RSS 阅读站。这一段的字体、字号与行高会跟着上面的选择变，不用切回文章页反复试。</p>
          </div>
        </div>
      </div>

      <PaneFoot
        lead={<button className="btn btn-ghost btn-sm" id="apprResetBtn" type="button" onClick={onReset}>恢复默认</button>}
        note="外观只存这台设备（换设备或清缓存后回到默认）；视图 / 排序 / 侧栏宽度等布局按账号保存，换设备登录会跟随账号"
      />
    </div>
  );
}
