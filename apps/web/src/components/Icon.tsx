import type { CSSProperties, ReactNode } from 'react';

/**
 * 统一图标集（**唯一来源**）。
 *
 * 为什么不再用 ⚙ ✎ ⟳ ✕ 这些字形：
 * 它们是「字体里的字符」，不同系统/字体下笔画粗细、基线、宽窄全不一样 —— 同一个 ⟳
 * 在 macOS 上是细线、在 Windows 上会变成粗箭头，同一个 ✕ 有的居中有的偏上。
 * 界面上几十处图标因此永远对不齐。这里统一为 24 网格的线性 SVG：
 * 1.7 线宽、圆角端点、currentColor 描边，尺寸走 --ico-xs|sm|md|lg（12/14/16/18）。
 *
 * 新增图标只加在这个文件里，不要在组件里写 <svg>。
 */

export type IconName =
  /* 导航 / 全局 */
  | 'menu'
  | 'search'
  | 'settings'
  | 'refresh'
  | 'command'
  | 'more'
  | 'sparkle'
  | 'type'
  | 'sun'
  | 'moon'
  | 'auto'
  /* 范围 */
  | 'all'
  | 'inbox'
  | 'star'
  | 'star-filled'
  | 'eye'
  | 'block'
  | 'folder'
  | 'rss'
  /* 动作 */
  | 'close'
  | 'pencil'
  | 'plus'
  | 'trash'
  | 'check'
  | 'check-all'
  | 'play'
  | 'pause'
  | 'grid'
  | 'list'
  | 'external'
  | 'link'
  | 'copy'
  | 'download'
  | 'upload'
  | 'target'
  | 'key'
  | 'user'
  | 'clock'
  | 'alert'
  /* 方向 */
  | 'arrow-up'
  | 'arrow-down'
  | 'arrow-right'
  | 'chevron-up'
  | 'chevron-down'
  | 'chevron-left'
  | 'chevron-right';

const star = 'M12 3.8l2.5 5.1 5.6.8-4 3.9.9 5.6L12 16.6 6.9 19.2l1-5.6-4.1-3.9 5.6-.8z';

