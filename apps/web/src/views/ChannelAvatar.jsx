/* 频道头像：图标加载失败（拉取 404 / 防盗链）时回退到首字母，避免破图标。
 * 文章页侧栏与卡片页频道抽屉共用（v1.3.10 从 ReaderView 抽出来）。
 *
 * v1.5.0：改成「进入视口才加载」。
 * 此前用 loading="lazy"，但抽屉在窄屏是 display:none，里面的 24 个头像
 * 仍会全部发出请求（实测首屏 38 个请求里有 24 个是频道头像）——
 * 弱网下这些请求会占满浏览器的 6 条并发连接，把真正该先到的首屏图片挤到后面。
 * 抽屉打开时由 IntersectionObserver 触发加载；用户看不到的东西不占带宽。
 */
import { useState, useRef, useEffect } from 'react';

export function ChannelAvatar({ icon, name }) {
  const [failed, setFailed] = useState(false);
  const [visible, setVisible] = useState(false);
  const ref = useRef(null);

  // 元素进入视口（或已在视口内）才置为可见 → 才开始请求图片
  useEffect(() => {
    if (visible || !icon) return undefined;
    const el = ref.current;
    if (!el) return undefined;
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return undefined; }
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) { setVisible(true); io.disconnect(); }
      }
    }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [visible, icon]);

  if (!icon || failed) {
    return <span className="rd-ch-avatar rd-ch-avatar-txt">{String(name || '?').slice(0, 1)}</span>;
  }
  return (
    <span className="rd-ch-avatar-wrap" ref={ref}>
      {visible ? (
        <img className="rd-ch-avatar" src={icon} alt="" loading="lazy" decoding="async"
          onError={() => setFailed(true)} />
      ) : null}
    </span>
  );
}
