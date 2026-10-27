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

未跑完整打包 `bun run build`（`tsc --noEmit` 已单独通过）。

## 六、界面截图与检查结果

用真实组件预览 + 免费的模拟数据渲染，不连真实后端、不触发任何生成或扣费，也不碰用户正在运行的客户端。

可复现入口：`web/preview/visible-client-brand.html`，由 `bun web/preview/start-preview.mjs` 启动（Vite 开发服务器 + 一个只回放超分能力的模拟 API，`/api` 其余请求返回空数据）。截图用 ego-browser 打开该页、真实交互后保存。

| 截图 | 覆盖的改动 | 页面实测文本 |
| --- | --- | --- |
| [`changelog-v1.7.22.png`](beeftv-visible-client-2026-10-27-shots/changelog-v1.7.22.png) | 应用内更新日志 v1.7.22 | 「内置 BeefTV 还可切换备用文件，无需重新生成。」（同条目无 `BeefAPI`） |
| [`changelog-v1.7.17.png`](beeftv-visible-client-2026-10-27-shots/changelog-v1.7.17.png) | 应用内更新日志 v1.7.17 | 「修复 BeefTV 视频模型调用错误，以及部分图片模型从出图列表消失的问题。」 |
| [`upscale-model-option.png`](beeftv-visible-client-2026-10-27-shots/upscale-model-option.png) | 超分节点「超分模型」选项 | 下拉选项实测为「BeefTV 超分模型」 |
| [`sidebar-donation.png`](beeftv-visible-client-2026-10-27-shots/sidebar-donation.png) | 侧栏捐赠气泡 | 「你的支持是我们不断优化迭代 BeefTV 的最大动力」 |
| [`welcome-credits.png`](beeftv-visible-client-2026-10-27-shots/welcome-credits.png) | 首页演示素材署名页 | 返回链接「返回 BeefTV」；正文「…不是 BeefTV 生成的案例…」 |

检查方式：ego-browser 打开预览页后，先用页面内实测文本（`page.evaluate`）核对上表文案，再截图；更新日志条目、超分下拉、捐赠气泡都由真实交互（点击按钮/下拉、悬停按钮）展开，不是静态拼字。预览页加载与产品同一套样式（`globals.css` 含 Tailwind 与设计 token，另加共享产品样式与侧栏样式），Tailwind 由 Vite 的 PostCSS 编译，渲染结果与真实界面一致。

未做实机截图：本次只改文案、未改界面结构，上面的真实组件预览已覆盖全部改动文案。如需实机留证，可按既有规范在隔离客户端补。

## 七、遗漏与后续

1. `docs/content/docs/` 与官网中的旧品牌名由并行的文档任务处理，本任务未动。
2. `docs/release-evidence/*` 等冻结证据里的 `BeefAPI` 是历史记录，保留原样。
3. 建议：给内置渠道的展示名补一条后端单测（断言空名兜底为 `BeefTV`），避免以后回退；本次未加，以免超出「不加额外护栏」的约定，交由 review 决定。
