/* 频道头像：图标加载失败（拉取 404 / 防盗链）时回退到首字母，避免破图标。
 * 文章页侧栏与卡片页频道抽屉共用（v1.3.10 从 ReaderView 抽出来）。
 */
import React, { useState } from 'react';

export function ChannelAvatar({ icon, name }) {
  const [failed, setFailed] = useState(false);
  if (!icon || failed) {
    return <span className="rd-ch-avatar rd-ch-avatar-txt">{String(name || '?').slice(0, 1)}</span>;
  }
  return (
    <img className="rd-ch-avatar" src={icon} alt="" loading="lazy"
      onError={() => setFailed(true)} />
  );
}
