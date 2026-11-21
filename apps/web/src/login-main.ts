/* 独立文档入口：只为把 login.css 纳入 Vite 打包（产物带内容哈希）。
 * login.html 与 change-password.html 都是纯 HTML + 内联脚本、没有 React，
 * 两者共用这一份卡片外观，所以共用一个入口。
 * login.css 从 public/ 移入 src/ —— 此前固定路径 /login.css
 * 会被 CDN 缓存 1~4 小时，与主站同样的版本错配风险。 */
import './login.css';
import { errorText } from './core/errorText.ts';
import { NET_TIMEOUT_MS, NET_WRITE_TIMEOUT_MS, timeoutText } from './core/util.fetch.ts';

/* 内联脚本（非模块）要在提交时把错误码译成中文，这里挂到 window 上给它用。
 * module 是 defer 的，一定早于任何用户提交执行完。 */
window.errText = errorText;

/* 登录页与改密页都各自 15s 硬超时时，弱网下的表现和主站（GET 8s / 写 30s）对不上。
 * 两个独立文档拿不到模块，这里把主站网络层的超时上限与文案一并挂出来，
 * 由两页内联脚本读取，避免「15 秒」「网络请求超时」各写一份漂移。 */
window.netTimeout = {
  getMs: NET_TIMEOUT_MS,
  writeMs: NET_WRITE_TIMEOUT_MS,
  text: timeoutText,
};
