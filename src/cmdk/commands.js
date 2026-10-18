/* 命令面板的命令清单与过滤逻辑（从原 public/app.js 的 cmdk 模块移植）。
 * 具体动作由调用方把 `core` 单例作为 S 传入，本模块只保留纯逻辑，不直接触碰全局。 */

import { cjkPinyin } from './pinyin.js';

/* 构建命令列表。S = core 单例，需提供：
 * switchView / applyTheme / openSettings / selectScope / jumpToFeed /
 * focusSearchBox / exportOpml / refresh / scrollTop / state /
 * shortFeedName / feedTitle / prefersReducedMotion / THEME_MODES / THEME_META */
export function buildCommands(S) {
  if (!S || typeof S.switchView !== 'function') return [];
  const cmds = [];
  [['reader', '文章'], ['cards', '卡片'], ['ai', 'AI']].forEach((v) => {
    cmds.push({
      group: '视图', icon: v[0] === 'reader' ? 'inbox' : (v[0] === 'cards' ? 'grid' : 'sparkle'),
      label: '切换到' + v[1] + '页', hint: v[1], keywords: 'view ' + v[1] + ' 页面切换',
      run: () => S.switchView(v[0]),
    });
  });
  S.THEME_MODES.forEach((m) => {
    const meta = (S.THEME_META && S.THEME_META[m]) ? S.THEME_META[m] : { label: m };
    cmds.push({
      group: '主题', icon: 'theme-auto', label: '主题：' + meta.label, hint: meta.label,
      keywords: 'theme dark light 暗色 浅色 外观', run: () => S.applyTheme(m, true),
    });
  });
  [['source', '数据源'], ['model', '模型'], ['account', '账号'], ['appearance', '外观'], ['status', '状态']].forEach((t) => {
    cmds.push({
      group: '设置', icon: 'settings', label: '打开设置 · ' + t[1], hint: t[1], keywords: 'settings ' + t[1],
      run: () => S.openSettings(t[0]),
    });
  });
  [['all', '全部文章'], ['unread', '未读'], ['favorite', '收藏']].forEach((s) => {
    cmds.push({
      group: '阅读范围', icon: s[0] === 'favorite' ? 'star' : (s[0] === 'unread' ? 'dot' : 'circle'),
      label: '阅读范围：' + s[1], hint: s[1], keywords: 'scope ' + s[1] + ' 未读 收藏',
      run: () => S.selectScope(s[0]),
    });
  });
  cmds.push({ group: '操作', icon: 'refresh', label: '重新拉取', hint: '刷新', keywords: 'refresh 刷新 同步', run: () => S.refresh() });
  cmds.push({ group: '操作', icon: 'search', label: '聚焦搜索', hint: '/', keywords: 'search 搜索 查找', run: () => S.focusSearchBox() });
  cmds.push({ group: '操作', icon: 'arrow-up', label: '回到顶部', hint: 'Top', keywords: 'top 顶部', run: () => S.scrollTop() });
  cmds.push({ group: '操作', icon: 'download', label: '导出 OPML', hint: '备份', keywords: 'opml export 导出 备份 订阅源 频道', run: () => S.exportOpml() });
  ((S.state && S.state.feedList) || []).forEach((f) => {
    cmds.push({
      group: '跳转到频道', icon: 'circle', label: S.shortFeedName(S.feedTitle(f)), hint: '频道',
      keywords: 'feed channel ' + (f.title || '') + ' ' + (f.groupName || ''), run: () => S.jumpToFeed(f.id),
    });
  });
  // 预计算每个命令的拼音（全拼 + 首字母），供命令面板按拼音过滤
  cmds.forEach((c) => { c.py = cjkPinyin((c.label || '') + ' ' + (c.keywords || '') + ' ' + (c.hint || '')); });
  return cmds;
}

/* 过滤：子序列匹配 + 拼音（全拼 / 首字母）。与旧实现一致。 */
export function cmdkFilter(commands, q) {
  q = (q || '').trim().toLowerCase();
  if (!q) return commands;
  return commands.filter((c) => {
    const hay = (c.label + ' ' + (c.keywords || '') + ' ' + (c.hint || '') + ' ' + (c.py || '')).toLowerCase();
    if (hay.indexOf(q) >= 0) return true;
    let i = 0;
    for (let k = 0; k < q.length; k++) {
      i = hay.indexOf(q[k], i);
      if (i < 0) return false;
      i++;
    }
    return true;
  });
}
