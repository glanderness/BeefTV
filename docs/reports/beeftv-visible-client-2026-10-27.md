# BeefTV 客户端与本地工具：用户可见品牌与说明清理（2026-10-27）

范围：BeefTV 桌面客户端界面、内置提示、设置/授权/费用/失败信息，以及本地 CLI、MCP 给使用者读的文字。
不在本任务：公开 `docs/content/docs/` 与官网（另一任务负责）；服务器、账号、余额、支付与存储迁移（本轮暂缓）。

## 一、结论

1. 逐处检查了仓库中面向使用者的文案，把仍在用的旧品牌名 `BeefAPI` 换成 `BeefTV`，并修掉一处被历史全局替换弄坏的文案。
2. 用户可见的旧品牌名来自两处后端返回，已在后端源头修正：内置渠道的展示名（`/api/assistant/status` 的 `model.channelName`）与画布工作流的连接失败提示。
3. 机器标识与真实请求地址一律不动：渠道 ID `beefapi`、凭据引用 `beefapi-enterprise`、客户端 ID `beeftv-enterprise-v1`、Go 模块名 `infinite-canvas`、上游域名 `enterprise.beefapi.com` / `whatstoken.ai` / `updates.beefapi.com`。旧连接与实际请求继续可用。
4. 未新增任何正则过滤、关键词黑名单、全响应改写或新的保护框架；只改文案本身。

## 二、改动清单（修正前 → 修正后）

### 1. 后端返回给界面的文案

| 文件 | 修正前 | 修正后 |
| --- | --- | --- |
| `backend/internal/app/assistant_provider.go` | `snapshot.Channels[index].Name = "BeefAPI"`（两处，`ResolveAssistantProvider` / `resolveAssistantChannelModel`） | `"BeefTV"` |
| `backend/internal/app/assistant_provider.go` | `assistantChannelName` 兜底 `return "BeefAPI"` | `return "BeefTV"` |
| `backend/internal/app/canvas_workflow_credentials.go` | `workflowBad("BeefAPI 连接已断开，请先在设置中重新连接")` | `workflowBad("BeefTV 连接已断开，请先在设置中重新连接")` |
| `backend/internal/handler/openapi.yaml` | `summary: 读取内置 BeefAPI 连接状态` | `summary: 读取内置 BeefTV 连接状态`（`tags: [beefapi]` 是路径标识，保留） |

### 2. 客户端界面与内置文案

| 文件 | 修正前 | 修正后 |
| --- | --- | --- |
| `web/src/components/layout/app-changelog.zh.ts`（应用内更新日志 v1.7.22） | 「内置 BeefAPI 还可切换备用文件」 | 「内置 BeefTV 还可切换备用文件」 |
| `web/src/components/layout/app-changelog.zh.ts`（v1.7.17） | 「修复 BeefAPI 视频模型调用错误」 | 「修复 BeefTV 视频模型调用错误」 |
| `web/src/components/canvas/nodes/upscale-node.tsx` | 选项文案 `BeefTV超分模型` | `BeefTV 超分模型` |
| `web/src/components/layout/workspace-sidebar-social-links.tsx` | 「不断优化迭代BeefTV的最大动力」 | 「不断优化迭代 BeefTV 的最大动力」 |
| `web/public/welcome/credits.html` | 「返回BeefTV」 | 「返回 BeefTV」 |
| `web/public/welcome/credits.html` | 「不是BeefTV生成的案例」 | 「不是 BeefTV 生成的案例」 |
| `web/src/pages/dev/assistant-panel-lab.tsx` | 夹具 `channelName: "BeefAPI"` | `channelName: "BeefTV"`（`channelId: "beefapi"` 保留） |
| `web/test/canvas-agent-assistant-wiring.test.ts` | 注释把 BeefAPI 当成产品名，并先剔除再检查术语 | 改为：面向使用者的文案统一用 BeefTV，把 `BeefAPI` 加进禁止词 |

### 3. 被历史全局替换弄坏的文案（重点发现）

| 文件 | 修正前 | 修正后 |
| --- | --- | --- |
| `backend/internal/skills/seed/skills.json`（「小红书穿搭」技能 instruction 的自检清单） | 「包含品牌定位、**摄BeefTV略**（每个场景带氛围感描述）」 | 「包含品牌定位、**摄影策略**（每个场景带氛围感描述）」 |

说明：这是一次盲目的全局字符串替换留下的损坏（把中文「影」替换成了品牌名），会让内置技能的自检清单读不通。本次对全仓做了 `[中文]BeefTV[中文]` 一类的粘连扫描，未发现第二处同类损坏。该文件用 `go:embed` 打进二进制，改动后 `go build ./...` 通过、JSON 仍合法（33 条）。

