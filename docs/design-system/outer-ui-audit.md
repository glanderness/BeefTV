# 画布外 UI 覆盖规则审计

日期：2026-10-29。源码基准 `dd932a5`，同时包含当前 checkout 上尚未提交的技能模块修改。本文与[机器清单](outer-ui-style-inventory.json)是一份本地审计快照，不代表最新远端 main 的审计结果。

## 1. 范围与证据边界

纳入首页、项目库、资产/生成历史、技能、投稿、设置、模型服务、插件、外部项目详情，以及它们使用的工作区壳、账号/导航、菜单、弹窗、侧栏、表单和共享反馈。**`pages/canvas/index.tsx` 虽位于 canvas 目录，实际是 `/project` 项目库，已人工纳入。** `/canvas/:id` 编辑器内部布局、节点、工作流编排、时间线、导演台不在本次重构范围。

对混合全局文件和共享组件只审计其画布外职责；它们也可能服务画布，必须记录跨域风险，不能全局替换或删除。

本轮做了 CSS 静态扫描及重点调用链人工审查。未执行运行时 computed style、路由访问顺序截图对比、性能采样、跨平台或完整交互实测。因此本文提供**候选清单、已确认源码问题和实施规则**，不承诺识别了全部无用 CSS，也不证明删除后视觉等价。

## 2. 可复现清单

在已安装前端依赖的仓库根目录运行：

```sh
node scripts/audit-outer-ui-styles.cjs > docs/design-system/outer-ui-style-inventory.json
```

脚本使用前端现有 PostCSS，不新增依赖。不访问网络、不启动 App、不修改样式，结果中每组包含选择器、属性、条件上下文、文件、行号、值和 `important` 标记。

| 项目 | 本次值 | 正确解释 |
| --- | ---: | --- |
| 扫描 CSS 文件 | 23 | 包含共享/混合全局文件，不全是画布外专属文件 |
| 规则数 | 6,369 | 不含关键帧内部规则；包含混合文件中的画布规则 |
| 声明数 | 22,808 | 同上，不能称为“画布外声明总数” |
| `!important` 声明 | 1,434 | 文件级统计，包含混合文件；不能一概删除 |
| 重复候选组 | 592 | 排除明显画布专属选择器分支后，按相同选择器、属性和条件分组 |
| 同值重复组 | 100 | 值与重要级别相同，仍需检查组件职责和使用场景 |
| 改写候选组 | 492 | 值或重要级别有变化，不等于 492 个 Bug |

关键文件：`globals.css` 21,487 行/1,115 条 important，`workspace-product.css` 1,563 行/192 条 important；资产三份附加 CSS 共 133 行/39 条 important。

扫描不是 CSS 浏览器：不计算完整优先级、不展开简写与长写、不解析变量最终值，不模拟匹配元素、Portal、JS 主题、行内样式、Tailwind 任意类或懒加载时机。按相同条件比较，媒体条件和 layer 不同的声明不会被简单合并；选择器不同但匹配同一元素的冲突需要人工补查。通用和混合选择器保留为共享候选，仍可能涉及画布。

## 3. 当前加载与所有权链

```text
main.tsx 字体资源
  → application.tsx：AntD reset / globals / 本地品牌覆盖 / body 字体
  → AppProviders：AntD 基础主题 / skin 变量 / App 反馈容器
  → UserLayout：工作区主题 / body 浮层标记 / workspace-product.css
  → 页面：页面 CSS / JSX 工具类 / 行内样式
  → 资产页额外加载：reference-baseline → frame-lock → final-lock
  → AppModal / AppDrawer：组件参数与 flush 样式合并
```

这是职责和导入关系图，不是对打包后所有 CSS 的严格优先级排序。最终还取决于 layer、important、选择器、状态、继承、属性是否在元素自身声明，以及 CSS 注入次序。

[UserLayout](../../web/src/layouts/user-layout.tsx)通过 body 标记服务 Portal；[AppProviders](../../web/src/components/layout/app-providers.tsx)和[app-theme](../../web/src/lib/app-theme.ts)叠加主题；[skin-themes](../../web/src/lib/skin-themes.ts)还会写根变量。整理 CSS 时不能漏掉这些写入方。

## 4. 人工确认的问题登记

