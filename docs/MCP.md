# MCP 接口文档

笺川（FeedLore）内置一个 **MCP（Model Context Protocol）服务器**，外部 AI 客户端
（Claude Desktop、Cherry Studio、Cline 等支持 MCP 的应用）可以直接查询你的订阅数据：
频道与未读数、文章检索与全文、AI 日报。

- 端点：`<你的站点地址>/mcp`
- 传输：Streamable HTTP，**无状态**、纯 JSON 应答（反代零配置）
- **无状态**：每个请求独立处理，不需要 `initialize` / `initialized` 会话握手；
  顺带发一次 `initialize` 也完全可以（返回 serverInfo），但省略它不会让后续调用失效
- 协议版本：2025-11-25 及兼容（SDK `@modelcontextprotocol/server@2.4.0`）
- 默认开启；服务端设 `MCP_ENABLED=0` 可整体关闭

---

## 1. 接入步骤

1. 登录网页 → **设置 → MCP 接口** → 创建一枚令牌（明文只显示这一次，立即复制保存）。
2. 在 AI 客户端里添加 MCP 服务器：
   - 类型：**HTTP / Streamable HTTP**（有的客户端叫「远程服务器」或「URL」）；
   - 地址：`https://你的域名/mcp`；
   - 请求头：`Authorization: Bearer flm_你的令牌`。
3. 客户端里应能看到 5 个 `feedlore_*` 工具，即可开始对话。

Cherry Studio / Claude 这类支持自定义请求头的客户端直接按上面填即可；
stdio 型客户端可用 `mcp-remote` 之类的桥接器转发。

### 手工验证（curl）

```bash
TOKEN="flm_xxx"

# 握手
curl -s https://你的域名/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'

# 工具列表
curl -s https://你的域名/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -H "Accept: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# 调用
curl -s https://你的域名/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -H "Accept: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"feedlore_list_feeds","arguments":{}}}'
```

---

## 2. 工具一览（全部只读）

| 工具 | 入参 | 说明 |
| --- | --- | --- |
| `feedlore_list_feeds` | `{}` | 全部频道：id、标题、分组、启用状态、总条数与未读数。找文章先调它拿 `feedId` |
| `feedlore_list_entries` | `feeds?` `q?` `tag?` `unread?` `fav?` `watch?` `scope?` `sort?` `offset?` `limit?` | 文章列表（标题+摘要，不含正文）。`q` 覆盖标题/摘要/正文/标签；`sort` = `new`/`old`/`name`（默认 new）；`scope` 默认 `all` |
| `feedlore_get_entry` | `id` | 单篇全文；超过 24000 字符截断并返回 `truncated: true` 与 `totalChars` |
| `feedlore_list_digests` | `{}` | 已生成日报的日期列表（新→旧，最多 120 天） |
| `feedlore_get_digest` | `date?`（YYYY-MM-DD） | 某天日报全文（总览+精选+分组摘要）；不传默认今天（上海时区） |

约束：`limit` 默认 20、**硬上限 50**（控制 AI 上下文体积）；列表条目按令牌归属账号过滤，
AI 只能看到这枚令牌主人自己的订阅。

### 参数容错与响应结构

- `feedlore_list_entries` 返回的 `id` / `feedId` 是**字符串**（与网页 API 一致）。
  `feedlore_get_entry` 的 `id` 直接传这个字符串即可，也接受数字。
- 数值参数（`limit` / `offset`）与布尔参数（`unread` / `fav`）都接受字符串形态，
  例如 `{"limit":"5","unread":"false"}`；布尔按词面识别 `true/1/yes/on` 与
  `false/0/no/off`，**不会**把 `"false"` 当成 true。越界或无法解析的值回落到默认值
  （limit 20 / offset 0 / false），不会让整次调用失败。
- **失败是结构化 JSON**：参数错误或服务端异常返回
  `{"error":"E_MCP_…","message":"…"}` 文本并带 `isError: true`（HTTP 状态仍是 200）。
  解析 `result.content[0].text` 即可区分「真的 0 条」与「调用失败」，不会误读成空列表。
