/* 设置弹层「帮助」面板（v1.1.7 新增，位于「关于」之前）。
 * 将原先散落在 `?` 浮层的快捷键说明集中、补充完整，并加入基础操作指南。
 * 快捷键表格复用 Overlays 的 .shortcuts-* 样式，保证两处视觉一致。 */

import React from 'react';

/* 完整快捷键说明（从 Overlays 的 SHORTCUTS 迁来并扩充） */
const SHORTCUTS = [
  {
    title: '通用',
    items: [
      { keys: ['⌘K', 'Ctrl K'], desc: '打开命令面板' },
      { keys: ['/'], desc: '聚焦搜索框（文章 / 卡片页）' },
      { keys: ['?'], desc: '打开设置 → 帮助' },
      { keys: ['Esc'], desc: '关闭弹层 / 灯箱 / 本帮助' },
    ],
  },
  {
    title: '浏览列表（文章 / 卡片）',
    items: [
      { keys: ['j'], desc: '下一条' },
      { keys: ['k'], desc: '上一条' },
      { keys: ['o', 'Enter'], desc: '打开当前条目' },
      { keys: ['f'], desc: '收藏 / 取消收藏' },
      { keys: ['r'], desc: '标记已读' },
    ],
  },
  {
    title: '阅读页分组 / 频道',
    items: [
      { keys: ['点击频道'], desc: '切换频道、范围（全部 / 未读 / 收藏）' },
      { keys: ['单篇 / 多篇'], desc: '切换手风琴：同时展开多篇，或展开一篇自动收起上一篇' },
      { keys: ['全部已读'], desc: '把当前列表全部标为已读' },
      { keys: ['全部收起'], desc: '收起所有已展开的文章' },
    ],
  },
];

const TOPICS = [
  { h: '添加订阅源', p: '设置 → 数据源，粘贴 RSS / Atom 地址即可采集；可建立分组归类。' },
  { h: '采集与刷新', p: '顶栏「刷新」立即去抓取一轮；采集间隔等参数在 设置 → 状态（管理员）调整。' },
  { h: '阅读', p: '文章页点标题展开全文；j / k 上下切换条目；可在左侧切换「全部 / 未读 / 收藏」范围。' },
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
        <h4 className="help-sec-h">键盘快捷键</h4>
        <div className="shortcuts-body help-shortcuts">
          {SHORTCUTS.map((g) => (
            <div className="shortcuts-group" key={g.title}>
              <h4>{g.title}</h4>
              {g.items.map((it) => (
                <div className="shortcuts-row" key={it.desc}>
                  <span className="shortcuts-desc">{it.desc}</span>
                  <span className="shortcuts-keys">
                    {it.keys.map((k) => <kbd key={k}>{k}</kbd>)}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </section>

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
