# 定制分支说明（custom）

本仓库是 `glanderness/BeefTV` 的下游定制版。本文件只存在于 `custom` 分支，记录我们相对上游的全部改动，方便同步上游时处理冲突。

## 分支和远程

| 名称 | 含义 |
| --- | --- |
| `upstream` | 上游 `https://github.com/glanderness/BeefTV`，只拉取，本地已禁止推送 |
| `origin` | 我们自己的 fork |
| `main` | 上游镜像，**永远不提交自己的改动** |
| `custom` | 产品分支 = 上游 + 本文件列出的所有定制 |
| `feat/*` | 从 `custom` 拉出，做完合回 `custom` |

本地已开启 `git rerere`：解决过的冲突会被记住，下次自动套用。

## 改动分流规则

1. **通用修复和改进**：从 `main` 拉分支，提 PR 给上游，不进 `custom`。
2. **能用插件实现的**：放进插件机制（见 `docs/content/docs/plugins/plugin-system.mdx`），不改核心代码。
3. **只有我们需要的**：进 `custom`。新代码放在自己的目录里；上游文件只留接入点（import 加一行调用），并登记到下表。

禁止在上游文件里顺手格式化、改名或挪位置。

## 上游文件改动登记

同步时遇到冲突，处理方法是：先采用上游版本，再按下表把我们那几行加回去。

| 上游文件 | 我们的改动 | 所属功能 |
| --- | --- | --- |
| `web/vite.config.ts` | import `beeftvI18n`，并放在 `plugins` 数组第一位 | 双语 |
| `web/src/components/layout/app-providers.tsx` | import `enUS`、`currentLocale`；`ConfigProvider locale` 跟随语言 | 双语 |
| `web/src/components/video-player.tsx` | import `currentLocale`；英文时 `translations={undefined}` | 双语 |
| `web/src/pages/settings/index.tsx` | import `LanguageSwitch`；在 `<main>` 第一个子元素前插入 `<LanguageSwitch />` | 双语 |
| `web/src/pages/settings/channel-settings-pane.tsx` | import `ChannelExportButton`、`ChannelImportDialog`；顶部操作区 `div` 加 `min-w-0 max-w-full flex-wrap`，「添加模型服务」前插入「导入」按钮；渠道卡片「编辑」前插入 `<ChannelExportButton>`；文件末尾挂 `<ChannelImportDialog>`（`importOpen` 状态） | 渠道导入导出 |
| `docs/content/docs/overview/features.mdx` | 文首新增「单个模型渠道分享」一节 | 渠道导入导出 |
| `docs/local-model-config-persistence.md` | 文末新增「单个渠道导入与导出」一节 | 渠道导入导出 |

## 我们自己的目录（上游不会碰，不会冲突）

| 路径 | 用途 |
| --- | --- |
| `web/i18n/` | 双语构建插件、提取和翻译脚本 |
| `web/src/i18n/` | 双语运行时、语言切换、英文词典 |
| `docs/refactor/i18n-overlay-plan.md` | 双语改造方案 |
| `scripts/custom/` | 同步上游脚本 |
| `.github/workflows/custom-*.yml` | 自动同步和检查 |
| `web/src/pages/settings/channel-share*.ts`、`channel-export-button.tsx`、`channel-import-dialog.tsx` | 渠道导入导出 |
| `web/test/channel-share*.test.ts`、`web/test/fixtures/channel-share-harness.tsx` | 渠道导入导出测试 |
| `CUSTOMIZATIONS.md` | 本文件 |

## 同步上游

### 自动（推荐）

`custom-upstream-sync` 每周一 09:00（北京时间）运行，也可以在 Actions 页面手动触发。它会做三件事：

1. 把 fork 的 `main` 快进到上游最新；
2. 开一个 `main → custom` 的 PR（已有就不重复开）；
3. 由 `custom-check` 在这个 PR 上跑提取词条和打包。

合并这个 PR 时**必须选 "Create a merge commit"**，不要选 Squash 或 Rebase，否则下次同步会重复冲突。PR 显示有冲突时，在本地按下面的手动流程处理。

### 手动

```bash
bash scripts/custom/sync-upstream.sh
```

脚本会更新 `main`、把它合进 `custom`、更新双语词典并打包。出现冲突时脚本会停下，按上表解决后执行 `git commit`，再运行一次脚本。

同步后如果有新的未翻译词条，按 `docs/refactor/i18n-overlay-plan.md` 阶段 1 第 5 步补齐。

## fork 首次配置（只做一次）

1. 在 GitHub 上 fork 仓库，把默认分支设为 `custom`。定时任务只在默认分支上运行。
2. 创建一个 fine-grained token，只授权这个 fork，权限勾选 Contents、Pull requests、Workflows 的读写，保存为仓库 Secret `SYNC_TOKEN`。必须用它而不是默认的 `GITHUB_TOKEN`：上游一改 `.github/workflows/`，默认 token 就没有权限推送。
3. 上游自带的 workflow（安装包构建、E2E 等）会在 fork 里跟着运行。不需要的话，在 Actions 页面逐个禁用。
