/* 设置弹层「帮助」面板（v1.1.7 新增，位于「关于」之前）。
 * 集中呈现基础操作指南，帮助用户快速上手各功能模块。
 * （v1.1.8 起移除键盘快捷键说明——列表键盘导航 j/k/o/f/r 已不再提供。） */

import React from 'react';

const TOPICS = [
  { h: '添加订阅源', p: '设置 → 数据源，粘贴 RSS / Atom 地址即可采集；可建立分组归类。' },
  { h: '采集与刷新', p: '顶栏「刷新」立即去抓取一轮；采集间隔等参数在 设置 → 状态（管理员）调整。' },
  { h: '阅读', p: '文章页点标题展开全文；可在左侧切换「全部 / 未读 / 收藏」范围，点击频道切换分组。' },
  { h: '卡片墙', p: '卡片页以网格 / 列表展示资源，可按频道、标签筛选并排序；点标签可跳转到该标签下内容。' },
  { h: '每日日报', p: 'AI → 日报 查看每日摘要；管理员可在 设置 → 状态 → 日报设置 配置范围与条目数量。' },
  { h: '主题与外观', p: '顶栏主题按钮在 跟随系统 / 浅色 / CommaFeed 暗色 / GitHub 暗黑 间切换；字号、阅读字体、行高、宽度在 设置 → 外观 调整。' },
  { h: '命令面板', p: '⌘K / Ctrl K 快速切换视图、搜索、执行操作，无需鼠标。' },
  { h: '移动端手势', p: '阅读页从屏幕左 2/3 区域向右滑拉出频道抽屉，向左滑收起。' },
  { h: '安装到手机', p: '支持 PWA，浏览器「添加到主屏幕」后可作为独立 App 使用，数据多端同步。' },
];

export function HelpPane() {
  return (
    <div className="help-body pane-scroll">
      <section className="help-sec">
        <h4 className="help-sec-h">基础操作指南</h4>
        <ul className="help-list">
          {TOPICS.map((t) => (
            <li key={t.h} className="help-item">
              <span className="help-item-h">{t.h}</span>
              <span className="help-item-p">{t.p}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
