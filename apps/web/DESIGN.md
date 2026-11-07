# 笺川 v2 · 界面约定

> 适用范围：`apps/web`。
> 前端沿用 v1 的交互与界面（整体搬入，未重设计）。权威实现：
> - 样式分两层：`apps/web/src/style.css`（历史布局层，顶部有断点索引，改之前先读）
>   + `apps/web/src/hig.css`（Apple HIG 视觉系统层：令牌 / 材质 / 圆角 / 反馈 / 控件形态）。
>   后者由 `main.jsx` 在前者**之后**导入，靠「后写者胜」覆盖视觉声明，不复制任何布局规则。
>   登录页是独立入口，只加载 `login.css`，其末尾带一份同源的简化视觉层。
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
6. **启动收口不能只等渲染帧，也不能等数据**：`bootReady`、`waitViewFirstPaint` 的末帧等待、
   `bootThemeAndView` 三处都得配 `setTimeout` 兜底（后台标签页不排帧，只等帧会被看门狗误报）。
   但**启动层只负责「外壳已渲染」**：`bootstrap.js` 不得 `await` 任何列表请求，视图切完就
   `bootReady()`，数据的骨架 / 失败态 / 重试留在应用内。旧实现在卡片页 `await loadPage(true)`，
   弱网请求一悬挂，整条启动链就到不了 ready，12 秒看门狗报「加载时间超出预期」并盖住整页，
   连应用内带「重试」的错误空态都渲染不出来（浏览器实测复现）。
   现在看门狗放宽到 20 秒，且 `.is-error` 状态不吃点击、不锁滚动，最坏情况也不会把页面锁死。
   请求层统一在 `core/util.js`：GET 单次 8 秒 + 一次幂等重试，写操作 30 秒且绝不自动重试；
   上传归档 / RSS 刷新等长任务显式给 `timeoutMs`。两页列表各带 controller / generation，
   「重试」必须能打断悬挂请求，旧的慢响应不得覆盖新列表；切页与自动刷新都要有互斥，避免弱网叠请求。
7. **样式两层，各管一件事**。`style.css` 管骨架 / 断点 / 几何 / 状态类名；`hig.css` 管设计令牌、
   材质、圆角、字阶、按压反馈、控件形态。视觉层**不改** grid 列数、`--hit-min`、字号下限、
   断点数值，也不新增 `backdrop-filter`（模糊预算仍是 4 条）。颜色一律用 `color-mix()` 从现有
   主题变量派生，自动适配 light / dark / github × 6 档主色，别在视觉层复制一套色板。
   焦点环保持 2px 实色 `--accent`，次要文字禁用 opacity 弱化。移动端覆盖规则必须写进
   `@media (max-width:720px), (max-height:500px) and (pointer:coarse)` 同一个断点里。
8. **展开文章的置顶按实测吸顶高度让位**。`core/reader.js#readerHeadOffset` 每帧量
   `.reader-head` / `.chan-tabs` / `.view-toolbar` 的底边，写回 `--reader-sticky-offset`，
   CSS 的 `scroll-margin-top` 与它同源。**不要再读静态 `--head-h`**：窄屏头部是两行
   （工具行 44 + 频道条 44 = 88），令牌仍写 44，实测会少算一行、把展开标题盖住 35px，
   看起来就像「标题被划过头」。频道条出现、横屏压缩、搜索换行都由实测自动跟随。
9. **设置表单的异步回填不许覆盖用户输入**。面板一挂载就 GET `/api/prefs`，用户在响应
   回来前完全可能已经开始改。统一用 `settings/primitives.jsx#useFormLoadGuard`：输入时
   `mark()`，回填时 `apply()`；`apply` 返回 false 就跳过 `setForm` / `setSaved`，
   脏态基线仍按初始值算。模型面板保存 / 清除成功后的主动重拉走 `load(true)` 绕过守卫，
   否则掩码态刷新不回来。日报、模型两个表单型面板都已接入，新增面板照此办理。
10. **非登录输入框不许被账密自动填充**。登录页保存的凭据会被 Chrome / Edge Android
    启发式忽略 `autocomplete="off"`，填进同源页面里任何文本框（设置搜索框冒出 `admin`
    就是这么来的）。所有搜索 / 过滤 / 关键词输入统一 spread
    `ui/noAutofill.js#NO_AUTOFILL_PROPS` + `useNoAutofillName()`；全局哨兵在 `main.jsx`
    一处安装，`hig.css` 的 `:-webkit-autofill` 规则负责背景重置与哨兵动画。
    **登录、改密、新建用户等凭据字段不要接** —— 密码管理器在那儿是正确行为。
