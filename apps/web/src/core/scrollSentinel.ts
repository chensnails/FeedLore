/**
 * 自动翻页哨兵的统一滚动调度。
 *
 * 卡片页与文章页各自在 document 捕获阶段挂了 scroll 监听，只为做同一件事：
 * 读一次哨兵/列表几何，判断要不要续拉。两者都做 getBoundingClientRect，
 * 同帧多次触发会重复强制布局。这里合成一个 passive 监听 + 每帧一次回调，
 * 几何检查函数自己负责判断当前视图与忙碌闸门。
 *
 * 只收口「几何哨兵」这类可延后一帧的检查；底栏收展 / scrollBusy / 回顶钮
 * 需要同一帧同步反馈（且测试按同步派发断言），保持各自独立监听。
 */

type SentinelCheck = () => void;

const checks = new Set<SentinelCheck>();
let installed = false;
let frame = 0;

function flush() {
  frame = 0;
  for (const check of checks) check();
}

function onScroll() {
  if (frame) return;
  frame = requestAnimationFrame(flush);
}

export function registerSentinelCheck(check: SentinelCheck): () => void {
  checks.add(check);
  if (!installed) {
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    installed = true;
  }
  return () => {
    checks.delete(check);
    if (checks.size || !installed) return;
    document.removeEventListener('scroll', onScroll, { capture: true });
    installed = false;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  };
}
