/* 数据源面板的选项表与兜底值（与旧 index.html / app.js 逐字对齐）：从 SourcePane.tsx 抽出。 */

// 每频道频率：比全局「自动抓取」多了 15 分钟 / 2 小时两档
export const FREQ_OPTIONS: Array<[number, string]> = [
  [5, '每 5 分钟'],
  [10, '每 10 分钟'],
  [15, '每 15 分钟'],
  [20, '每 20 分钟'],
  [30, '每 30 分钟'],
  [60, '每 1 小时'],
  [120, '每 2 小时'],
  [180, '每 3 小时'],
  [360, '每 6 小时'],
  [720, '每 12 小时'],
  [1440, '每天'],
];
export const REFRESH_OPTIONS: Array<[number, string]> = [
  [5, '每 5 分钟'],
  [10, '每 10 分钟'],
  [20, '每 20 分钟'],
  [30, '每 30 分钟'],
  [60, '每 1 小时'],
  [180, '每 3 小时'],
  [360, '每 6 小时'],
  [720, '每 12 小时'],
  [1440, '每天'],
];
export const KEEP_DAYS_OPTIONS: Array<[number, string]> = [
  [0, '不限时长'],
  [30, '1 个月'],
  [90, '3 个月'],
  [180, '半年'],
  [365, '1 年'],
  [730, '2 年'],
  [1095, '3 年'],
  [1825, '5 年'],
];
export const AUTO_REFRESH_OPTIONS: Array<[number, string]> = [
  [0, '关闭'],
  [1, '每 1 分钟'],
  [5, '每 5 分钟'],
  [15, '每 15 分钟'],
  [30, '每 30 分钟'],
];
// v2.4.0：图片缓存参数（仅管理员）
export const IMG_TTL_OPTIONS: Array<[number, string]> = [
  [1, '1 天'],
  [3, '3 天'],
  [7, '7 天'],
  [14, '14 天'],
  [30, '30 天'],
  [90, '90 天'],
];
export const IMG_KEEP_OPTIONS: Array<[number, string]> = [
  [7, '7 天'],
  [30, '1 个月'],
  [90, '3 个月'],
  [180, '半年'],
  [365, '1 年'],
  [730, '2 年'],
];
// 兜底值 = 旧 HTML 里各控件的默认值（配置拉到之前显示这些；拉到之前禁止保存）
export const CFG_DEFAULTS = {
  refreshMinutes: '30',
  keepPerFeed: '300',
  keepDays: '0',
  timeoutSeconds: '25',
  concurrency: '3',
  autoRefreshMinutes: '0',
  proxyUrl: '',
  imgTtlDays: '7',
  imgKeepDays: '90',
  imgMaxDim: '1280',
  imgQuality: '78',
  feedFailLimit: '5',
};