### 4. 插件文档与发布说明

| 文件 | 修正前 | 修正后 |
| --- | --- | --- |
| `plugin-packages/autodl-comfyui/README.md` | 「该插件把BeefTV统一媒体请求转换…」 | 「该插件把 BeefTV 统一媒体请求转换…」 |
| `plugin-packages/autodl-comfyui/manifest.json` | 由 `README.md` 拼接生成，同步更新 | 用 `node plugin-packages/embed-documentation.mjs autodl-comfyui` 重新生成（diff 仅这一行） |
| `plugin-packages/generate-catalog.mjs` | 生成器模板里的「## BeefTV运行时合同」 | 「## BeefTV 运行时合同」 |
| `QUICKSTART.md` | 「内置 BeefAPI 使用「连接 BeefAPI」」 | 「内置 BeefTV 使用「连接 BeefTV」」（与界面按钮实际文案一致） |
| `CHANGELOG.md` | `## Unreleased` 中「BeefAPI 连接授权成功后…」与「Built-in BeefAPI can be connected…」 | 改为 `BeefTV` |

### 5. 发布说明（历史版本）

`CHANGELOG.md` 里历史版本的发布说明（v2.0.4 及更早，共 13 处）同样面向使用者，已逐条按语境改名，而不是整串替换：

- 指内置渠道/产品的 `BeefAPI` → `BeefTV`（v1.7.22、v1.7.17、v1.7.9、v1.7.7、v1.7.5 等条目）。
- 指企业上游的 `BeefAPI Enterprise requests` 改成对用户中性的「built-in channel requests」，不虚构新域名或新服务名。
- 保留事实：金额、条件、模型名、服务商名称、时间点均未改。

## 三、后端返回中的内部名称（开放问题答复）

问题：哪些给用户看的内部名称来自后端返回，而非客户端本地？

| 用户可见的内部名称 | 来源（请求/返回） | 处理 |
| --- | --- | --- |
| 内置渠道展示名 `BeefAPI` | `GET /api/assistant/status` → `model.channelName`；由 `ResolveAssistantProvider` / `resolveAssistantChannelModel` 写入 | 后端源头改为 `BeefTV`，前端不做改写 |
| 画布工作流连接失败提示「BeefAPI 连接已断开…」 | 画布工作流准备（`refreshCanvasWorkflowCredentials`）返回的 `workflowBad` 文案 | 后端源头改为「BeefTV 连接已断开…」 |
| `GET /api/openapi.yaml` 的接口描述 | 开发/集成用规范，非界面文案 | 描述改为「内置 BeefTV 连接状态」 |

其它后端 `BeefAPI` 出现位置均为机器标识、函数/类型名或代码注释，不进界面，未改。

## 四、机器标识与刻意不改动项

- 渠道 ID `beefapi`、凭据引用 `beefapi-enterprise`、客户端 ID `beeftv-enterprise-v1`、恢复连接信任的 `https://beeftv.app` 与 `https://enterprise.beefapi.com`：按 `docs/content/docs/backend/desktop-account.mdx` 的双品牌约定保持不变，旧连接与已有模型引用继续可用。
- Go 模块名 `infinite-canvas`、内部包 `internal/beefapi`、`updates.beefapi.com` 下载源、`whatstoken.ai` 等上游域名：属实现与真实地址，不改。
- 代码注释、测试夹具里显式写的渠道名（如 `web/test/*` 里 `name: "BeefAPI"`）：属测试数据，非用户可见文案，不改。
- 非用户可见的粘连写法（`web/src/styles/globals.css` 的注释、`assets/readme/CAPTURE.md` 采集脚本备注、`scripts/start-local.ps1` 控制台输出）：不进界面，不改。
- `docs/`（含 `docs/content/docs/`、`docs/release-evidence/`）、官网、`scripts/*.ps1` 开发日志：不在本任务范围或为冻结证据，未改。

## 五、验证记录

