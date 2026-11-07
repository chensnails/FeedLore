/* API 错误码 → 中文文案。
 *
 * 服务端只回「稳定错误码 + 英文说明」（见 packages/contract/src/errors.ts），界面语言归前端管：
 * - 命中码表：显示中文；
 * - 没命中（网关 HTML、旧数据、上游异常原文）：退回英文 message，再退回原始串；
 * - 都没有：用调用方自带的中文兜底。
 *
 * 加新码时这里也要补一条，否则界面会掉到英文。
 */

const CN = {
  E_DB_NOT_READY: '数据库未就绪',
  E_SERVICE_NOT_READY: '服务未就绪',
  E_AUTH_NOT_READY: '鉴权服务未就绪',
  E_DB_URL_UNSET: '未配置数据库地址（DATABASE_URL）',

  E_UNAUTHORIZED: '未登录',
  E_ADMIN_ONLY: '需要管理员权限',
  E_READONLY_CONFIG: '只读账户不能修改配置，请联系管理员',
  E_READONLY_CREDENTIAL: '只读账户不能修改用户名或密码，请联系管理员',
  E_READONLY_RULES: '只读账户不能修改订阅规则、模型或日报配置',
  E_CSRF_ORIGIN_MISSING: '缺少合法的来源信息，已拒绝写入',
  E_CSRF_UNTRUSTED_ORIGIN: '来源不受信任，已拒绝跨站写入',
  E_SIGNUP_DISABLED: '未开放注册',
  E_LOGIN_VIA_API: '请通过 /api/login 登录',
  E_RATE_LIMITED: (p) =>
    p.retryAfter ? `登录尝试过于频繁，请 ${p.retryAfter} 秒后再试` : '登录尝试过于频繁，请稍后再试',
  E_BAD_CREDENTIALS: '用户名或密码错误',

  E_USERNAME_TAKEN: '用户名已存在',
  E_USER_NOT_FOUND: '用户不存在',
  E_LAST_ADMIN: '至少要保留一个管理员',
  E_CANNOT_DELETE_SELF: '不能删除当前登录的账号',
  E_PASSWORD_TOO_SHORT: '密码至少 4 位',
  E_NEW_PASSWORD_TOO_SHORT: '新密码至少 4 位',
  E_CURRENT_PASSWORD_WRONG: '当前密码不正确',
  E_NOTHING_TO_UPDATE: '用户名和新密码至少填一项',
  E_USER_CREATE_FAILED: '创建失败',
  E_USER_NOT_PERSISTED: '创建失败：用户未落库',
  E_PASSWORD_UPDATE_FAILED: '改密失败',
  E_SESSION_NOT_FOUND: '这台设备已不在登录列表中',
  E_CANNOT_REVOKE_CURRENT: '不能在这里退出当前设备，请用「退出登录」',
  E_BACKUP_IN_PROGRESS: '已经有一份整站备份在生成，等它完成后再试',
  E_RESTORE_IN_PROGRESS: '已经有一份整站还原在进行，等它完成后再试',

  E_FEED_NOT_FOUND: '频道不存在',
  E_FEED_CREATE_FAILED: '频道创建失败',
  E_FEED_URL_DUPLICATE: (p) => (p.name ? `这个地址已经是你的另一个频道：${p.name}` : '这个地址已经是你的另一个频道'),
  E_ENTRY_NOT_FOUND: '条目不存在',
  E_NO_FLAGS_TO_UPDATE: '没有要修改的标记',
  E_EMPTY_OPML: '未收到 OPML 内容',
  E_OPML_NO_FEEDS: 'OPML 里没有可订阅的地址',
  E_UNEXPECTED_OPML: '文件看起来不是 OPML',

  E_FETCH_FAILED: '抓取失败',
  E_FETCH_TIMEOUT: '抓取超时',
  E_FETCH_TOO_LARGE: '响应体过大',
  E_FETCH_NOT_FEED: '不是可识别的 RSS / Atom 内容',
  E_FETCH_HTTP_STATUS: '站点返回错误',
  E_URL_INVALID: '地址格式不正确',
  E_URL_SCHEME_UNSUPPORTED: '只支持 http:// 或 https:// 地址',
  E_URL_MISSING_HOST: '地址缺少主机名',
  E_DNS_FAILED: '域名解析失败，请检查地址拼写',
  E_PRIVATE_HOST_BLOCKED: '不允许访问内网 / 回环地址（确需访问请给服务端设 ALLOW_PRIVATE_HOSTS=1）',
  E_TOO_MANY_REDIRECTS: '重定向层数过多',
  E_RSS_URL_INVALID: 'RSS 地址格式不正确',
  E_RSS_URL_SCHEME_UNSUPPORTED: 'RSS 地址需以 http:// 或 https:// 开头',
  E_RSS_URL_HOST_INVALID: 'RSS 地址的主机名看起来不合法',

  E_IMAGE_DATA_URI_REJECTED: 'data: 地址无需经过图片代理',
  E_IMAGE_UPSTREAM_ERROR: '图片源返回错误',
  E_IMAGE_FETCH_FAILED: '图片获取失败',

  E_DATE_INVALID: '日期不合法，应为 YYYY-MM-DD 的真实日期',
  E_DIGEST_DISABLED: '日报已在本账号关闭，要在「设置 · 日报」里重新开启才能生成',
  E_MODEL_INCOMPLETE: '模型未配置完整：地址、API Key、模型名都要在本账号填写后才能测试',
  E_MODEL_URL_UNREACHABLE: '模型地址不可用',

  E_WEBHOOK_URL_UNREACHABLE: 'Webhook 地址不可用',
  E_UPDATE_CHANNEL_UNSET: '未配置更新通道（UPDATE_WEBHOOK_URL / UPDATE_WEBHOOK_TOKEN）',
  E_UPDATE_CHANNEL_URL_BAD: '更新通道地址协议非法',
  E_UPDATE_TRIGGER_FAILED: '触发更新失败',
  E_UPDATE_NO_RELEASE: 'GitHub 上还没有任何发布',

  E_IMPORT_INVALID: '上传的文件不是有效的导出包或备份包，请检查是否选错了文件',
  E_IMPORT_TOO_LARGE: '上传的文件太大，请检查是否选错了包',
  E_ARCHIVE_IS_USER_EXPORT: '这是账号导出包，不能用于整站还原；请到「数据导入」上传',
  E_ARCHIVE_IS_SITE_BACKUP: '这是整站备份，不能用于账号导入；请到「整站还原」上传',

  E_MCP_DISABLED: 'MCP 接口未开启（服务端 MCP_ENABLED=0）',
  E_MCP_TOKEN_INVALID: 'MCP 令牌缺失或无效',
  E_MCP_SCOPE_DENIED: '这个 MCP 令牌的权限档不够',
  E_MCP_RATE_LIMITED: 'MCP 调用太频繁，请稍后再试',
  E_MCP_TOKEN_LIMIT: 'MCP 令牌数量已达上限，请先吊销不用的',
  E_MCP_TOKEN_NOT_FOUND: '找不到这个 MCP 令牌（可能已被吊销）',
  E_NO_FIELDS_TO_SAVE: '没有可保存的字段',
  E_BAD_REQUEST: '请求参数不合法',
  E_CONTRACT_VIOLATION: '服务响应不符合契约',
  E_ROUTE_NOT_FOUND: '接口不存在',
  E_INTERNAL: '服务器内部错误',
};

