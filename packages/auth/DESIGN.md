# @feedlore/auth 设计文档（v2 P1）

> 状态：设计已锁定（P0 决策会议），脚手架已可编译。真正落地在 **P3**（packages/db 的 auth schema 就绪后）。

## 1. 选型结论

采用 **better-auth**（Hono 适配器 + Drizzle 适配器 + admin/username/openAPI 插件）。

替代方案与落选原因（已在 P0 决策会议确认）：
- 保留自研 HMAC：零迁移，但认证是已被业界解决的高危域，长期自维护是债；与「工程化 + 大量 AI 能力」目标相悖。
- 其他库（Lucia 已归档、Clerk/Auth0 等 SaaS）：自托管场景不适合引入外部依赖。

better-auth 契合点：
- 会话/令牌/角色 machinery 交给持续维护、被审计的库，少一类回归（与「修复 SSRF 交给 `lib/net.js`」同一工程纪律）。
- 有官方 **Hono 适配器**与 **Drizzle 适配器**，可干净落进 `packages/auth` + `packages/db`。
- `admin` 插件直接提供 `/api/auth/admin/*` 与 `user.role` 列，省掉手写角色竞态（对应 legacy 那条「`state.role` 必须在 `fetch('/api/session')` 之后才赋值」的坑）。
- 未来 OAuth / 2FA / 多用户开箱即得。

## 2. 集成骨架（已落地 `src/index.ts`）

```ts
const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg' }),   // db 来自 packages/db（NodePgDatabase）
  secret: process.env.AUTH_SECRET!,                   // 对应 legacy 的 sessionSecret
  baseURL: process.env.BETTER_AUTH_URL!,
  trustedOrigins: [process.env.FRONTEND_URL!],
  emailAndPassword: { enabled: true, minPasswordLength: 4 },
  plugins: [username(), admin(), openAPI()],
  advanced: { defaultCookieAttributes: { secure: true, httpOnly: true, sameSite: 'none' } },
});
```

Hono 挂载（P3 在 `apps/server`）：

```ts
app.on(['GET', 'POST'], '/api/auth/**', (c) => auth.handler(c.req.raw));
// 会话注入中间件
app.use('*', async (c, next) => {
  const s = await auth.api.getSession({ headers: c.req.raw.headers });
  c.set('user', s?.user ?? null);
  c.set('session', s?.session ?? null);
  await next();
});
```

类型：`auth.$Infer.Session` 在每处 handler 给出类型化 user/session，无需手写 `interface User`。

## 3. 用户表映射（迁移关键）

legacy `users` 表字段：`id, username, password_hash, salt, role, prefs(jsonb), created_at`。

better-auth 用自有 schema（`user` / `session` / `account` / `verification`），通过 `npx @better-auth/cli generate` 生成 Drizzle 表定义，再 `drizzle-kit migrate`。需要保留/对齐：

| legacy 字段 | 落点 |
|---|---|
| `id` | better-auth `user.id`（建议保留原值，避免外键重建） |
| `username` | better-auth `username` 插件列（非 email） |
| `role` | **admin 插件的 `role` 列**（不再手写）；`isAdmin()` 被 `requireAdmin` 中间件取代 |
| `prefs` | 保留为 `user.prefs` JSON 列（外观/布局/过滤/关注/屏蔽/日报/llm 配置都在此） |
| `password_hash` + `salt` | **迁移难点**，见第 6 节 |

`prefs` 中的 `llm` 字段（每用户加密 API Key）**不进 better-auth**，见第 4 节。

## 4. 每用户加密 LLM Key（业务域，better-auth 不碰）

legacy 的 `users.prefs.llm.apiKey` 是加密存储的，这是 FeedLore 业务域，认证库不管。设计：

- 移到独立侧表 **`user_llm`**（`user_id PK, encrypted_key, base_url, model, thinking, thinking_depth, updated_at`），由 `packages/ai` 管理读写与加解密。
- `resolveUserLlm`（用户 > 站点回退）逻辑保留在 `packages/ai`，调用层在生成日报/测试模型时取用。
- `/api/prefs` 的 `llm` 字段仅负责「用户配置入口」，落库时转存 `user_llm`；GET 视图回显 `apiKeySet: boolean` 而非明文（contract 的 `LlmViewSchema` 已如此定义）。

## 5. 登录限流（抗枚举）

legacy 的 `loginKey = ip|username` + 指数退避（60s→15min，有上限）+ Map 清扫，必须保留其「**用户名不存在也走一次哈希**」的抗枚举行为。两种接法：
- 简单：better-auth 前置中间件复用 legacy 限流逻辑（推荐，行为可控）。
- 或：better-auth 自带 `rateLimit`，但默认不覆盖「伪用户名也走哈希」，需配合 `onAPIError` 钩子补足。

P3 实现时优先前者，限流状态存进程内存（单实例部署足够），后续如需多实例再换 Redis。

## 6. 密码哈希迁移（最大坑）

legacy `hashPassword` = `sha256(salt + password)`（自定义，非标准 KDF）。better-auth 默认用 scrypt/argon2。**两种迁移策略**：

- **A（推荐，最安全）**：首次切换时**强制所有用户重设密码**（管理员在迁移脚本里重置，普通用户走「忘记密码」）。彻底摆脱自定义哈希，零兼容包袱。FeedLore 当前单管理员 + 少量用户，代价可接受。
- B（兼容）：把 legacy `password_hash`+`salt` 迁到 `user` 表保留列，写 better-auth 自定义密码验证器适配。复杂度高、且赖掉「换更强 KDF」的安全收益，不推荐。

→ P3 采用策略 A。

## 7. 安全属性对齐

- Cookie：`secure + httpOnly + sameSite='none'`（SPA 跨域），与 legacy `applySecurityHeaders` 收敛一致；同源部署可改 `lax`。
- 所有 better-auth 之外的出网口（订阅/OPML/图片代理/webhook/模型地址）仍走 `lib/net.js` 的 `assertPublicHost`+`safeFetch`——**SSRF 三条铁律（198.18/15 注记、IPv6 前缀、DNS 钉定回调三形态）原样保留进 `packages/net`**。
- 登录/会话错误文案收敛，5xx 不回吐内部信息（沿用 `classifyError`）。

## 8. 与其他包的关系

- `packages/contract`：prefs / account / users 等端点 schema 已就绪；auth 落地后 `/api/prefs` 不变，仅鉴权来源从自研 HMAC 换为 better-auth。
- `packages/db`：提供 `NodePgDatabase` 实例与 auth schema（P3）。
- `packages/ai`：消费 `user_llm` 与 `resolveUserLlm`。
- `apps/server`：挂载 `auth.handler` 与会话中间件（P3）。
- `apps/web`：用 `createAuthClient({ baseURL })` 替换 legacy 登录表单，`useSession()` 取代 `getSession` 轮询。

## 9. P3 实现清单（待办）

- [ ] `packages/db` 加 `auth-schema`（better-auth CLI 生成 + `role`/`prefs`/`user_llm` 列）
- [ ] `drizzle-kit` 迁移；一次性数据迁移脚本（策略 A：重置密码）
- [ ] `apps/server` 挂载 `auth.handler` + 会话中间件 + `requireAdmin`
- [ ] 登录限流中间件（复用 legacy 逻辑）
- [ ] `apps/web` 接 `createAuthClient`，替换登录/会话
- [ ] 端到端：真实抓取 + 登录 + 限流误伤验证（沿用 P1 定的「真实路径」原则）