“确认”指源码中已找到对应证据；用户影响与性能影响仍按下面的验证项实测。优先级是整改顺序建议。

| ID / 优先级 | 证据与问题 | 调整方向 | 必须验证 |
| --- | --- | --- | --- |
| OUI-01 / P1 | 资产页连续导入三份锁定样式；`.assets-library-source-rail` 的定位/宽度/边框/背景在 `reference-baseline`、`frame-lock`、`workspace-product` 同值重复 | 以实际效果为基线，逐属性合入资产页唯一所有者；不要直接删整文件 | 资产、生成历史、深浅色、各列数断点、侧栏显隐 |
| OUI-02 / P1 | `.app-workspace-shell:has(.assets-library-page)`、其 `::before`、筛选按钮宽度及 ≤720px 内边距在 frame/final 中重复 | 页面模式通过明确壳参数表达；保留行为后删除被取代规则 | 首页→资产→项目→首页，以及反向访问 |
| OUI-03 / P1 | 导航在 globals 多代规则及 workspace-product 不断修改字号、行高、圆角、字重；最终 14px/22px/400 依赖后段高优先级组合 | 导航尺寸和状态归共用导航组件；统一排版角色，选中不改变字重 | 折叠、选中、键盘、窄窗口、主题、路由切换 |
| OUI-04 / P1 | 页头 JSX 默认工具类与 workspace-product 后段覆盖竞争；资产页又单独限定 64px/92px；窄屏有 16/20px 不同内边距来源 | 共用 PageHeader 管标题与操作，资产需要附加 tabs 时使用显式组合；保留基准例外 | 页面标题基线、操作换行、sticky、各基准页 |
| OUI-05 / P1 | 资产空态使用 `top:-19px`、标题 `top:8px`、按钮 `top:-14px` 补偿 | 迁移时用父容器对齐和真实内容盒布局，移除被替代的位移 | 不同文案长度、按钮数量和窗口高度 |
| OUI-06 / P0 | globals 尾部全局 `.ant-message,.ant-notification { display:none!important }`；AppProviders 创建反馈容器，技能编辑/投稿等仍调用 message.error/success | 建立画布外明确的行内错误、提交结果反馈；先补齐反馈，再收窄隐藏策略，不能直接恢复所有 Toast | 模型未配置、生成失败、保存失败、连接失败、成功结果均可感知 |
| OUI-07 / P1 | 资产、生成历史中硬编码白底/白字/深灰背景，与 `--user-*`、`--foreground`、透明混色并存 | 先按背景/内容/状态语义归属，合并主题映射；媒体覆盖文字可保留独立语义 | 浅色、深色、媒体背景、禁用和错误可读性 |
| OUI-08 / P1 | `AppModal`/`AppDrawer` 支持 size、styles、flush，但 `.canvas-history-drawer`、`.assets-generation-preview-drawer` 又用 CSS important 固定宽度 | 共享壳拥有尺寸与滚动；页面选模式/参数，不再用全局后置宽度锁 | 不同宽度、长内容、缩放、嵌套 Select/菜单和关闭后焦点 |
| OUI-09 / P1 | 工作区/浮层广泛的图标按钮 CSS 动效，与全局捕获点击的 WAAPI 按钮和图标动画叠加；卡片、图片另有进场位移/模糊 | 一次交互只选一个反馈所有者；先去重复动效，再测布局/绘制，不以“更多动画”解释流畅 | 连点、列表刷新、滚动、减弱动态偏好、Portal 定位 |
| OUI-10 / P1 | body `.app-user-overlays` / `.app-product-overlays` 由当前路由切换；`:has`、`>div:first-child` 和按中文 aria-label 定位样式耦合 DOM/文案 | 页面与浮层有明确语义根/变体；不让文案字符串或 children 顺序决定几何 | 跨路由尚未关闭浮层、语言/文案变化、包裹层变化 |
| OUI-11 / P1 | `--fs-*`、`--typ-*`、`--user-*` 与控件主题并存；同名职责可能不同值；系统字体与 Inter 声明分歧 | 按 Part 01 统一语义角色和工作区入口；保留 Primitive→Semantic→Component，避免第四套别名 | 字体回退、长名称、控件、Portal 及两个主题 |
| OUI-12 / P2 | 外部页面的普通全局 CSS 随页面导入；类名和通用壳规则未完全隔离 | 页面只写自己根下的内容，跨页规则移到共享层；用路由访问顺序验收，不断言已发生加载泄漏 | 冷启动直达、顺序访问、返回后的尺寸和主题 |
| OUI-13 / P2 | `WorkspacePage`、页面内容区、预览区都可能拥有 overflow；技能分页为局部固定区，但各子页壳未统一 | 每个壳指定一个主要滚动区，固定区只由父 flex/grid 分配；代码/媒体另作独立浏览区 | 长表单、短列表、键盘聚焦、窄屏、底部按钮可达 |
| OUI-14 / P1 | 最近技能重构减少了可见冗余，但 `.skill-editor-header h2` 仍取 `--fs-body`=14px；列表辅助文案取 `--fs-label`=11px、标题另设600，尚未完全符合 Part 01 | 这批代码也纳入迁移，不能把“刚重构”当标准；改用共用页头/列表/表单排版角色 | 与首页/项目/资产同时对照；标题、简介和表单标签 |

