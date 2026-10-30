import { useState, type ReactNode } from 'react';

/**
 * 统一的外链图片组件（卡片封面 / 频道图标 / 正文配图都走它）。
 *
 * 三件事在各处重复出现，抽出来的理由就是别再各写一遍：
 *  1. **失败即消失**：源站挂了、图片被删、代理 403 都很常见。图片裂了会把卡片
 *     撑出一块空白或一个破图标，比不显示更难看 —— 所以 onError 后直接返回 fallback。
 *  2. **换图自动恢复**：用「记住失败的 src」而不是布尔位。列表复用 DOM 时，
 *     src 变了布尔位还停在 true，新图永远出不来（这种 bug 只在翻页时才看得到）。
 *  3. **懒加载 + no-referrer**：一屏几十张图不该在首屏一次性拉完；no-referrer
 *     是给「代理也没兜住、浏览器直接回源」的兜底情况留的后路。
 */
export function Thumb({
  src,
  alt = '',
  className = '',
  fallback = null,
  decorative = false,
}: {
  src: string | null | undefined;
  alt?: string;
  className?: string;
  /** 没有图 / 加载失败时显示什么 */
  fallback?: ReactNode;
  /** 纯装饰图（封面）：alt 留空，读屏跳过 */
  decorative?: boolean;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  if (!src || failedSrc === src) return <>{fallback}</>;

  return (
    <img
      className={className}
      src={src}
      alt={decorative ? '' : alt}
      aria-hidden={decorative || undefined}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailedSrc(src)}
    />
  );
}
