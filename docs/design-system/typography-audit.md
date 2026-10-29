# 排版基线审计

日期：2026-10-29。源码基准：`dd932a5`；审计时当前 checkout 上另有尚未提交的技能页调整，这些调整**不作为本规范的视觉基准**。本阶段不更新源码基线、不覆盖现有修改、不构建 App、不提交或推送。

验证方式：阅读实际路由、渲染组件、字体加载入口、CSS 声明及覆盖关系，并计算指定不透明颜色的对比度。此次没有安装版 computed style、Rendered Fonts、截图像素测量或跨平台实机记录。下表是静态源码审计，不能代替运行时样式验收。

## 1. 基准页面和来源

源码链接以仓库相对路径给出，定位时按选择器或函数名查找，避免行号漂移。

| 对象 | 源码 | 审计结论 |
| --- | --- | --- |
| 路由 | [router.tsx](../../web/src/router.tsx) | `/project` 与 `/projects` 渲染 `CanvasPage`，不是旧的 `pages/projects/index.tsx` |
| 首页 | [home-dashboard.tsx](../../web/src/pages/home/home-dashboard.tsx)、[home-dashboard.css](../../web/src/pages/home/home-dashboard.css) | 审计 `.beeftv-home-*`，不以旧 `.creation-home-heading` 或 `.app-home-dashboard` 作为当前首页依据 |
| 项目库 | [canvas/index.tsx](../../web/src/pages/canvas/index.tsx)、[library-card-shell.tsx](../../web/src/components/canvas/library-card-shell.tsx) | `PageHeader` 与 `libtv-library-card` 承担页面标题和卡片信息 |
| 资产库 | [assets/index.tsx](../../web/src/pages/assets/index.tsx)、[asset-library-card.tsx](../../web/src/components/assets/asset-library-card.tsx) | `PageHeader`、`.asset-collection-body h2`、`.asset-card-meta` 为核心文字来源 |
| 共用标题 | [workspace-page.tsx](../../web/src/components/layout/workspace-page.tsx) | JSX 默认 `font-semibold leading-7` 还会被产品工作区 CSS 覆盖，不能只读 JSX |
| 工作区样式 | [workspace-product.css](../../web/src/styles/workspace-product.css) | 页面标题、导航和卡片的高优先级规则，以及主题内组件覆盖 |
| 基础/历史样式 | [globals.css](../../web/src/styles/globals.css) | 字号原始变量、另一套 `.typ-*`、多代页面和主题规则仍共存 |
| 字体加载 | [main.tsx](../../web/src/main.tsx) | 加载 Inter Variable、JetBrains Mono Variable；加载不等于所有元素最终选用它 |
| 字体入口 | [application.tsx](../../web/src/application.tsx) | `document.body.style.fontFamily` 显式声明 SF Pro/PingFang 等系统字体栈 |
| AntD 主题 | [app-theme.ts](../../web/src/lib/app-theme.ts)、[user-layout.tsx](../../web/src/layouts/user-layout.tsx) | 工作区使用嵌套 ConfigProvider；`getWorkspaceAntThemeConfig` 的 Button 字重为 550；其他主题入口另有 Inter 与 13px 声明 |
| 最后覆盖检查 | [beeftv-local-overrides.css](../../web/src/styles/beeftv-local-overrides.css) | 当前文件没有字号/字体/行高/字距声明；仍需在后续变更时检查 |

## 2. 关键声明与静态覆盖结果

