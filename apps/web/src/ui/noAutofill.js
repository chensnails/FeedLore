/* 非登录输入框的自动填充防护（2026-11-07）。
 *
 * 现象：登录页 /login.html 的表单带标准 autocomplete 语义，浏览器保存了账号密码；
 * 之后同源的 SPA 里，Chrome / Edge Android 的启发式会**忽略** autocomplete="off"，
 * 把保存的 username 塞进任何「看起来像文本框」的 input —— 设置搜索框被填成
 * "admin"、并顶着一块蓝底自动填充建议，就是这么来的。用户没输入，却被改成了一个
 * 查不到任何分区的搜索词。
 *
 * 三层防护，缺一不可：
 *  1. 属性层：name 用非登录语义且每次挂载唯一的值（浏览器按 name/id 复用已存字段），
 *     再加主流密码管理器的忽略标记；登录页不接这一层，密码管理器在那儿是正确行为。
 *  2. 视觉层：hig.css 里 :-webkit-autofill 重置文字色与背景，并挂一个 1ms 的哨兵动画。
 *  3. 运行时：全局捕获 animationstart（哨兵动画），把被塞进来的值清掉并派发 input，
 *     让受控组件的 state 一起归零；另外在弹层打开时做一次「state 说空、DOM 非空」纠偏。
 *
 * 注意：只清 input.value 不够 —— React 的 value tracker 会认为值没变而不派发 onChange，
 * 所以必须走原型上的原生 setter 绕过 tracker（见 clearAutofilledInput）。
 */

import { useRef } from 'react';

/** 与 hig.css 的 @keyframes 同名：:-webkit-autofill 时会重放这个动画。 */
export const AUTOFILL_ANIMATION = 'flAutofillGuard';

let seq = 0;

/** 稳定但非语义化的 name：同一组件多次挂载互不相同，浏览器无法匹配已保存的账号字段。 */
export function useNoAutofillName(scope = 'fl-field') {
  const ref = useRef(null);
  if (!ref.current) {
    seq += 1;
    ref.current = scope + '-' + Date.now().toString(36) + '-' + seq.toString(36);
  }
  return ref.current;
}

/** spread 到所有搜索 / 过滤 / 关键词输入框；不要用在登录、改密、新建用户等凭据字段。 */
export const NO_AUTOFILL_PROPS = Object.freeze({
  autoComplete: 'off',
  autoCorrect: 'off',
  autoCapitalize: 'off',
  spellCheck: false,
  'data-lpignore': 'true',      // LastPass
  'data-1p-ignore': 'true',     // 1Password
  'data-bwignore': 'true',      // Bitwarden
  'data-form-type': 'other',    // Chrome / Dashlane 的表单分类提示
  'data-fl-no-autofill': 'true',
});

/** 清掉被自动填充的值，并让 React 受控组件同步到空状态。 */
export function clearAutofilledInput(input) {
  if (!input || !input.value) return false;
  const win = input.ownerDocument && input.ownerDocument.defaultView;
  const proto = win && win.HTMLInputElement
    ? win.HTMLInputElement.prototype
    : Object.getPrototypeOf(input);
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  try {
    if (desc && desc.set) desc.set.call(input, '');
    else input.value = '';
  } catch (_) {
    input.value = '';
  }
  const Ev = win && win.Event;
  if (Ev) input.dispatchEvent(new Ev('input', { bubbles: true }));
  return true;
}

/**
 * 全局守卫：装在 document 上，覆盖所有带 data-fl-no-autofill 的输入框。
 * 返回卸载函数（便于测试与热更新）；可在任意入口调用一次。
 */
export function installAutofillGuard(doc) {
  const target = doc || (typeof document !== 'undefined' ? document : null);
  if (!target || !target.addEventListener) return () => {};
  const onAnim = (ev) => {
    if (ev.animationName !== AUTOFILL_ANIMATION) return;
    const el = ev.target;
    if (el && el.matches && el.matches('input[data-fl-no-autofill]')) clearAutofilledInput(el);
  };
  target.addEventListener('animationstart', onAnim, true);
  return () => target.removeEventListener('animationstart', onAnim, true);
}