/** `E_CODE` 或 `E_CODE:补充信息`（后一种来自持久化的抓取失败原因，如 `E_FETCH_HTTP_STATUS:403`）。 */
const CODE_RE = /^(E_[A-Z0-9_]+)(?::(.+))?$/;

/**
 * @param input  响应体对象（`{ error, message, params }`）、或裸字符串（如库里存的 lastError `E_CODE:403`）
 * @param fallbackText 调用方的中文兜底
 */
export function errorText(input, fallbackText = '') {
  let code = '';
  let params = {};
  let english = '';

  if (typeof input === 'string') {
    code = input;
  } else if (input && typeof input === 'object') {
    code = typeof input.error === 'string' ? input.error : '';
    english = typeof input.message === 'string' ? input.message : '';
    if (input.params && typeof input.params === 'object') params = input.params;
  }

  const m = CODE_RE.exec(code);
  if (m) {
    code = m[1];
    const entry = CN[code];
    if (entry) {
      const base = typeof entry === 'function' ? entry(params) : entry;
      // 补充信息：持久化错误码的冒号后缀（HTTP 状态），或服务端透传的上游原文
      const detail = String(params.detail ?? m[2] ?? '');
      return detail && !base.includes(detail) ? `${base}：${detail}` : base;
    }
  }
  return english || code || fallbackText;
}
