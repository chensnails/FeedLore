/* 设置弹层「外观」面板（v1.3.0 起 React 化，原 index.html 内联 DOM + app.js 绑定迁移至此）。
 * 行为与旧实现等价且实现更干净：
 * - 选中态不再由旧 applyAppearance 回写 DOM，React 从偏好数据直接推导；
 * - 「GitHub 主题固定主色」不再轮询 <html data-fixed-accent>，由 theme === 'github' 等价推导
 *   （旧 THEME_FIXED_ACCENT 的唯一键就是 github）；
 * - 主题分段控件 / 调板 / 其余分段控件的点击分别走桥的 applyTheme / setAppearance，
 *   外部改动（顶栏主题按钮、恢复默认、迁移）经 window.__appearanceChanged 事件回流同步。
 * 类名 / data 属性 / aria 与旧 DOM 完全一致，样式零改动。 */

import { core } from '@core';
import React, { useEffect, useState } from 'react';

const S = () => core;   // 核心逻辑单例（@core，v2.0.0 起改为模块引用）

// 分段控件行：key 为外观偏好键，attr 即旧控件上标值的 data 属性名，options 与旧 HTML 一一对应
const SEG_ROWS = [
  {
    key: 'theme', label: '主题', attr: 'data-theme-mode',
    small: '前三套可跟随系统；GitHub 暗黑是整套配色包，主色固定为 GitHub 蓝',
    options: [['auto', '跟随系统'], ['light', '浅色'], ['dark', 'CommaFeed 暗色'], ['github', 'GitHub 暗黑']],
  },
  {
    key: 'fontSize', label: '字号', attr: 'data-font-size',
    small: '整站等比缩放，按钮、列表、设置一起变',
    options: [['s', '小'], ['m', '中'], ['l', '大']],
  },
  {
    key: 'density', label: '卡片密度', attr: 'data-density',
    small: '紧凑 = 同屏更多卡片；舒适 = 更大的卡片与留白（默认）',
    options: [['cozy', '舒适'], ['compact', '紧凑']],
  },
  {
    key: 'readerFont', label: '正文字体', attr: 'data-reader-font',
    small: '只作用于文章正文，界面字体不变',
    options: [['sans', '无衬线'], ['serif', '衬线']],
  },
  {
    key: 'readerLh', label: '正文行高', attr: 'data-reader-lh',
    small: '',
    options: [['s', '紧凑'], ['m', '标准'], ['l', '宽松']],
  },
  {
    key: 'readerFs', label: '正文字号', attr: 'data-reader-fs',
    small: '只作用于文章正文，界面字号不受影响',
    options: [['s', '小'], ['m', '中'], ['l', '大']],
  },
  {
    key: 'readerWidth', label: '阅读宽度', attr: 'data-reader-width',
    small: '越窄每行字数越少，读起来越省力',
    options: [['s', '窄'], ['m', '标准'], ['l', '宽'], ['full', '全宽']],
  },
];

// 主色调板：与旧 HTML 的 title / aria-label 一致
const ACCENTS = [
  ['blue', '蓝'], ['violet', '靛紫'], ['teal', '青'],
  ['green', '翠绿'], ['amber', '琥珀'], ['rose', '玫红'],
];

const ACCENT_HINT_DEFAULT = '中性底色只有一套且已校准，这里只换强调色';
const ACCENT_HINT_FIXED = 'GitHub 暗黑是整套配色包，主色固定为 GitHub 蓝，切换主题后即可调整';

export function AppearancePane() {
  const [pref, setPref] = useState(() => {
    const s = S();
    return (s && s.getAppearance && s.getAppearance()) || null;
  });

  // 外部改动回流：顶栏主题按钮、恢复默认、localStorage 一次性迁移都会触发 applyAppearance，
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

  return (
    <div className="tab-pane" data-pane="appearance">
      <div className="pane-scroll">
        <div className="appr">
          {SEG_ROWS.map((row) => (
            <div className="appr-row" key={row.key}>
              <div className="appr-label">
                {row.label}
                {row.small && <small>{row.small}</small>}
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
                        onClick={() => onSeg(row.key, value)}
                      >
                        {text}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          ))}

          <div className="appr-row">
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

          {/* 预览：不用切回文章页就能看出字号 / 字体 / 行高的效果 */}
          <div className="appr-preview">
            <p className="appr-preview-h">正文预览</p>
            <p className="appr-preview-t">笺川是一个自托管的 RSS 阅读站。这一段的字体、字号与行高会跟着上面的选择变，不用切回文章页反复试。</p>
          </div>
        </div>
      </div>

      <div className="pane-foot">
        <button className="btn btn-ghost btn-sm" id="apprResetBtn" type="button" onClick={onReset}>恢复默认</button>
        <span className="pane-foot-note">外观已存入你的账号，换设备也一致</span>
      </div>
    </div>
  );
}
