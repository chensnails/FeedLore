# 笺川 UI 全面审查报告（v1.1.12）

审查对象：按钮 / 弹窗 / 表单控件 / 提示反馈（Toast、校验文案）/ 图标 / 分割线 / 卡片 等组件。
检查维度：配色与色值、字号字重、圆角、阴影、边框、内外间距、尺寸高度、交互状态（hover / active / focus / disabled）、动效时长、明暗主题一致性。

**修复原则**：只改样式，不动功能逻辑与交互行为；优先复用已有变量，新增令牌而非硬编码。
主要文件：`public/style.css`（令牌区 / 组件区 / 拟态玻璃区）、`src/**/*.jsx`（少量行内样式）、`src/core/state.js`、`src/core/ui.js`（主题元数据）。

---

## 一、明显异常（P0）— 影响可用性或主题正确性，本次已修复

| # | 位置 | 问题 | 原因 | 处理 |
|---|---|---|---|---|
| 1 | `.btn`（style.css 按钮区） | **按钮无禁用态**：`:disabled` 全站仅 3 处零散规则（`.btn-copy:disabled`、`.src-img-cache .btn-ghost:disabled`、`.feed-icon-btn:disabled`） | 历史按需补样式，没建统一状态层；刷新中禁用的「刷新」「加载更多」「保存」看起来和可点态一样 | 新增 `.btn:disabled / [disabled] / [aria-disabled]` 统一降透明（`--disabled-opacity`）+ `not-allowed` + 屏蔽 hover/active，并按 primary/ghost/danger 保持各自底色 |
| 2 | `:focus-visible` 统一焦点环（style.css 无障碍区） | **键盘焦点被抹掉**：先有全局 `outline`，紧接着把 `input/textarea/.btn/.seg-btn/.swatch/.viewnav-btn/.viewmode-btn/.ainav-btn/.tab` 全部 `outline:none`，而这些控件大多没有自有焦点样式 | 注释假设「控件自家已有聚焦样式」，实际只有输入框有；Tab 到按钮 / 分段控件 / 色块 / 视图切换**完全没有可见焦点** | 仅对 input/textarea 关 outline；其余改用统一光环 `box-shadow: 0 0 0 3px var(--focus-ring)` |
| 3 | `.switch`（设置项开关） | **开关无焦点反馈**：`input` 被 `opacity:0` 隐藏，聚焦时界面无任何提示 | 隐藏输入 + 未转嫁焦点态到滑块 | 新增 `.switch input:focus-visible + .switch-slider` 光环 |
| 4 | `.shortcuts-*`（原快捷键浮层段，约 40 行） | **死样式残留**：v1.1.7 已把快捷键浮层改为「设置 → 帮助」，但样式段仍在，且全是 `var(--x, #222)` 形式的硬编码回退色 | 改动时只删了组件与桥接，漏删样式 | 整段清理；其中仍被命令面板使用的 kbd 样式保留并令牌化为 `.cmdk-foot kbd` |
| 5 | 下拉遮罩、灯箱、图片压暗层、卡片阴影 | **硬编码色值绕过主题**：`rgba(15,18,24,.38)`、`rgba(8,10,14,.9)`、`rgba(255,255,255,.72)`、`rgba(10,12,16,.46/.42)`、`0 2px 6px rgba(0,0,0,.28)` | 新功能直接写死 rgba，未走令牌 | 改为 `--overlay` / `--lightbox-bg` / `--lightbox-text` / `--dim` / `--shadow-sm`，随主题走 |

## 二、轻微偏差（P1）— 风格不统一，部分已修、部分列为待办

