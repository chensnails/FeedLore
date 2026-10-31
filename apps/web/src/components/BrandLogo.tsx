/**
 * 品牌 logo（笺川）：文档 + 星形，v1 的 BrandLogo 原样移植。
 *
 * 为什么是独立组件而不是 Icon.tsx 里的一项：这是**品牌图形**（多色、带底板），
 * 不是界面操作图标——颜色走 --accent / --logo-fg 令牌随主题走（图形里的白色部分
 * 三主题恒白，不随主色反色），尺寸由消费点的 CSS 控制（顶栏 22 / 登录页 40）。
 */
export function BrandLogo({ className = '' }: { className?: string }) {
  return (
    <svg
      className={'brand-logo' + (className ? ` ${className}` : '')}
      viewBox="0 0 64 64"
      role="img"
      aria-label="笺川"
    >
      <rect width="64" height="64" rx="15" fill="var(--accent)" />
      <rect x="8" y="17" width="33" height="37" rx="6" fill="var(--logo-fg)" />
      <rect x="15" y="25" width="19" height="5" rx="2.5" fill="var(--accent)" />
      <rect x="15" y="35" width="12" height="5" rx="2.5" fill="var(--accent)" />
      <rect x="15" y="45" width="16" height="5" rx="2.5" fill="var(--accent)" />
      <path
        d="M51.5 6 l2.9 7.1 7.1 2.9 -7.1 2.9 -2.9 7.1 -2.9 -7.1 -7.1 -2.9 7.1 -2.9 z"
        fill="var(--logo-fg)"
      />
    </svg>
  );
}
