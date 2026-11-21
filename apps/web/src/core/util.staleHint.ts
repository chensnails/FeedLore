/* 慢响应被新请求取代时的低干扰提示。
 *
 * 列表请求用 generation + abort 防竞态：旧响应回来时直接丢弃，这是正确行为，
 * 绝不为了提示去动它。但弱网下旧请求挂了几秒才被「重试 / 换条件」打断，
 * 用户会觉得「点了没反应」——这里只补一条轻提示解释发生了什么。
 *
 * 两条收敛条件（缺一不可，否则会打扰快速连续操作）：
 *   1. 请求本身已挂够久（STALE_HINT_MIN_MS）；搜索连打、快速切频道不提示。
 *   2. 提示有冷却窗（STALE_HINT_COOLDOWN_MS）；连续几个慢请求只提示一次。
 * 提示走普通成功态（role=status / aria-live=polite），不抢撤销、不清空队列。
 */
import { toast } from './util.toast.ts';

/** 低于这个耗时视作「用户正在快速改条件」，静默处理。 */
export const STALE_HINT_MIN_MS = 1500;
/** 冷却窗：避免一次弱网事故里连弹好几条同样的提示。 */
export const STALE_HINT_COOLDOWN_MS = 4000;
export const STALE_HINT_TEXT = '已切到最新条件，旧请求已取消';

let lastHintAt = 0;

/** 仅供测试复位冷却记录。 */
export function resetStaleHint() {
  lastHintAt = 0;
}

/** 旧列表请求被取代时调用一次。startedAt 是请求发出时刻（Date.now()）。 */
export function noteListStale(startedAt: number, now = Date.now()) {
  if (!Number.isFinite(startedAt) || !Number.isFinite(now)) return;
  if (now - startedAt < STALE_HINT_MIN_MS) return;
  if (now - lastHintAt < STALE_HINT_COOLDOWN_MS) return;
  lastHintAt = now;
  toast(STALE_HINT_TEXT, true);
}