- 列表响应带 `diagnostics`：`account`（令牌归属账号）、`returned`、`total`、
  `emptyReason`（`no_match` / `account_has_no_feeds` / `offset_beyond_total` /
  `feed_ids_empty`）以及 `query`、`scope`。空结果时先读它，不用猜「接口是不是挂了」。

---

## 3. 令牌与安全模型

- **与登录会话完全隔离**：`/mcp` 只认 `Authorization: Bearer flm_…`，不读 Cookie，
  不在 CSRF/同源模型内；吊销令牌不影响网页登录，改密码也不会让令牌失效。
- **存储**：库里只存 SHA-256，明文仅在创建响应出现一次；`flm_` 前 12 字符作为前缀
  显示在设置页与日志里。
- **吊销**：设置页随时软吊销，下一次请求即失效；每账号上限 20 枚。
- **限流**：每令牌 120 次/分钟，超出返回 429（`E_MCP_RATE_LIMITED`）。
- **权限边界**：当前只开放只读工具；用户管理、配置、导入还原等管理类接口
  **不接受 MCP 调用**；只读账户无法创建令牌。
- **令牌保管建议**：等同密码，只发给可信客户端；泄露就吊销重发。

### 错误码

| 码 | HTTP | 含义 |
| --- | --- | --- |
| `E_MCP_TOKEN_INVALID` | 401 | 缺失或无效的令牌 |
| `E_MCP_RATE_LIMITED` | 429 | 超过限流（响应 `params.retryAfter` 为等待秒数） |
| `E_MCP_DISABLED` | 404 | 服务端关闭了 MCP（`MCP_ENABLED=0`） |
| `E_MCP_SCOPE_DENIED` | 403 | 令牌权限档不够（为写工具预留） |
| `E_MCP_TOKEN_LIMIT` | 400 | 令牌数量达上限 |
| `E_MCP_TOKEN_NOT_FOUND` | 404 | 令牌不存在或已吊销 |

> 说明：401 故意**不带** `WWW-Authenticate` 头 —— 部分客户端看到它会进入 OAuth 发现
> 流程，发现不到反而报出更迷惑的错误。本服务器走「静态 Bearer 令牌」模型，不走 OAuth。

---

## 4. 服务端配置

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `MCP_ENABLED` | `1` | 设 `0` 关闭 `/mcp`（返回 `E_MCP_DISABLED`） |

反向代理（nginx / Caddy）无需任何特殊配置：响应是纯 JSON，没有 SSE 长连，
只需保证 `Authorization` 头透传（默认行为）。

数据表：`mcp_tokens`（迁移 0007，自举幂等应用，无需手工操作）。

---

## 5. 常见问题

**Q：客户端一直报 401？**
检查请求头是否带了 `Authorization: Bearer flm_…`（注意 Bearer 后有空格）；
令牌是否被吊销；站点是否设了 `MCP_ENABLED=0`。

**Q：AI 说看不到某些频道？**
工具只返回令牌主人自己的订阅；`feedlore_list_entries` 不传 `scope` 时默认 `all`，
传 `cards` 则只含开启卡片页的频道。

**Q：全文被截断了？**
单篇超过 24000 字符会截断并带 `truncated: true`。这是为了控制模型上下文体积，
属预期行为；可以让 AI 用关键词再检索相关段落。

**Q：有时看起来「返回 0 条」，像接口时好时坏？**
先看 `diagnostics.emptyReason` 与 `isError`。最常见的原因是客户端把 `limit`、`unread`
写成了字符串，或把 `list_entries` 的字符串 id 传给要求数字的 `get_entry` —— 当前版本
这些参数已全部容错。若仍看到 `Input validation error` 之类的**纯英文文本**（不是 JSON），
说明客户端把 `isError: true` 的失败响应当成空数据解析了：请按 `result.content[0].text`
解析、先判 `isError` 再取字段。另外 `/mcp` 是无状态的，不必补 `initialize` /
`initialized` 会话，跳过握手不会导致空结果（实测连续多轮均正常）。

**Q：数据是什么时候的？**
与网页同一套数据库，实时一致。频道的新条目到达时间取决于抓取计划
（全局或每频道设置的刷新间隔）。