| # | 位置 | 问题 | 状态 |
|---|---|---|---|
| 6 | 全站 `border-radius` | **圆角无刻度**：统计到 18 种取值（10px×18、9px×17、8px×15、7px、6px、11px、5px、4px、2px、20px、14px、12px、16px、24px…），`--radius:14px` 只被引用 9 次；弹层 16px、按钮 10px、输入框 9~11px 各自为政 | 已收敛为 5 级令牌 `sm/md/lg/xl/pill`，并在按钮、小按钮、弹层、关闭按钮、输入框、下拉、Toast、结果条上替换 |
| 7 | 全站 `font-size` | **字号无阶梯**：出现 0.625 / 0.6563 / 0.6875 / 0.7188 / 0.75 / 0.7813 / 0.8125 / 0.8438 / 0.875 / 0.9063 / 0.9375 / 1.0313 / 1.0625 / 1.125 / 1.25 / 1.375 / 2.125 / 2.5 / 2.625rem；另有 **15px / 16px / 17.5px 三个 px 值**，不随 `html` font-size 缩放，破坏「全站 rem」约定 | 已定义 7 级字号阶梯并替换主要组件；**px 值待清理**（改动面较大，需逐个核对视觉） |
| 8 | 全站 `transition` | **动效时长散乱**：.12/.14/.15/.16/.18/.2/.22/.26/.4s 共 9 档，且大量 `transition: all`（无关属性也参与过渡，滚动/重绘更费） | 已定义 `--dur-fast/base/slow` + `--ease`，按钮/弹层/Toast/输入框/结果条改为具体属性 + 令牌时长 |
| 9 | `.toast.ok::before` | **Toast 用字符图标** `content:"✓"`，与文件顶部「全部图标走 sprite、不用字符图标」的约定冲突（各平台字形/基线/粗细不一） | 待办：需改 JSX 加 SVG，属标记改动，本次按「只改样式」未动 |
| 10 | 分割线 | **三种并存**：`1px solid var(--border)`（默认）、`1px dashed var(--border)`（卡片描述区）、`6px solid var(--text-muted)`（设置页分组），未令牌化 | 待办：建议统一为 `--divider` 粗细/样式令牌 |
| 11 | 表单校验 | **输入框无错误态**：无 `:invalid` / `.is-invalid` 样式，校验反馈只靠 `.test-result` / `.hint` 文案，出错时输入框本身无红边 | 待办：建议加 `.is-invalid`（`--danger-border` + `--err-bg`） |
| 12 | `src/ai/AiView.jsx`、`src/settings/*.jsx`、`src/shell/TopBar.jsx` | **行内硬编码**：`color:'#b7791f'`（降级提示）、多处 `style={{padding:10/20}}`、logo 内 `fill="#ffffff"` —— 不随主题 | 待办：改为 `var(--warn-text)` 等令牌 / 加语义类 |
| 13 | `src/core/state.js`、`src/core/ui.js` | **主题元数据硬编码**：`#242424` / `#ffffff` / `#171b22` / `#1f6feb`（theme-color、GitHub 固定主色） | 建议保留（浏览器 meta 不支持 var），但应与主题常量表同源 |

## 三、优化建议（P2）

1. **间距刻度**：当前 4/6/8/10/12/14/16/18/20/22/24px 混用，建议收敛为 4 的倍数：`--sp-1:4 --sp-2:8 --sp-3:12 --sp-4:16 --sp-5:20 --sp-6:24`，组件 padding/margin/gap 一律取刻度。
2. **阴影层级命名**：现有 `--shadow / --shadow-sm / --shadow-hover / --shadow-lg / --shadow-toast` + 拟态 4 档（`--neu-shadow*`）共 9 种，命名无层级感，建议改为 `elevation-1..4` + `neu-1..3`，并明确「静态容器用 elevation、可滚动元素用 neu（无模糊）」。
3. **弹层动画复用**：`fadeIn .16s` / `popIn .18s` / `ddFade .18s` / `ddUp .22s` 各写各的，统一到 `--dur-base` + `--ease`。
4. **危险/成功/警告色板补齐**：`--ok/--err/--warn` 中 `--warn` 缺 border 变体、`--danger` 缺「反色底上的文字色」，建议三色都补齐 bg/border/text 三件套。
5. **状态叠加约定**：明确「禁用=降透明 + 禁光标」「hover=提一层阴影/换底色」「active=内凹阴影 + 位移 1px」「focus=3px 光环」四种叠加规则，避免各控件自创反馈方式。
6. **图标**：确认所有图标尺寸走 `1em` + `font-size`，避免 `.ico` 上出现 px 宽高覆盖（现有少量 14px/15px/17px 覆盖，建议改为 em）。

---

## 四、可复用的统一设计规范（建议落地为准）

```css
/* 圆角：5 级即可覆盖全站 */
--radius-sm: 8px;  --radius-md: 10px;  --radius-lg: 14px;  --radius-xl: 16px;  --radius-pill: 999px;

/* 字号：7 级阶梯（rem，随 html font-size 整体缩放） */
--fs-2xs:.6875rem; --fs-xs:.7188rem; --fs-sm:.75rem; --fs-md:.8125rem;
--fs-base:.875rem; --fs-lg:.9375rem; --fs-xl:1.0625rem;

/* 动效：3 档时长 + 1 个缓动 */
--dur-fast:.12s; --dur-base:.16s; --dur-slow:.22s; --ease:cubic-bezier(.2,.8,.3,1);

/* 阴影/质感：静态容器用 elevation，可滚动元素用 neu（禁 backdrop-filter） */
--shadow-sm / --shadow / --shadow-hover / --shadow-lg / --shadow-toast
--neu-shadow-sm / --neu-shadow / --neu-shadow-hover / --neu-shadow-inset

/* 状态 */
--disabled-opacity:.5;  --focus-ring（主题色派生，3px 光环）;
hover → 提一层阴影或换 --accent-soft；active → --neu-shadow-inset + translateY(1px)。
```