| 命令 | 结果 |
| --- | --- |
| `cd backend && go build ./...` | 通过（含 `go:embed` 的 `skills.json`） |
| `cd backend && go test ./internal/app/ -run 'Assistant\|Workflow\|Credential' -count=1 -timeout 20m` | ok（4.979s） |
| `cd backend && go test ./internal/skills/... ./internal/modelcatalog/...` | ok |
| `cd web && bun run typecheck`（`tsc --noEmit`） | 通过 |
| `cd web && bun test test/desktop-update-ui.test.ts test/canvas-agent-assistant-wiring.test.ts` | 14 pass / 0 fail |
| `cd web && bun test test/update-diagnostics.browser.test.ts` | 5 pass / 0 fail |
| `cd web && bun test test/upscale-confirmation.browser.test.ts test/workspace-polish.browser.test.ts` | 4 pass / 0 fail |
| `node plugin-packages/embed-documentation.mjs autodl-comfyui` | 重新生成插件文档，diff 仅目标行 |
| `python3 -c "json.load(open('backend/internal/skills/seed/skills.json'))"` | JSON 合法，33 条 |
| 带敌意继承值启动预览（见下） | `[preview] 代理自检通过：/api 命中模拟服务`，日志打印 `已丢弃继承的 VITE_* 变量：VITE_CANVAS_BACKEND_URL, VITE_API_PROXY_TARGET, VITE_FRAMEFIELD_LOCAL_RUNTIME_ENDPOINT` |
| 页面内 `fetch("/api/media-upscale/capabilities")` | `X-Preview-Api: mock`，`cloudProcessing: true`，说明前端入口走同源 `/api` 并落到模拟服务 |
| 模拟服务请求日志（整轮截图期间） | 只有 `GET /api/media-upscale/capabilities` 与 `POST /api/media-upscale/estimate`，没有其它去向 |

预览代理的验证方式：用会「毒化」的环境启动，`PREVIEW_API_PORT=18080`（改端口）、`VITE_API_PROXY_TARGET=http://127.0.0.1:9`（指向不存在的端口）、`VITE_CANVAS_BACKEND_URL=https://beefapi.com/api`（指向真实站点）三条同时给。结果模拟服务监听 18080、Vite 代理跟着指向 18080、继承的三条 `VITE_*` 全部被丢弃，自检命中模拟服务；说明改端口不会再错位，也无法被继承值改道到真实后端。

未跑完整打包 `bun run build`（`tsc --noEmit` 已单独通过）。`web/preview/*` 不在 `tsconfig.json` 的 include 内，不进产品构建。

## 六、界面截图与检查结果

用真实组件预览 + 免费的模拟数据渲染，不连真实后端、不触发任何生成或扣费，也不碰用户正在运行的客户端。

可复现入口：`web/preview/visible-client-brand.html`，由 `bun web/preview/start-preview.mjs` 启动（Vite 开发服务器 + 一个只回放超分能力的模拟 API，`/api` 其余请求返回空数据）。截图用 ego-browser 打开该页、真实交互后保存。

预览页的主题与样式上下文按产品源码搭：

- `applySkinTheme` + `getAntThemeConfig` 取自 `components/layout/app-providers.tsx`（`AppProviders`），`getWorkspaceAntThemeConfig` 取自 `layouts/user-layout.tsx`（仅产品工作区套用）。
- `document.documentElement` 的 `dark` 类与 `color-scheme`、`body` 的 `app-user-overlays` 与 `app-product-overlays` / `app-spatial-overlays` 保持一致；后两者在产品里按路由互斥，预览页用 `?overlay=product|spatial` 复现其中一条，不混用两套浮层 token。
- 因此弹窗拿到的 `--user-*`（`--user-page-bg: #101010`、`--user-ink: #f3f3f5`、`--user-ink-muted: #b4b4bc`）与产品深色工作台一致。

| 截图 | 覆盖的改动 | 页面实测文本 |
| --- | --- | --- |
| [`changelog-v1.7.22.png`](beeftv-visible-client-2026-10-27-shots/changelog-v1.7.22.png) | 应用内更新日志 v1.7.22 | 「所有视频渠道统一优先取回上游结果；下载中断或链接失效时刷新原任务链接，内置 BeefTV 还可切换备用文件，无需重新生成。」（同条目无 `BeefAPI`） |
| [`changelog-v1.7.17.png`](beeftv-visible-client-2026-10-27-shots/changelog-v1.7.17.png) | 应用内更新日志 v1.7.17 | 「修复 BeefTV 视频模型调用错误，以及部分图片模型从出图列表消失的问题。」 |
| [`upscale-model-option.png`](beeftv-visible-client-2026-10-27-shots/upscale-model-option.png) | 超分节点「超分模型」选项 | 下拉选项实测为「BeefTV 超分模型」 |
| [`sidebar-donation.png`](beeftv-visible-client-2026-10-27-shots/sidebar-donation.png) | 侧栏捐赠气泡 | 「你的支持是我们不断优化迭代 BeefTV 的最大动力」 |
| [`welcome-credits.png`](beeftv-visible-client-2026-10-27-shots/welcome-credits.png) | 首页演示素材署名页 | 返回链接「返回 BeefTV」；正文「…不是 BeefTV 生成的案例…」 |