11. **移动端贴底弹层只有一个手势实现**。`views/useSwipeDismiss.js` 用原生
    `{ passive: false }` 的 `touchmove` 接管下拉（React 的被动监听拦不住 Android 下拉刷新），
    面板必须接 `setPanelRef` 这个 callback ref：弹层常是打开时才挂载，普通 ref 会让
    监听绑在 null 上。抓手 / 头部可直接拖，正文区要先滚到顶；关闭判据是距离或
    `FLICK_MIN_MS` 之后的快甩。`onDismiss` 返回 `false`（如设置的「放弃更改」被取消）时
    面板回弹，新增弹层不要另写一套 touch 逻辑。
12. **长文一次铺开，退出全靠吸顶标题条**。正文不折叠（v2.5.2 起移除 `.art-clip` 与
    「展开全文」）：点开即全文，不再要求用户先做一次「要不要读完」的选择，也不再有
    两层「收起」语义互相干扰。展开态 `.art-row` 吸附的 `top` 用 `--reader-head-h`
    （头部底边），**不要用 `--reader-sticky-offset`** —— 那个多留了 8px，正文会从缝里
    漏出一条，看起来像标题行浮在正文中间。同时必须放开 `.art-item.open` 的
    `overflow: hidden` 与 `content-visibility: auto`：两者都生成 containment，
    sticky 会被关在卡片里、只跟着卡片滚。吸顶条上的「收起这篇」（`.art-collapse`）
    收起整条卡片并滚回本条标题；卡片详情不另造出口，用常驻的右上角 ×、Esc 与手势关闭，
    正文和动作行都和文章页共用同一个 `ArtBody`。
13. **固定按钮随滚动方向收起，且只收按钮、不收标题**。判据只有一份：`ui/scrollChrome.js`
    的 `createChromeTracker`。文章页（宿主 DOM，不在 React 树里）由 `mountScrollChrome()`
    在 `.reader-main` 上打 `.is-chrome-down`，收起吸顶工具条里的工具按钮与展开态标题行
    右侧的「收起这篇 / 收藏」；卡片详情用 `useScrollChrome` 给 × 挂 `.is-chrome-hidden`。
    三条硬约束：①判据是**累积位移**（向下攒 24px 收、向上 6px 就回），不是单次事件——
    一次滚轮 tick 就是 40–120px，按单次判定会闪；②**贴顶 32px / 到底 32px 强制显示**，
    这两个时刻用户最想找出口，不能让「收起这篇」和 × 还要先上翻一下；③一帧跨过整屏
    （拖滚动条、深链定位、内容变短）**不判方向**，只跟基准。
    隐藏必须同时写 `visibility: hidden` + `pointer-events: none`（visibility 延后到淡出
    结束），只写 `opacity: 0` 的话按钮仍能被 Tab 到、被盲点中，比不隐藏更糟。
    **标题、频道条、吸顶条本身一律不动**：标题是「我在读哪一篇」的定位信息；吸顶条真上移
    还会改 `--reader-head-h` 的实测高度，sticky 顶边与 `scroll-margin-top` 都要跟着重算。

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
- 列表密度（`listDensity`）与卡片密度（`density`）是两套独立两档、**默认都紧凑**，「文章密度」
  放在「界面」组里与「卡片密度」并排。它是结构性偏好，不是纯 CSS：`ReaderView` 订阅
  `__appearanceChanged` 重绘整列。文章条目恢复为圆角卡片行（面板底 + 细边 + `--elevation-1`
  轻阴影 + 12px 圆角，卡片间 12px 间距；悬停抬到 `--elevation-2`，与卡片 / 行同一套手感），
  行首是未读圆点与展开箭头（展开转 90°）。紧凑直接
  不渲染 `<img>`（连首图请求都不发）与摘要：桌面压成单行（标题省略、来源时间并到右侧、动作键
  垂直居中，`is-line`），≤720px 手机放宽成两行（标题最多两行，来源时间在下一行）；**展开的
  那条不加 `is-line`**，正在读的文章仍显示完整标题。舒适渲染右侧缩略图 + 两行摘要。
  触屏上列表动作是 44×44：手机两行卡把让位给整列文字，已读行的星标 / 标未读竖排成一列
  （横排两枚要吃掉 106px，会把来源挤到第二行），舒适行式的无图已读行与粗指针平板的紧凑
  单行则加宽元信息的右让位。