证据位置：

- [资产入口](../../web/src/pages/assets/index.tsx)、[reference-baseline](../../web/src/styles/assets-reference-baseline.css)、[frame-lock](../../web/src/styles/assets-frame-lock.css)、[final-lock](../../web/src/styles/assets-final-lock.css)。
- [共用页面壳](../../web/src/components/layout/workspace-page.tsx)、[导航](../../web/src/components/layout/workspace-sidebar-nav.tsx)、[产品工作区样式](../../web/src/styles/workspace-product.css)、[全局样式](../../web/src/styles/globals.css)。
- [按钮反馈 hook](../../web/src/hooks/use-workspace-button-feedback.ts)、[Modal](../../web/src/components/ui/product/app-modal/app-modal.tsx)、[Drawer](../../web/src/components/ui/product/app-drawer/app-drawer.tsx)。
- [技能列表/投稿样式](../../web/src/pages/skills/marketplace.css)、[技能编辑样式](../../web/src/pages/skills/skill-editor.css)、[技能编辑逻辑](../../web/src/pages/skills/skill-editor-drawer.tsx)。

## 5. 不应直接删除的声明

- 同一元素的常态/hover/focus/disabled/selected、明暗主题、响应式条件不是重复 Bug。
- 旧语法/新语法回退和浏览器兼容声明可能有意重复；扫描不判断浏览器支持。
- 三个基准页面的精调例外、品牌资源覆盖、减弱动态偏好和第三方组件必要适配先保留。
- 共享 globals 中的画布规则不属于本次删除范围。
- 没搜索到字面类名不等于无调用：动态类名、第三方 DOM、Portal 和组合选择器都需确认。

## 6. 建议实施批次

1. **先补可见反馈**：处理 OUI-06，避免验收过程中失败被隐藏。此批不顺带重新设计全局 Toast。
2. **建立参照和所有者**：记录三个基准页的桌面/窄窗口、两种主题与路由顺序；先完成 Part 01 字体入口和排版角色的共享实现。
3. **收口技能组件**：最近改动先统一到共用列表、标题、工具栏、侧栏表单、详情壳；确认关键状态、未保存提醒和错误可见。
4. **资产同值去重**：从 OUI-01/02 的确切重复属性起，一批一个组件，将三个 lock 文件逐步并入唯一页面文件；每批移走旧所有者，不追加第四份 final。
5. **共用壳收口**：页头、导航、菜单/浮层、滚动逐项迁移，保留基准外观。不要先重排整个 globals 或一次删除所有 important。
6. **减重复动效并采样**：去掉重复反馈、验证 Portal 和滚动，再根据性能采样处理可见卡顿；不能用代码行数减少充当性能结果。
7. **其他页面扩展**：设置/模型服务、插件、项目详情逐模块接入。共享样式可能影响画布时停止外推，另立后续画布工作项。

每批必须报告新增/移除的所有者、涉及页面、验证结果和剩余例外。通过本地 App 人工验收后再按工作区规则创建单项提交和 PR。

## 7. 本轮结论

已完成画布外职责的 CSS 候选扫描、关键覆盖链审查与整改规划，并提供全量候选来源。未删除运行时规则，未改变页面外观，未重建 App。运行时等价性、未使用选择器判定和性能结果仍待后续批次实测。
