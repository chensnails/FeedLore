# 笺川 v2 · 界面约定

> 适用范围：`apps/web`。
> 前端沿用 v1 的交互与界面（整体搬入，未重设计）。权威实现：
> - 样式：`apps/web/src/style.css`（顶部有断点索引，改之前先读）
> - 视图：`apps/web/src/views/`（文章 / 卡片 / 日报三视图）
> - 逻辑单例：`apps/web/src/core/`（`@core` 别名）
> - 设置：`apps/web/src/settings/`（8 个页签）

---

## 1. 改界面时先确认的几条硬规矩

1. **断点就近写，不要合并**。`style.css` 里的响应式规则是按功能就近放置的，同一断点分多段；
   收成一段会改变层叠结果（实测 181 处偏差）。新增规则先 `grep -n '@media (max-width: 720px)'`
   看段数与位置，并注意同特异度下「后写者胜」。
2. **触屏没有 hover**。只在 hover 出现的控件在手机上等于不存在；用 `@media (hover:none)` /
   `pointer:coarse` 做能力查询，不按宽度猜设备。产物校验会检查这两条查询还在 CSS 里。
3. **玻璃模糊只给静止表面**（`.modal-mask` / `.cmdk-mask`）。sticky / fixed 的长列表元素
   禁用 `backdrop-filter`：每帧重采样必掉帧，这是 v1 实测换来的规矩。
4. **字号与栏宽走令牌**：`--reader-fs` / `--reader-width` / `--reader-side-w`；
   设置里的「字号 / 栏宽」开关直接写这些变量，写死数值会让开关变成死的。
   Row1 的实测高度由 JS 写入 `--topbar-h`，供吸顶元素对齐。
5. **视图切换只有一份实现**：`.viewnav` + `ViewNav` 组件，三视图各自顶栏右簇渲染它。
   不要另起一套 tab 或把切换塞回溢出菜单。

## 2. 布局骨架

| 区域 | 桌面（>720） | 窄屏（≤720） |
| --- | --- | --- |
| 频道栏 | 常驻侧栏（可拖宽、双击复位） | 抽屉：`body.reader-drawer-open` / `body.cards-drawer-open` 拉出 `.reader-side` / `.cards-side` |
| 顶栏 | 视图自带 Row1：≡ / 标题 / 搜索 / 视图导航 / 刷新 / 主题 / 设置 / ⋮ | 同结构，`.btn-label` 隐藏成图标（≤820），动作按钮收进 ⋮ |
| 阅读 | 正文在列表内展开（`.art-item.open`），不跳页 | 同左 |
| 卡片网格 | 自适应多栏（268px 起） | 最少 2 栏（≤720）：`min(160px, 50% - 半格)`；紧凑密度 140px 起，同样不掉成单栏 |

## 3. 主题与强调色

- 主题：`html[data-theme]` = `light` / `dark` / `github`，另有 `auto` 跟随系统。
- 强调色：`html[data-accent]`，6 档（默认蓝 / violet / teal / green / amber / rose）。
- 首屏由服务端注入 `window.__APPEARANCE__` / `__LAYOUT__`，`index.html` 内联脚本在首帧前应用；
  登录页无注入，回落默认值。**不要把这套改成客户端 GET /api/prefs 再应用** —— 会闪一帧白。

## 4. 设置页签

`数据源 / 规则 / 模型 / 日报 / 账号 / 外观 / 状态 / 关于`。
采集相关在「数据源」（全局间隔 + 每频道覆盖），用户管理在「账号」（仅管理员），
「状态」仅管理员可见。

## 5. 守门（改完必须全绿）

```bash
corepack pnpm --filter @feedlore/web run build     # 构建
node scripts/verify-dist.mjs                       # 产物事实：PWA / 哈希 / CSS 关键规则 / 模糊预算
corepack pnpm --filter @feedlore/web run test      # jsdom UI 回归（377 项）
corepack pnpm -r run test                          # 契约 + 服务端
```

真机冒烟（需先部署到测试环境）：`node scripts/ui-smoke.mjs <url> <user> <pass>`。
