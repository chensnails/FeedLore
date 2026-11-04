/* 设置面板共用构件：折叠分组 / 结果提示 / 底部动作栏。
 *
 * 八个面板原先各抄一份 `<details class="sec">`、`.test-result`、`.pane-foot` 标记，
 * 调一次标题层级或间距要改八遍，漏一处同一面板里就出现两种节奏。这里只收敛标记，
 * 不改类名与 data-sec —— 样式与折叠状态持久化仍完全依赖原有的 class / 属性。
 */

import React, { useEffect, useRef, useState } from 'react';

/**
 * 一个可折叠分组。`open` 只是首次默认值；用户改过之后以 bindSections 记住的状态为准。
 * `subId` 留给需要被旧逻辑按 id 取用的摘要（频道计数、采集参数摘要）。
 */
export function Section({ secKey, title, sub, subId, open, id, children }) {
  return (
    <details className="sec" data-sec={secKey} id={id} open={open || undefined}>
      <summary className="sec-head">
        <svg className="sec-arrow" aria-hidden="true" focusable="false"><use href="#i-chevron-right" /></svg>
        <span className="sec-title">{title}</span>
        <span className="sec-sub" id={subId}>{sub}</span>
      </summary>
      <div className="sec-body">{children}</div>
    </details>
  );
}

/** 面板底部固定动作栏：左侧说明 / 次要动作，右侧主动作。 */
export function PaneFoot({ lead, note, children }) {
  return (
    <div className="pane-foot">
      {lead != null ? lead : null}
      {children ? <div className="pane-foot-btns">{children}</div> : null}
      {note ? <span className="pane-foot-note">{note}</span> : null}
    </div>
  );
}

/** 内联结果提示。ok 由调用方决定何时清除（多数面板 4 秒，err 常驻）。 */
export function Result({ id, result }) {
  return (
    <div id={id} role="status" aria-live="polite"
      className={'test-result' + (result ? ' show ' + (result.ok ? 'ok' : 'err') : '')}>
      {result ? result.msg : ''}
    </div>
  );
}

/** test-result 的配套状态：ok 4 秒后自动清除，err 常驻（与旧 showResult 语义一致）。 */
export function useResult(state) {
  const [result, setResult] = useState(state || null);
  const timerRef = useRef(null);
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);
  const show = (ok, msg) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setResult({ ok, msg });
    if (ok) timerRef.current = setTimeout(() => setResult(null), 4000);
  };
  const clear = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setResult(null);
  };
  return [result, show, clear];
}
