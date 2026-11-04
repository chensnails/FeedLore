/* 设置分区元数据（导航、移动端摘要、命令面板共用一份）。
 * group 决定左导航分组；desc 只在移动端列表里显示；keywords 供设置内搜索与 ⌘K 使用。 */

export const SETTINGS_TABS = [
  {
    name: 'source', label: '数据源', group: '内容', icon: 'inbox',
    desc: '订阅、分组与抓取参数',
    keywords: '订阅 rss feed 频道 分组 抓取 频率 并发 超时 代理 图片 缓存 压缩 source',
  },
  {
    name: 'watch', label: '规则', group: '内容', icon: 'filter',
    desc: '关注/屏蔽规则、过滤与通知',
    keywords: '关注 屏蔽 规则 过滤 关键词 webhook 通知 推送 保留 天数 watch filter',
  },
  {
    name: 'digest', label: '日报', group: '内容', icon: 'file',
    desc: '日报时间、范围与风格',
    keywords: '日报 生成 时间 自动 范围 条数 风格 提示词 digest ai',
  },
  {
    name: 'model', label: '模型', group: '智能', icon: 'sparkle',
    desc: '模型地址、Key 与思考深度',
    keywords: '模型 llm 地址 api key 密钥 温度 思考 深度 qwen deepseek model',
  },
  {
    name: 'account', label: '账号', group: '账户', icon: 'user',
    desc: '用户名、密码与用户管理',
    keywords: '账号 用户名 密码 用户 管理 权限 角色 只读 管理员 安装 手机 account user',
  },
  {
    name: 'appearance', label: '外观', group: '账户', icon: 'palette',
    desc: '主题、字号与阅读宽度',
    keywords: '外观 主题 深色 浅色 字号 字体 阅读宽度 行距 appearance theme',
  },
  {
    name: 'status', label: '状态', group: '系统', icon: 'activity',
    desc: '运行健康、队列与诊断',
    keywords: '状态 运行 健康 诊断 日志 数据库 队列 错误 status health',
  },
  {
    name: 'about', label: '关于', group: '系统', icon: 'info',
    desc: '版本、更新与项目信息',
    keywords: '关于 版本 更新 升级 github 项目 about version',
  },
];

export const TAB_GROUPS = ['内容', '智能', '账户', '系统'];

// 管理员专属 tab（模型配置每用户独立，普通用户也能配）
export const ADMIN_TABS = ['status'];
// 只读账户只保留「阅读体验 / 账号信息 / 关于」
export const READONLY_TABS = ['account', 'appearance', 'about'];

export const TAB_BY_NAME = SETTINGS_TABS.reduce((m, t) => {
  m[t.name] = t;
  return m;
}, {});

export function visibleTabs(admin, readonly) {
  return SETTINGS_TABS.filter((t) => {
    if (ADMIN_TABS.indexOf(t.name) >= 0 && !admin) return false;
    if (readonly && READONLY_TABS.indexOf(t.name) < 0) return false;
    return true;
  });
}

/** 搜索匹配 label / desc / keywords / 分组名；空查询返回全部。 */
export function matchTabs(tabs, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return tabs;
  return tabs.filter((t) => (
    (t.label + ' ' + t.desc + ' ' + t.keywords + ' ' + t.group).toLowerCase().indexOf(q) >= 0
  ));
}
