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
5. **视图切换只有一份实现**：`.viewnav` + `ViewNav` 组件。桌面 / 平板由三视图各自顶栏右簇渲染；
   ≤720px 顶栏实例隐藏，由 `main.jsx` 挂载在视图之外的同一个组件停靠到视口底部（`.mobile-tabbar`）。
   不要另起一套 tab 或把切换塞回溢出菜单。
6. **启动收口不能只等渲染帧**：`bootstrap.js` 的 `bootReady`、`waitViewFirstPaint` 的末帧等待、
   `bootThemeAndView` 三处都得配 `setTimeout` 兜底。浏览器不给不可见页面排帧，只等帧的话
   12 秒看门狗会把「用户还在后台标签页」误报成「加载时间超出预期」，首屏主题也会拖到切过来才跳。

## 2. 布局骨架

| 区域 | 桌面（>720） | 窄屏（≤720） |
| --- | --- | --- |
| 频道栏 | 常驻侧栏（可拖宽、双击复位） | 抽屉：`body.reader-drawer-open` / `body.cards-drawer-open` 拉出 `.reader-side` / `.cards-side` |
| 顶栏 | 视图自带 Row1：≡ / 标题 / 搜索 / 视图导航 / 刷新 / 主题 / 设置 / ⋮ | 同结构，`.btn-label` 隐藏成图标（≤820），动作按钮收进 ⋮；视图导航移到视口底部（复用 `ViewNav`） |
| 阅读 | 正文在列表内展开（`.art-item.open`），不跳页 | 同左 |
| 卡片网格 | 自适应多栏（268px 起） | 最少 2 栏（≤720）：`min(160px, 50% - 半格)`；紧凑密度 140px 起，同样不掉成单栏 |

## 3. 主题与强调色

- 主题：`html[data-theme]` = `light` / `dark` / `github`，另有 `auto` 跟随系统。
- 强调色：`html[data-accent]`，6 档（默认蓝 / violet / teal / green / amber / rose）。
- 外观（主题 / 强调色 / 字号 / 文章密度 / 正文排版）只存本机 `localStorage['feedlore.appearance.v2']`，
  `index.html` 内联脚本在首帧前应用；登录页读同一键的 `theme` 字段。
- 列表密度（`listDensity`）与卡片密度（`density`）是两套独立两档，「文章密度」放在「界面」组里
  与「卡片密度」并排。它是结构性偏好，不是纯 CSS：`ReaderView` 订阅 `__appearanceChanged` 重绘整列。
  舒适（默认）渲染缩略图 + 两行摘要；紧凑直接不渲染 `<img>`（连首图请求都不发）与摘要，条目加
  `is-line`：标题单行省略、来源与时间并到同一行右侧、动作键垂直居中；**展开的那条不加**，
  正在读的文章仍按普通行式显示完整标题。
- 布局（视图 / 排序 / 侧栏宽度 / 折叠分组等）按账号保存，由服务端注入 `window.__LAYOUT__`。
  **不要把这套改成客户端 GET /api/prefs 再应用** —— 会闪一帧白；外观也不放账号，避免跨设备互相干扰。
- `manifest.json` 的 `theme_color` 必须与亮色 `--panel` 同色（现在是 `#ffffff`）：「添加到主屏幕」
  后宿主浏览器用它填 Home 指示条那一带，不一致就会在底部标签栏下面露出一条与页面无关的色带。
- `index.html` 有两条带 `media="(prefers-color-scheme: …)"` 的 `theme-color` 兜底（亮色在前），
  深色系统在 JS 跑起来之前也不会闪白；显式选了主题时由首屏内联脚本与 `syncThemeColor()` /
  `applyTheme()` 把所有条目一起改掉。运行时颜色取 `--panel`，与主题同源。

## 4. 设置页签

八个页签按信息架构分四组（`src/settings/tabs.js` 是唯一真源，外壳与命令面板共用）：

| 分组 | 页签 | 说明 |
| --- | --- | --- |
| 内容 | 数据源 / 规则 / 日报 | 订阅与抓取、关注屏蔽与过滤、日报生成 |
| 智能 | 模型 | 模型地址、Key、思考深度 |
| 账户 | 账号 / 外观 | 用户名密码与用户管理（管理员）、本机主题排版 |
| 系统 | 状态 / 关于 | 运行诊断（仅管理员）、版本与更新 |

