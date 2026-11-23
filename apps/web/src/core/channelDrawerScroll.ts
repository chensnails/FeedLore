/* 移动端频道抽屉的滚动位置记忆（文章页 / 卡片页共用）
 * ------------------------------------------------------------
 * 抽屉本身是 fixed + overflow-y:auto 的容器（.reader-side / .cards-side），
 * React 重绘频道列表时浏览器会把它夹回起始位置；加上打开时把焦点给顶部
 * 关闭按钮，浏览器又会把焦点元素滚进可视区 —— 于是「切一次频道就回到顶」，
 * 手指刚滚到的位置全丢了。
 *
 * 这里按 variant 在内存里记一份 scrollTop：关闭前 remember，打开后 restore。
 * 恢复后还要校正「当前选中的频道」——换频道后 active 可能落在旧位置的可视区外，
 * 只恢复数字会让用户看到一个没有高亮的中间段。校正遵循与横滑频道条同一条
 * 手感：**已完整可见就不动**，确实看不见才滚到居中，且只滚抽屉自己。
 *
 * 不用 scrollIntoView：它会连带滚动祖先容器，并与抽屉手势 / 惯性互抢。
 * 只活内存：刷新后回到顶部是合理的，不进账号偏好、不写 localStorage。
 */

type Variant = 'reader' | 'cards';

const sideId = (v: Variant) => (v === 'reader' ? 'readerSide' : 'cardsSide');
const positions = new Map<Variant, number>();

/**
 * 纯函数：算「让某元素完整可见」需要的 scrollTop；已经完整可见返回 null（不动）。
 *
 * 几何口径与横滑条 ChannelTabs 一致，只是换了纵轴：
 *   elTop = 元素相对可视区顶部的距离（getBoundingClientRect 的差值），
 *   加上当前 scrollTop 才是它在整段内容里的绝对位置。
 * clamp 到 [0, scrollHeight - clientHeight]，短列表（不可滚）自然返回 0。
 */
export function revealScrollTop(
  elTop: number,
  elHeight: number,
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
): number | null {
  if (!Number.isFinite(clientHeight) || clientHeight <= 0) return null;
  const maxTop = Math.max(0, (Number.isFinite(scrollHeight) ? scrollHeight : 0) - clientHeight);
  const cur = Math.max(0, Math.min(maxTop, Number.isFinite(scrollTop) ? scrollTop : 0));
  const absTop = (Number.isFinite(elTop) ? elTop : 0) + cur;
  const absBottom = absTop + (Number.isFinite(elHeight) ? elHeight : 0);
  // 元素比可视区还高：只要顶部露出来就算可见，强行居中反而把标题顶出去
  if (absBottom - absTop > clientHeight) {
    if (absTop > cur + clientHeight - 1) return Math.max(0, Math.min(maxTop, absTop));
    return null;
  }
  if (absTop >= cur && absBottom <= cur + clientHeight) return null;
  const target = absTop - (clientHeight - (absBottom - absTop)) / 2;
  return Math.max(0, Math.min(maxTop, target));
}

/** 关闭抽屉前记住当前滚动位置。顶部（0）不占记忆条目，下次打开就从头看。 */
export function rememberChannelDrawerScroll(variant: Variant): void {
  const side = document.getElementById(sideId(variant));
  if (!side) return;
  const top = Math.max(0, Number(side.scrollTop) || 0);
  if (top > 0) positions.set(variant, top);
  else positions.delete(variant);
}

/** 清空记忆（换账号 / 列表整体重置时用；当前没有调用方，导出备查）。 */
export function forgetChannelDrawerScroll(variant: Variant): void {
  positions.delete(variant);
}

/**
 * 打开抽屉后恢复位置，并校正选中频道可见。
 * 同步落地一次（无闪烁），再在下一帧补一次：列表首屏可能还在异步铺开，
 * 此刻的 scrollHeight 偏小会把目标夹短，等一帧布局稳了再校一次。
 */
export function restoreChannelDrawerScroll(variant: Variant): void {
  // 宽屏没有抽屉（频道栏是常驻侧栏），别去动侧栏的滚动
  if (typeof window !== 'undefined' && window.innerWidth > 720) return;
  const side = document.getElementById(sideId(variant));
  if (!side) return;
  const want = positions.get(variant) || 0;

  const apply = () => {
    if (!side.isConnected) return;
    const max = Math.max(0, (side.scrollHeight || 0) - (side.clientHeight || 0));
    if (want > 0) side.scrollTop = Math.min(want, max);
    const active = side.querySelector<HTMLElement>('.rd-ch.active');
    if (!active) return;
    const sideRect = side.getBoundingClientRect();
    const aRect = active.getBoundingClientRect();
    if (!sideRect.height || !aRect.height) return; // 布局不可读：保留数字，别瞎滚
    const next = revealScrollTop(
      aRect.top - sideRect.top,
      aRect.height,
      side.scrollTop,
      side.clientHeight,
      side.scrollHeight,
    );
    if (next != null) side.scrollTop = next;
  };

  apply();
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(apply);
}

/** 测试用：读取某 variant 记住的位置（0 = 未记住）。 */
export function channelDrawerScrollTop(variant: Variant): number {
  return positions.get(variant) || 0;
}
