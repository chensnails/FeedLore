/* 设置面板共用构件：折叠分组 / 结果提示 / 底部动作栏。
 *
 * 八个面板原先各抄一份 `<details class="sec">`、`.test-result`、`.pane-foot` 标记，
 * 调一次标题层级或间距要改八遍，漏一处同一面板里就出现两种节奏。这里只收敛标记，
 * 不改类名与 data-sec —— 样式与折叠状态持久化仍完全依赖原有的 class / 属性。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 表单面板的异步回填守卫。
 *
 * 面板一挂载就发 GET /api/prefs，用户完全可能在响应回来前就开始输入。
 * 旧实现拿到数据后无条件 `setForm(next)` + `setSaved(...)`，会把用户刚敲的内容
 * 整块覆盖、改动静默丢失（浏览器实测：拨「每天自动生成」后 checked 被弹回、
 * 不进脏态，保存按钮仍是禁用的）。而且时序一变就复现，属于典型的隐性竞态。
 *
 * 用法：
 *   const guard = useFormLoadGuard();
 *   每次用户输入 → guard.mark()
 *   load() 回填   → guard.apply(() => { setForm(next); setSaved(...) })
 * apply 返回 false 表示「用户已编辑，本次回填被跳过」，调用方只需保证脏态基线有效。
 */
export function useFormLoadGuard() {
  const touched = useRef(false);
  const mark = useCallback(() => { touched.current = true; }, []);
  const apply = useCallback((fn) => {
    if (touched.current) return false;
    fn();
    return true;
  }, []);
  const reset = useCallback(() => { touched.current = false; }, []);
  return { mark, apply, reset };
}

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

/** 面板底部固定动作栏：左侧说明 / 次要动作，右侧主动作。
 *  dirty 时在保存按钮旁补一枚常驻提示：它和弹层标题、页签圆点说的是同一件事，
 *  但就在手边 —— 长面板滚到底时不必抬头找状态。这枚是纯视觉提示（aria-hidden），
 *  播报交给标题那枚 role=status，避免读屏把同一句「未保存」连念三遍。
 *  动作栏本身在滚动容器之外，恒可见。 */
export function PaneFoot({ lead, note, children, dirty }) {
  return (
    <div className={'pane-foot' + (dirty ? ' is-dirty' : '')}>
      {lead != null ? lead : null}
      {children ? (
        <div className="pane-foot-btns">
          {dirty ? <span className="pane-foot-dirty" aria-hidden="true">有未保存的更改</span> : null}
          {children}
        </div>
      ) : null}
      {note ? <span className="pane-foot-note">{note}</span> : null}
    </div>
  );
}

/** 只读字段：默认态用文本表达当前值，需要修改时由外层展开输入框。
 *  刻意不用 disabled input —— 它看起来仍像可点，复制文本也不方便。 */
export function ReadonlyField({ label, value, hint, mono }) {
  return (
    <div className="ro-field">
      <span className="ro-field-label">{label}</span>
      <span className={'ro-field-value' + (mono ? ' is-mono' : '')}>{value || '未设置'}</span>
      {hint ? <span className="ro-field-hint">{hint}</span> : null}
    </div>
  );
}

/** 编辑态开关：默认「修改…」，展开后变「收起」。aria-expanded 让读屏知道表单是否已展开。 */
export function EditToggle({ editing, onClick, editText = '编辑', closeText = '收起', id }) {
  return (
    <button type="button" id={id} className="btn btn-ghost btn-sm ro-toggle"
      aria-expanded={editing ? 'true' : 'false'} onClick={onClick}>
      {editing ? closeText : editText}
    </button>
  );
}

/** 内联结果提示。ok 由调用方决定何时清除（多数面板 4 秒，err 常驻）。
 *  失败用 role=alert（隐含 assertive）：以前一律 polite，导入 / 还原失败会排在
 *  其它状态消息之后播报，读屏用户可能几分钟后才知道操作没成功。 */
export function Result({ id, result }) {
  const failed = !!(result && !result.ok);
  return (
    <div id={id} role={failed ? 'alert' : 'status'} aria-live={failed ? 'assertive' : 'polite'}
      aria-atomic="true"
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