- 导航顶部有「搜索设置」：按页签名称、描述、关键词过滤（命令面板 `⌘K` 复用同一份关键词）。
- 桌面（≥821px）左侧导航 `200px + 内容`；窄屏（≤820px）退化成「分区列表 → 分区内容」两级下钻，
  列表项带一句描述，进入分区后标题改成分区名 + 描述，返回键与 Esc 先回列表。
- 保存语义分三类，改动前先确认属于哪类：
  - 即时保存：频道行开关、频率、拖拽排序等，改完即落库；
  - 底部保存 + 脏跟踪：采集参数 / 规则 / 过滤 / 日报 / 账号 / 模型；无改动时保存按钮禁用；
  - 纯展示：外观（存本机，点了即生效）、状态、关于。
- 有未保存改动时，标题旁出现「未保存」、当前页签出现圆点；切页签或关闭会先弹「放弃未保存的更改？」。
  面板通过 `onDirtyChange` 上报，外壳用 ref 立即记录，避免被动副作用晚一拍漏拦。
- 规则「适用范围」浮层挂在 body 上，随页面/面板滚动用 rAF 重新定位；触发按钮滚出可视区即收起。
- 「账号 → 登录设备」列 `GET /api/sessions`：只给浏览器 / 系统、IP、最近活跃等展示字段，
  **会话 token 永不下发**；本机由服务端按当前 Cookie 标记，可逐台退出或一键退出其它设备。
  本机退出仍走「退出登录」（服务端对 `DELETE /api/sessions/:id` 的本机 id 返回
  `E_CANNOT_REVOKE_CURRENT`）。
- 「账号 → 数据导出」下载 `GET /api/export`（流式 tar.gz）：含订阅源、文章（含已读 /
  收藏 / 关注标记）、日报与偏好；不含会话、图片与全文抓取缓存。模型 Key 默认不打包，
  勾选后额外写 `llm.json`（明文，界面必须提示）。只读账户也能导出**自己**的数据。
- 「账号 → 整站备份」仅管理员可见，走危险确认后下载 `GET /api/backup`；包含所有账号
  （含密码哈希）、站点设置与图片缓存，界面文案必须标明「敏感文件」。同一时间只允许
  一份备份，重复请求返回 `E_BACKUP_IN_PROGRESS`（409）。
- 「账号 → 数据导入」把导出包上传到 `POST /api/import`（原始 `application/gzip` 请求体，
  不套 multipart）。合并语义：频道按 URL、文章按 (频道, guid)、日报按 (账号, 日期) 去重，
  只补缺行；**已存在文章的已读 / 收藏 / 关注保持现状**，偏好只在账号还是空偏好时套用。
  模型配置也只补空（服务端回 `llm` 四态：`applied` / `already-configured` / `url-blocked` /
  `absent`，界面逐种说明），只读账户不展示入口（服务端也拒绝写）。
- 「账号 → 整站还原」仅管理员可见，上传整站备份到 `POST /api/restore`。这是**替换**：
  事务内清空业务表再按原 id 写回，旧会话全部失效，成功后跳登录页。两次危险确认必须保留；
  与账号导入 / 备份互斥，冲突返回 `E_RESTORE_IN_PROGRESS`（409）。
- 下载统一走 `core.downloadUrl()`（临时 `<a>` 点击），文件名由服务端的
  `Content-Disposition` 决定，前端不硬编码；上传统一走 `core.uploadArchive(url, file)`。
- 折叠分组 / 结果提示 / 底部动作栏统一用 `src/settings/primitives.jsx`（`Section` /
  `Result` / `PaneFoot`）。新面板不要再另抄一段 `details.sec` 或 `pane-foot`，
  否则标题层级、间距与保存栏会再次各走一套。类名与 `data-sec` 仍是原样，样式与
  折叠状态持久化不受影响。

## 5. 守门（改完必须全绿）

```bash
corepack pnpm --filter @feedlore/web run build     # 构建
node scripts/verify-dist.mjs                       # 产物事实：PWA / 哈希 / CSS 关键规则 / 模糊预算
corepack pnpm --filter @feedlore/web run test      # jsdom UI 回归（453 项）
corepack pnpm -r run test                          # 契约 + 服务端
```

真机冒烟（需先部署到测试环境）：`node scripts/ui-smoke.mjs <url> <user> <pass>`。