const PATHS: Record<IconName, ReactNode> = {
  menu: (
    <>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.4" />
      <path d="M15.8 15.8L20 20" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h9M17.5 7H20M4 17h5M13.5 17H20" />
      <circle cx="15" cy="7" r="2.2" />
      <circle cx="11" cy="17" r="2.2" />
    </>
  ),
  refresh: (
    <>
      <path d="M4.2 12a7.8 7.8 0 0 1 13.3-5.5" />
      <path d="M19.8 12a7.8 7.8 0 0 1-13.3 5.5" />
      <path d="M17.6 3.2v3.9h-3.9" />
      <path d="M6.4 20.8v-3.9h3.9" />
    </>
  ),
  command: (
    <>
      <path d="M9 9h6v6H9z" />
      <path d="M9 9H6.6a2.6 2.6 0 1 1 2.6-2.6V9z" />
      <path d="M15 9h2.4a2.6 2.6 0 1 0-2.6-2.6V9z" />
      <path d="M9 15H6.6a2.6 2.6 0 1 0 2.6 2.6V15z" />
      <path d="M15 15h2.4a2.6 2.6 0 1 1-2.6 2.6V15z" />
    </>
  ),
  more: (
    <>
      <circle cx="5.5" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="12" r="1.5" fill="currentColor" stroke="none" />
    </>
  ),
  sparkle: (
    <>
      <path d="M12 3.4l1.7 4.9 4.9 1.7-4.9 1.7L12 16.6l-1.7-4.9L5.4 10l4.9-1.7z" />
      <path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" />
    </>
  ),
  type: (
    <>
      <path d="M4 7.5V5h9v2.5M8.5 5v14M6.5 19h4" />
      <path d="M15 19v-6.5h5V19M15 15.6h5" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7" />
    </>
  ),
  moon: (
    <>
      <path d="M20 14.4A8.4 8.4 0 0 1 9.6 4a8.6 8.6 0 1 0 10.4 10.4z" />
    </>
  ),
  auto: (
    <>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M12 3.6a8.4 8.4 0 0 1 0 16.8z" fill="currentColor" stroke="none" />
    </>
  ),
  all: (
    <>
      <rect x="3.4" y="3.4" width="7.2" height="7.2" rx="1.8" />
      <rect x="13.4" y="3.4" width="7.2" height="7.2" rx="1.8" />
      <rect x="3.4" y="13.4" width="7.2" height="7.2" rx="1.8" />
      <rect x="13.4" y="13.4" width="7.2" height="7.2" rx="1.8" />
    </>
  ),
  inbox: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2.2" />
      <path d="M3.4 7.2l8.6 5.6 8.6-5.6" />
    </>
  ),
  star: (
    <>
      <path d={star} />
    </>
  ),
  'star-filled': (
    <>
      <path d={star} fill="currentColor" />
    </>
  ),
  eye: (
    <>
      <path d="M2.4 12S6 5.6 12 5.6 21.6 12 21.6 12 18 18.4 12 18.4 2.4 12 2.4 12z" />
      <circle cx="12" cy="12" r="2.9" />
    </>
  ),
  block: (
    <>
      <circle cx="12" cy="12" r="8.2" />
      <path d="M6.2 6.2l11.6 11.6" />
    </>
  ),
  folder: (
    <>
      <path d="M3.2 7.4a2 2 0 0 1 2-2h3.6l2 2.2h6a2 2 0 0 1 2 2v7.6a2 2 0 0 1-2 2H5.2a2 2 0 0 1-2-2z" />
    </>
  ),
  rss: (
    <>
      <circle cx="6.2" cy="17.6" r="1.4" fill="currentColor" stroke="none" />
      <path d="M5 11.2a7.6 7.6 0 0 1 7.6 7.6" />
      <path d="M5 5.4A13.4 13.4 0 0 1 18.4 18.8" />
    </>
  ),
  close: (
    <>
      <path d="M6.2 6.2l11.6 11.6M17.8 6.2L6.2 17.8" />
    </>
  ),
  pencil: (
    <>
      <path d="M4.2 19.8h4l10-10a2.75 2.75 0 0 0-3.9-3.9l-10 10z" />
      <path d="M13.2 6.9l3.9 3.9" />
    </>
  ),
  plus: (
    <>
      <path d="M12 5.2v13.6M5.2 12h13.6" />
    </>
  ),
  trash: (
    <>
      <path d="M4.4 7h15.2" />
      <path d="M9.4 7V5.2h5.2V7" />
      <path d="M6.6 7l.9 12.2h9l.9-12.2" />
      <path d="M10.4 10.6v5.4M13.6 10.6v5.4" />
    </>
  ),
  check: (
    <>
      <path d="M5 12.8l4.2 4.2L19 6.6" />
    </>
  ),
  'check-all': (
    <>
      <path d="M2.6 12.6l3.6 3.6 7.2-7.4" />
      <path d="M11 16.4l1.4 1.4L22 7.8" />
    </>
  ),
  play: (
    <>
      <path d="M8.2 5.4l10.4 6.6-10.4 6.6z" />
    </>
  ),
  pause: (
    <>
      <path d="M9.2 5.4v13.2M14.8 5.4v13.2" />
    </>
  ),
  grid: (
    <>
      <rect x="3.4" y="3.4" width="7.2" height="7.2" rx="1.8" />
      <rect x="13.4" y="3.4" width="7.2" height="7.2" rx="1.8" />
      <rect x="3.4" y="13.4" width="7.2" height="7.2" rx="1.8" />
      <rect x="13.4" y="13.4" width="7.2" height="7.2" rx="1.8" />
    </>
  ),
  list: (
    <>
      <path d="M8.4 6.4h12M8.4 12h12M8.4 17.6h12" />
      <circle cx="4" cy="6.4" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="4" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="4" cy="17.6" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
  external: (
    <>
      <path d="M14 4.2h5.8V10" />
      <path d="M19.6 4.4l-8 8" />
      <path d="M18.2 13.8v4.4a2 2 0 0 1-2 2H5.4a2 2 0 0 1-2-2V7.4a2 2 0 0 1 2-2h4.4" />
    </>
  ),
  link: (
    <>
      <path d="M10.4 13.6a3.6 3.6 0 0 0 5.1 0l2.4-2.4a3.6 3.6 0 0 0-5.1-5.1l-1.2 1.2" />
      <path d="M13.6 10.4a3.6 3.6 0 0 0-5.1 0l-2.4 2.4a3.6 3.6 0 0 0 5.1 5.1l1.2-1.2" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5.5 14.5H5a1.5 1.5 0 0 1-1.5-1.5V5A1.5 1.5 0 0 1 5 3.5h8A1.5 1.5 0 0 1 14.5 5v.5" />
    </>
  ),
  download: (
    <>
      <path d="M12 3.8v11.4M7.4 11.4l4.6 4.6 4.6-4.6" />
      <path d="M4.6 20.2h14.8" />
    </>
  ),
  upload: (
    <>
      <path d="M12 20.2V8.8M7.4 12.6l4.6-4.6 4.6 4.6" />
      <path d="M4.6 3.8h14.8" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="8.2" />
      <circle cx="12" cy="12" r="3.1" />
    </>
  ),
  key: (
    <>
      <circle cx="8.2" cy="12" r="3.6" />
      <path d="M11.8 12h9M17.6 12v3.6M20.2 12v2.8" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8.4" r="3.6" />
      <path d="M5 20c0-3.5 3.1-6 7-6s7 2.5 7 6" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.2" />
      <path d="M12 7.4V12l3 1.9" />
    </>
  ),
  alert: (
    <>
      <path d="M12 4.2l8.2 14.6H3.8z" />
      <path d="M12 9.8v4.2M12 16.6v.6" />
    </>
  ),
  'arrow-up': (
    <>
      <path d="M12 19.4V5M6.4 10.6L12 5l5.6 5.6" />
    </>
  ),
  'arrow-down': (
    <>
      <path d="M12 4.6V19M6.4 13.4L12 19l5.6-5.6" />
    </>
  ),
  'arrow-right': (
    <>
      <path d="M4.6 12h14.8M13.8 6.4L19.4 12l-5.6 5.6" />
    </>
  ),
  'chevron-up': (
    <>
      <path d="M6 15l6-6 6 6" />
    </>
  ),
  'chevron-down': (
    <>
      <path d="M6 9l6 6 6-6" />
    </>
  ),
  'chevron-left': (
    <>
      <path d="M15 6l-6 6 6 6" />
    </>
  ),
  'chevron-right': (
    <>
      <path d="M9 6l6 6-6 6" />
    </>
  ),
};

export function Icon({
  name,
  size,
  className,
  style,
}: {
  name: IconName;
  /** 视觉尺寸（px）。缺省走 CSS 的 --ico-md（16）。 */
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      className={`ico${className ? ` ${className}` : ''}`}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      style={size ? { width: size, height: size, ...style } : style}
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