- 手机底部视图栏是 48px 高的悬浮胶囊：按钮仍是 44×44 触屏命中（只收外框，不收手指落点），
  图标 18、文字 10px、两侧各 16、距底 6，总占位 54px。toast、回顶钮与三个滚动容器的底部留白
  全部从 `--tabbar-h` 派生，调高度只改令牌，不要在四处各写一个数。
- 浮层（底栏 / 抽屉 / 回顶钮 / 浮标）统一用 `--float-shadow` 双层柔光 + `--float-hi` 顶部高光，
  **不给 fixed 表面加 `backdrop-filter`**。模糊只留给两个全屏遮罩：走 `--glass-blur`（16px）
  + `saturate(1.4)`，声明条数仍是 4（两遮罩 × webkit 双写），`verify-dist` 守着这个预算。
  日报卡继续用拟态表面（`--surface-soft` + `--neu-2`）：它只有几张大块阅读卡，与长列表的
  「薄边 + 一层浅影」性质不同；文章 / 卡片 / 列表行保持扁平，不在末尾拟态块里统一反盖。
- 频道条与底栏遵循同一条「再点当前项回顶」：筛选没变时不重绘列表，只把视线带回顶部。
- 布局（视图 / 排序 / 侧栏宽度 / 折叠分组等）按账号保存，由服务端注入 `window.__LAYOUT__`。
  **不要把这套改成客户端 GET /api/prefs 再应用** —— 会闪一帧白；外观也不放账号，避免跨设备互相干扰。
- 清单只有一份，`theme_color` / `background_color` 固定为暗色 `--bg`（`#242424`）。
  「添加到主屏幕」后宿主壳的底栏颜色取自清单，且只在安装 / 后台刷新时重读——页面 CSS 和运行时
  都改不了，换主题也不会跟着变。所以别做「按主题切清单」：装的时候是什么主题就固定成什么色，
  反而会出现「浅色模式下黑条」。现在恒用深色：暗色下不留白条；浅色下是一条刻意的深色底栏，
  与系统状态栏（仍由 `meta theme-color` 按当前主题走）互不影响。
  Android Chrome 的 WebAPK 实测会把清单色画到底部导航条（2026-11 真机确认），但这条由宿主 /
  厂商实现决定，网页只能提供颜色、不能强制。改动颜色后**已装的图标要删掉重装**。
- 清单颜色取 `--bg` 而不是 `--panel`：底栏是悬浮的，栏下方与页面顶部露出的都是页面底色，
  取面板色会在状态栏和底栏下各差一档灰。
- `index.html` 有两条带 `media="(prefers-color-scheme: …)"` 的 `theme-color` 兜底（亮色在前），
  深色系统在 JS 跑起来之前也不会闪白；显式选了主题时由首屏内联脚本与 `syncThemeColor()` /
  `applyTheme()` 把所有条目一起改掉。运行时颜色取 `--bg` 的计算值（`ui.js` / `state.js` 同源），
  三套主题只剩 CSS 一处真源。另有一条 `<meta name="color-scheme" content="light dark">`，
  只管样式表到达前画布 / 滚动条 / 表单控件的默认色；逐套主题的 `color-scheme` 仍由 CSS 给。

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
corepack pnpm -r run typecheck                     # 类型
corepack pnpm --filter @feedlore/web run build     # 构建
node scripts/verify-dist.mjs                       # 产物事实：PWA / 哈希 / CSS 关键规则 / 模糊预算（49 项）
DATABASE_URL='' corepack pnpm -r run test          # 契约 + 服务端 + jsdom UI 回归（520 项）
node .workbuddy/ui-lab/verify.mjs --only=all --shots --no-build
  # 真实浏览器：计算样式 / 几何 / 对比度 / 内核 / HIG / 手势 / 自动填充 / 长文一次铺开（文章页 + 卡片页）/ 滚动收起 / 多视口截图（83 项）
node .workbuddy/ui-lab/weaknet.mjs --scenario=all  # 弱网专项：悬挂 / 慢响应 / 503 / 连点（14 项）
node .workbuddy/ui-lab/geometry.mjs                # 展开文章后标题与吸顶头部的遮挡量
```

两套浏览器脚本用不同 CDP 端口（9336/9337、9346/9347、9356/9357），**串行跑**更稳。
`ui-lab/` 下的脚本与截图不入库，属本地验证工具。

真机冒烟（需先部署到测试环境）：`node scripts/ui-smoke.mjs <url> <user> <pass>`。