| 场景 / 定位 | 声明与推导 | 规范处理 |
| --- | --- | --- |
| `.app-section-page-header .app-page-header-title` | 产品工作区显式 16px、22px 行高、500、字距 0；覆盖全局旧大标题与 JSX 默认字重 | `page-title` 基准 |
| `.beeftv-home-create-title` | 16px/24px/500，字距 0；≤900px 时字号 22px，仍继承 24px 行高 | 首页展示入口例外 |
| `.beeftv-section-heading h2` | 16px/24px/500，字距 `-.01em` | 分区标题基准；轻微负字距限已有首页 |
| `.beeftv-capability strong` | 显式 14px/22px/400 | 不能因标签为 strong 而强行加粗 |
| `.beeftv-recent-copy strong` | 14px/22px/500 | 首页卡片标题 |
| `.beeftv-recent-copy small` | 12px/18px/400、`--user-ink-muted` | 首页日期 |
| `.beeftv-section-heading a` | 13px/20px、次级色 | 文本动作 |
| `.lib-tv-project-page .libtv-library-card-title` | 13px/20px/600，主文字；溢出单行省略 | 项目卡片例外 |
| `.lib-tv-project-page .libtv-library-card-date` | 11px/18px/400，辅助文字 | 既有卡片例外，不推广为新日期默认 |
| `.asset-collection-body h2` | workspace-product 指定 14px、1.6 行高；globals 的非 layer 规则保留 580、`-.01em`；静态推导 22.4px 行盒 | 资产卡片例外；需实机 computed style 复核 |
| `.asset-card-meta .asset-collection-date` | globals 更具体选择器指定 `--fs-micro`（9px）及 foreground 45% 混合，盖过低优先级的 12px 辅助色规则 | 历史欠账，不能将查到的 12px 当最终值，也不能推广 9px |
| `.app-workspace-nav-link` | 工作区后段高优先级规则覆盖为 14px/22px/400；选中仍为 400，颜色主文字 | 侧栏层级基准 |
| 导航字距 | globals 较早规则声明 `-.01em`，后段 14px 规则未重置字距 | 当前遗留；规范默认 0，集中迁移时再验收，不能声称现已全站为 0 |
| `.app-workspace-topbar-utility` | 14px/20px | 现有顶栏入口例外 |
| `.ant-btn` / `.ant-btn-sm` | 产品工作区分别 13px / 12px；工作区主题 Button 请求 550 字重 | 规范采用其字号与字重；20px/18px 行高为本次明确的目标组合，非声称已统一 |
| `.assets-library-source-rail-item` | 14px/22px、常态次级色 | 同级导航参考 |

`font-size` 本身不是完整排版角色。遇到未显式声明的属性，须沿继承和级联链继续检查，不能默认它已与规范一致。

## 3. 颜色依据和计算

`globals.css` 的后段 “User workspace redesign” 为 `.app-user-workspace` 与 `.app-user-overlays` 声明主、次级、辅助文字变量；深色规则替换具体值。源码较早还有不同色值，不作为本次规范表的取值。

| 文字 | 浅色 `#f8f8fa` 背景 | 浅色 `#ffffff` 背景 | 深色 `#101010` 背景 |
| --- | ---: | ---: | ---: |
| 主文字（浅 `#1d1d21` / 深 `#f3f3f5`） | 15.84:1 | 16.80:1 | 17.17:1 |
| 次级（浅 `#686872` / 深 `#b4b4bc`） | 5.19:1 | 5.51:1 | 9.24:1 |
| 辅助（浅 `#85858e` / 深 `#9797a1`） | 3.45:1 | 3.66:1 | 6.58:1 |

以上仅对表内不透明前景/背景色进行计算，保留两位小数。没有模拟照片、渐变、透明浮层、disabled opacity、抗锯齿或其他背景，不能外推为整站可读性认证。

计算方法可复现：将 8 位 sRGB 通道归一化至 0–1；通道 ≤0.04045 时除以 12.92，否则使用 `((c+0.055)/1.055)^2.4`；亮度 `L=0.2126R+0.7152G+0.0722B`；对比度为 `(L较亮+0.05)/(L较暗+0.05)`。有透明度时先计算实际合成色。

结论：浅色辅助文字不能直接承担新增界面的重要正文、状态说明和操作指引。不能因为深色截图看着清楚，就默认浅色也清楚。

## 4. 待迁移清单

本轮仅记录，不修改三个基准页面：

1. 系统字体入口与 Inter 优先变量、控件字体之间存在分歧；统一声明须先做平台和基准页验收。
2. `--fs-title=22px` 与当前 16px 页面标题不同；`--fs-label=11px` 与本规范 12px 表单标签不同，不能按变量名替代审计。
3. 全局 `.typ-title-sm`、`.typ-nav-link` 等组合与精调页面的字重/行高不同；不直接批量套用。
4. 13px 控件档与本规范的完整行高/字重组合尚未全部集中注册。
5. 资产日期 9px/低透明度、项目日期 11px/浅色辅助灰存在可读性风险，后续单列验收。
6. 旧页面依靠多层覆盖和 `!important`；应按共享组件逐步收口，不能继续追加同义变量。
7. 导航遗留负字距与规范默认 0 的差异待迁移。
8. 三个基准页面的字号差异不能直接当作错误删除：项目 13px/600 与资产 14px/580 是明确保留的组件例外。

## 5. 实机验收记录（待补）

- 当前安装版：此前核对为 `/Applications/BeefTV.app` v2.0.5；本轮未重建、未执行实机排版验收。
- 待记录：App 版本与源码提交、平台/字体匹配、窗口 CSS 尺寸、缩放、DPR、主题、代表性文字的 computed style 与实际字体。
- 待覆盖：首页/项目/资产、侧栏、表单/菜单/Portal、长名称/中英混排、桌面/窄窗口、深色/浅色。
- 验收后再将“静态推导”标为“实机确认”；不要以构建通过代替视觉验收。