**主题一致性**：亮 / CommaFeed 暗 / GitHub 暗三套均已覆盖 `--bg…--shadow*` 与 `--glass* / --neu* / --surface-soft*`，新增令牌若为「与主题无关的量」（圆角、时长、透明度、灯箱恒暗色）则只在 `:root` 定义一次即可，无需逐主题重写——本次新增令牌即按此原则，三主题自动一致。

---

## 四点五、建议项全量采纳（v1.1.14）

v1.1.12 之后，第二节的待办项与第三节的优化建议**全部执行完毕**：

| 项 | 处理 |
|---|---|
| 字号 px 值（15/16/17.5px） | **修正为误判**：这三处是 `html[data-font-size]` 的根字号定义（正是全站 rem 缩放的基准），本身必须用 px，不属于违规；全站已无其它 px 字号。 |
| Toast 字符图标 `✓` | 改为 sprite：`.toast-ico` 渲染 `#i-check`，删除 `::before { content:"✓" }`（`src/ui/Overlays.jsx`）。 |
| 分割线三种并存 | 虚线统一为实线，粗细取 `--divider-w` / `--divider-w-strong`，颜色统一 `--border` / `--border-strong`。 |
| 表单无错误态 | 新增 `input:user-invalid / textarea:user-invalid / .is-invalid` → `--danger-border` + `--err-bg`；用 `:user-invalid`（交互后才标红）无需改任何 JS。 |
| 组件内行内硬编码 | AiView `#b7791f` → `var(--warn-text)`；各处 `style={{padding:10/20/8}}` → `var(--sp-*)`；TopBar logo 白 → 新增 `--logo-fg` 令牌。 |
| 主题元数据硬编码 | `ui.js` 的 `syncThemeColor()` 改为读取当前主题的 `--panel`（亮/暗/GitHub 各自正确），不再写死 `#171b22`/`#ffffff`。 |
| 间距刻度（P2-1） | 新增 `--sp-1…--sp-8`（4px 栅格），脚本把全站 padding / margin / gap 的 px 值就近归入刻度并替换为令牌（约 519 处），偏差 ≤2px。 |
| 阴影层级（P2-2） | 新增 `--elevation-1…4` + `--elevation-toast`、`--neu-1…3` + `--neu-inset` 作为语义别名（仍指向各主题原有阴影），全站使用处替换为层级令牌。 |
| 弹层动画（P2-3） | `ddFade / ddUp / fadeIn / lb-in` 时长统一到 `--dur-base` / `--dur-slow` + `--ease`。 |
| 色板补齐（P2-4） | 三主题新增 `--warn-border`（此前 warn 缺 border 变体），危险态沿用 `--err-bg`（报告所指「反色底文字色」实际由 `--danger` + `--err-bg` 覆盖）。 |
| 状态叠加（P2-5） | 已在 v1.1.12 落地并写入规范：禁用=降透明+禁光标、hover=提一层、active=内凹+位移、focus=3px 光环。 |
| 图标尺寸（P2-6） | `.ico` 系列残留的 px 宽高（13~18px）改为 rem，随「字号」偏好一起缩放。 |

> 执行方式：批量映射用一次性脚本 `tools/ui-tokens-apply.py`（只改 padding/margin/gap 与阴影令牌的取值，不动选择器与结构），构建与 225 项 UI 回归全绿后提交。该脚本是一次性的，映射完成后已在 v1.2.1 的死代码清理中删除。

## 五、本次修复明细（v1.1.12）

1. 新增统一令牌：圆角 5 级、字号 7 级、动效 3 档 + 缓动、`--disabled-opacity`、`--lightbox-bg/text`、`--dim`。
2. 补齐交互状态：按钮禁用态（含 primary/ghost/danger 变体）、图标按钮与表单控件禁用态、按钮/分段/色块/视图切换/标签页的键盘焦点光环、开关焦点光环。
3. 令牌化替换：按钮、小按钮、弹层、关闭按钮、弹层标题、输入框、下拉、Toast、结果条、命令面板 kbd 的圆角/字号/动效。
4. 硬编码清理：遮罩/灯箱/压暗层/阴影改令牌；删除 `.shortcuts-*` 死样式（保留并令牌化 `.cmdk-foot kbd`）。
5. 动效：`transition: all` 改为具体属性，时长统一到令牌。

**未改动项**（避免大规模视觉回归，列入待办）：字号中的 3 个 px 值、分割线三种样式、输入框错误态、组件内行内硬编码、Toast 字符图标、间距刻度化、阴影重命名。