检查方式：ego-browser 打开预览页后，先用页面内实测文本（`page.evaluate`）核对上表文案，再截图；更新日志条目、超分下拉、捐赠气泡都由真实交互（点击按钮/下拉、悬停按钮）展开，不是静态拼字。

可读性：更新日志正文用 `--user-ink-muted` 的 `rgb(180, 180, 188)` 渲染在 `rgb(16, 16, 16)` 的弹窗底色上，按 WCAG 相对亮度算得对比度 **9.24 : 1**（同一段 `page.evaluate` 里现算，不是估计）。截图按弹窗实际外框裁切，正文完整可读。

与真实界面的差别的边界：样式表、设计 token、组件与交互都是产品同一份，浮层作用域也按路由还原；但页面只挂了本次改动涉及的组件，没有外层路由壳（侧栏、顶栏、页面容器）。所以这里的截图用于核对文案与配色，不等于整屏实机截图。

未做实机截图：本次只改文案、未改界面结构，上面的真实组件预览已覆盖全部改动文案。如需实机留证，可按既有规范在隔离客户端补。

## 七、遗漏与后续

1. `docs/content/docs/` 与官网中的旧品牌名由并行的文档任务处理，本任务未动。
2. `docs/release-evidence/*` 等冻结证据里的 `BeefAPI` 是历史记录，保留原样。
3. 建议：给内置渠道的展示名补一条后端单测（断言空名兜底为 `BeefTV`），避免以后回退；本次未加，以免超出「不加额外护栏」的约定，交由 review 决定。

## 八、PR #287 发布说明冲突接续

本节记录 2026-10-28 的本地修订与验证，前文测试及截图属于原任务证据，不代表本轮重新执行。

### 输入与分支关系

- 已读取原任务 #81（`7JMVgIs-SzTZ0TU1bn-C6`），GitHub PR #287 为 OPEN，源分支仍为 `tds/conv-01a17e09-0c9c-796d-bab6-d07c3f35d6d8`。
- `gh pr view 287 --repo glanderness/BeefTV` 实读源提交：`87b56e0689f4842f0dc86992743533d5001c9699`；GitHub 当时返回 `CONFLICTING` / `DIRTY`。
- `gh api repos/glanderness/BeefTV/commits/main` 实读主分支：`6a155448096d2425aa07e81cc6016410091ad0be`，与本任务起点一致，并非根据旧的 origin/main 推断。
- 两边共同祖先：`c99cba49b6518673b078991cf9d995ba14be2921`。
- 本任务分支 `tds/conv-01a17ebf-ff53-7fcf-94ff-414c7c5bbf8e` 从上述主分支开始，通过 `git merge --squash` 带入精确源提交的成果；本轮由平台提交，因此保留成果内容，不声称原提交是新分支的祖先。未切换分支、未新建工作树、未更新原 PR 分支。

### 冲突原因与处理

`git merge-tree --write-tree` 确认只有 `CHANGELOG.md` 冲突。主分支已将旧 Unreleased 的内容重新整理为 v2.0.5 发布说明；源提交则修改了旧 Unreleased 中两处品牌名称。直接恢复旧段会把已整理的内容重新列为未发布，并覆盖真实版本记录。

处理后，文件开头至 v2.0.4 标题之前逐字节保留主分支内容（包含空 Unreleased、完整 v2.0.5 正文及限制说明）；v2.0.4 及以下逐字节保留源提交内容。因此两条已被主分支整理替代的旧 Unreleased 表述不重新加入，原 PR 的历史版本品牌修正完整保留。其余文件采用 Git 无冲突的三方合并结果，没有新增业务逻辑或文案修改。

### 本轮验证

- Python 字节比对通过：23 个非冲突文件与 Git 三方合并树一致（报告追加本节前检查）；其中五张 PNG 与已审查源提交逐字节一致。
- `CHANGELOG.md` 的 v2.0.5 及前文与主分支一致；v2.0.4 及后文与源提交一致。
- `git ls-files -u` 为空，`git diff --cached --check` 通过。
- `bun test web/test/desktop-update-ui.test.ts web/test/canvas-agent-assistant-wiring.test.ts`：14 pass / 0 fail，包含当前版本发布说明检查。
- 本轮未重新拍图、启动客户端、调用付费模型或执行完整构建；只有发布说明冲突处理，不需要重做已通过的界面验收。

### 待办与外部状态

本任务的本地冲突已解决，等待独立复核；未发现第二处文件冲突。GitHub 原 PR 仍指向旧提交，不能称远端冲突已消除。复核通过后，需将本任务修订回写现有 PR #287 的源分支，重新读取 GitHub 合并状态及检查结果，再同步既有飞书 PR/需求记录。保留此前 Lucas 通知，不新建重复 PR，不合并 main、不发版、不部署。
