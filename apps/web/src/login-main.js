/* 登录页入口：只为把 login.css 纳入 Vite 打包（产物带内容哈希）。
 * 登录页是纯 HTML + 内联脚本，没有 React，所以单独一个入口文件。
 * v1.5.0：login.css 从 public/ 移入 src/ —— 此前固定路径 /login.css
 * 会被 CDN 缓存 1~4 小时，与主站同样的版本错配风险。 */
import './login.css';
import { errorText } from './core/errorText.js';

/* 内联脚本（非模块）要在提交时把错误码译成中文，这里挂到 window 上给它用。
 * module 是 defer 的，一定早于任何用户提交执行完。 */
window.errText = errorText;
