/* 数据源面板的小件（图标 / 拖拽手柄 / 频道头像）：从 SourcePane.tsx 抽出，DOM 逐字对齐。 */

import { type SyntheticEvent, useRef, useState } from 'react';
import { isImgFailed, markImgFailed } from '../imgFail.ts';
import { withRetryParam } from '../imgSrc.ts';

export const Ico = ({ name }: { name: string }) => (
  <svg className="ico" aria-hidden="true" focusable="false">
    <use href={`#i-${name}`} />
  </svg>
);

export const GRIP = (
  <svg className="ico drag-grip" aria-hidden="true" focusable="false" viewBox="0 0 16 16">
    <circle cx="5" cy="3.5" r="1.35" />
    <circle cx="11" cy="3.5" r="1.35" />
    <circle cx="5" cy="8" r="1.35" />
    <circle cx="11" cy="8" r="1.35" />
    <circle cx="5" cy="12.5" r="1.35" />
    <circle cx="11" cy="12.5" r="1.35" />
  </svg>
);

/** 频道头像：图标加载失败（拉取 404 / 防盗链）时回退到首字母，避免破图标 */
export function FeedAvatar({ icon, name }: { icon: string | null; name: string }) {
  const [failed, setFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const triedRef = useRef(false);
  if (!icon || failed || isImgFailed(icon)) {
    return <span className="feed-avatar feed-avatar-txt">{(name || '?').slice(0, 1)}</span>;
  }
  return (
    <img
      className="feed-avatar"
      src={retrying ? withRetryParam(icon) : icon}
      alt=""
      loading="lazy"
      onError={(ev: SyntheticEvent<HTMLImageElement>) => {
        if (ev.currentTarget.complete && ev.currentTarget.naturalWidth > 0) return;
        if (!triedRef.current) {
          triedRef.current = true;
          setRetrying(true);
          return;
        }
        markImgFailed(icon);
        setFailed(true);
      }}
    />
  );
}
