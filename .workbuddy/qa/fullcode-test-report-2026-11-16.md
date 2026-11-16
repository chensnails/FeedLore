# 当前代码全面测试报告（2026-11-16）

## 一、测试范围与目标

被测版本：`HEAD = 48e5a4c`（P1 回源优化 + P2 首屏优化 + AI 异步任务 + enable_thinking 全局开关），生产/演示站未动，测试机 `172.26.1.2:3210`。

聚焦最近三个提交引入的代码线（更早的 AI 动作条、性能专项已有独立报告）：

| 目标模块 | 关键路径 | 测试重点 |
|---|---|---|
| P1 回源 | `lib/feedCond.ts`、`lib/fetcher.ts`、`/api/feeds/refresh-progress` | 条件头判定口径、重试总预算、永久错误、304、降频倍数、dueFeeds |
| P2 首屏 | `vite.config.ts#inlineCriticalShell`、`index.html` 启动层 | 骨架同源抽取、热启动判断、FOUC、注入一致性 |
| AI 异步任务 | `lib/aiJobs.ts`、`/api/ai/jobs` | 状态流转、owner 隔离、活跃上限、提交校验、僵尸清扫 |
| 全局开关 | `packages/ai#chat` + `user_llm.thinking` | 双向下发、上游拒绝降级、任务链路一致性 |

**测试方式**：本地单测（node:test / jsdom）+ 测试机真库真网接口级测试（真实 Hono + better-auth + PostgreSQL + 假模型服务）+ 真实 Edge 浏览器工具。

## 二、新增测试用例

### 1. `apps/server/src/lib/fetcher.boundary.test.ts`（8 条，本地假源站）

| 用例 | 输入 | 预期 | 实际 |
|---|---|---|---|
| 慢源总预算 | 源站永不响应，`timeoutMs=400` | 总耗时被 `400+8000ms` 预算兜住，≤3 次请求，报 `E_FETCH_TIMEOUT` | 3929ms / 3 次 / `E_FETCH_TIMEOUT` ✅ |
| 永久错误 | 源站 401 | 只请求 1 次，不重试 | 1 次，`E_FETCH_HTTP_STATUS:401` ✅ |
| 5xx 重试 | 前两次 503、第三次 200 RSS | 重试到第 3 次成功 | 3 次，拿到 RSS ✅ |
| 304 命中 | 带 etag 请求，源站 304 | notModified，不触发降频 | ✅ |
| 条件头忽略 | 连续 3 次同 etag 回 200 | 该 host 降频 2× | ✅ |
| dueFeeds 倍数 | host 降到 4×，15 分钟前抓过、间隔 10 分钟 | 4× 内不到期，恢复后到期 | ✅ |
| feedIntervalMs 覆盖 | per-feed=15/0/-5/1e9 | 合法值覆盖，非法回退全局 | ✅ |

### 2. `entryAi.integration.test.ts` T40（真并发探针）

| 用例 | 输入 | 预期 | 修复前实际 | 修复后实际 |
|---|---|---|---|---|
| 8 并发提交 | 同一账号同时 POST 8 个任务 | ≤4 个 200，其余 429，落库 ≤4 | **5 个 200 / 3 个 429 / 落库 5** ❌ | **4 个 200 / 4 个 429 / 落库 4** ✅ |

## 三、发现的缺陷

### 缺陷 1（P2，已修复）：AI 任务活跃上限被并发竞态绕过

- **模块**：`apps/server/src/lib/aiJobs.ts#createJob`
- **严重度**：中。会导致同一账号瞬间发起超过 4 个并发模型调用，正好是需要上限来防的情形——连点或脚本并发可把模型网关打满、放大额度消耗。
- **根因**：原实现是 `count(active) >= 4 → 429` 检查通过后，再单独 `INSERT`。这是典型 check-then-act（TOCTOU）：多个并发请求几乎同时读到「未满」，全部通过检查再各自插入。
- **首次尝试失败**：改成单条 `INSERT … SELECT … WHERE count < 4 RETURNING` 仍不行——PostgreSQL READ COMMITTED 下每个事务看到自己的 snapshot，读不到其他并发事务尚未提交的新行，实测依旧放进 5 个。
- **最终修复**：用 PostgreSQL advisory lock 按 `userId` 派生锁键（`pg_advisory_xact_lock(hashtext(userId), 0)`），事务内「查计数 + 插入」对后续同账号事务可见；不同账号用不同锁键，互不阻塞。锁随事务结束自动释放。
- **复现步骤**：测试机真库，同一账号用 `Promise.all` 同时提交 8 个 `POST /api/ai/jobs`（假模型设慢响应以持续占用名额），统计 200/429 与落库任务数。
- **预期**：4 个 200、4 个 429、落库 4。
- **实际（修复前）**：5 个 200、3 个 429、落库 5。
- **回归测试**：T40 已固化，修复后 39/39 全过。

## 四、风险点（未发现缺陷，记录供后续关注）

1. **P2 热启动判断的边界**：`index.html` 用「带哈希资源 `transferSize === 0`」判热启动以跳过 350ms 保底。同源资源加载失败或浏览器不提供 Resource Timing 时，`transferSize` 也可能为 0，理论上会让冷启动少等一会儿（仅影响观感，不影响功能）。已有 try/catch 兜底为冷启动，风险低。
2. **condPenalties 的作用域**：条件头降频观测是进程内全局状态，通过 `/api/status`（admin 权限）暴露。多实例部署时各实例独立学习，且信息仅管理员可见，当前单容器部署无影响。
3. **骨架抽取依赖标记完整**：`inlineCriticalShell` 依赖 `style.css` 中 `CRITICAL_SHELL:START/END` 成对出现；若标记被误删，插件静默返回原 HTML（骨架不内联），首屏退回等待全量 CSS——功能不受影响，只是失去优化。已在 jsdom 加源码守卫。
4. **fetchFeedRaw 单源预算的时钟**：总预算基于墙钟 `Date.now()`，若系统时钟被大幅调整可能影响判定；实际部署中罕见。

## 五、修复建议与补充用例建议

### 已实施
- 缺陷 1 已修复并加回归测试 T40。

### 建议补充（本次未做，供后续排期）
1. **失败任务错误码的可翻译性**：T34 验证 error 带稳定码，但建议在前端 `errorText.js` 增加针对 `E_AI_JOB_RESTARTED`、`E_AI_BUSY` 的专门中文文案，并在浏览器层验证展示（目前是通用回退）。
2. **advisory lock 的超时/死锁观测**：建议在锁等待超过阈值时打一条 warn 日志，便于多账号高并发时排查；当前单用户场景无需。
3. **fetchFeedRaw 预算的可配置化**：`RETRY_EXTRA_MS=8000` 是硬编码，建议在采集参数页暴露为「单源重试总预算」，与 `timeoutSeconds` 并列，便于不同网络环境调优。
4. **P2 慢网的严格对比**：此前冷启动/慢网两组因 mock 服务 TTFB 波动，数据不作为严格收益结论。建议用固定 TTFB 的 mock 重测，给出可复现的冷启动 FCP/LCP 前后对比。

## 六、验证与结论

- 全仓 typecheck 0；web jsdom 647/647；服务端 39/39 接口级（真库，含新增 T40）；回源边界 8/8；前端单测 33；verify-dist 49；FOUC 核对通过；骨架双入口注入一致。
- 本次测试发现 **1 个真实并发缺陷（P2，已修复）**，其余模块在正常、边界、异常场景下均符合预期。**无高危缺陷**。
