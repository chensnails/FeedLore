/* 品牌 logo（笺川）：v1.6.0 起不再挂在顶栏，而是放到底部频道栏顶部。
 * 颜色走 --accent / --logo-fg 令牌，三主题自适应；尺寸由 .brand-logo / .side-brand 控制。 */
export function BrandLogo({ className = '' }) {
  return (
    <svg className={'brand-logo' + (className ? ' ' + className : '')} viewBox="0 0 64 64" role="img" aria-label="笺川">
      <rect width="64" height="64" rx="15" fill="var(--accent)" />
      <rect x="8" y="17" width="33" height="37" rx="6" fill="var(--logo-fg)" />
      <rect x="15" y="25" width="19" height="5" rx="2.5" fill="var(--accent)" />
      <rect x="15" y="35" width="12" height="5" rx="2.5" fill="var(--accent)" />
      <rect x="15" y="45" width="16" height="5" rx="2.5" fill="var(--accent)" />
      <path d="M51.5 6 l2.9 7.1 7.1 2.9 -7.1 2.9 -2.9 7.1 -2.9 -7.1 -7.1 -2.9 7.1 -2.9 z" fill="var(--logo-fg)" />
    </svg>
  );
}
