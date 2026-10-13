# 官方 Pi SDK 复用矩阵（钉选 1.2.0）

本页记录 BeefTV 内置助手宿主对官方 Pi 1.2.0 的复用。执行运行时只有 `@earendil-works/pi-durable` 一套：新会话走 Durable，已有 JSONL 会话只保留只读历史，不再在其上执行新回合。在旧会话里发新消息会为该画布新建一条 Durable 会话，并用旧会话最后的 user/assistant 文本作为交接说明开头。实现以本仓库 `agent-host/` 与钉选包内声明、示例、文档为准；`pi.dev` 最新文档可能对应更高版本。

本地钉选版本：`pi-durable`、`pi-coding-agent`、`pi-ai` 与 chord 1.2.0。配套 agent-core、codemode、mcp、tui、telemetry 通过 overrides 同钉 1.2.0，避免上游范围依赖自动选择未经验证的版本。锁文件由 Bun 生成；没有修改官方包或另建模型执行循环。Durable 接入验证见 [持久宿主验收](durable-host-verification-20261008.md)。

从 1.0.4 升到 1.2.0 时已适配破坏性改动：业务工具的结果改用 `output` 字段返回；已有会话的磁盘格式标记仍是 1.0.4，旧会话照常打开。

## 新会话的官方 Durable 路径

- `durable-session-owner.mjs` 使用 `Harness.open`、`openNodeSqliteStorage`、`defineDoc`、`defineExtension`、`defineTool` 与 `watchEvents` 管理会话、提交、工具与持久事件；不在 AgentSession 外再套 Harness。
- 旧 JSONL 会话退役交接：每个画布内的旧会话固定对应一条 Durable 接续会话，身份写入清单，交接完成状态写入官方 SQLite；`handoffSession` 仅首次用官方 `root.reset(handoffNote)` 写入旧文本，再发布当前指针。失败、断线或重启后的旧 ID 重试复用该会话，不重置已有上下文；显式新建仍创建独立会话，切换旧会话仍可只读历史。NDJSON 在首轮开始时发送 `session` 行，让界面及断流恢复立即使用实际会话 ID；未收到此行也不影响服务端幂等。不调用模型生成摘要，也不把旧 JSONL 导入 Durable。
- Go 拥有业务回合、素材归属、权限、付费批准、操作去重与撤销。宿主开始或恢复执行前读取 Go 回合记录；HTTP 客户端离开不自动结算持久执行。
- 每轮工具通过官方 `registry.install` 和 `root.configure` 配置。内置“只读 / 当前画布 / 完全访问”由 Go 持久记录决定，补充消息和恢复不能升权；具体合同见 [Agent 权限与外部工具](agent-access-20261008.md)。
- 媒体短引用保存在会话中，实际发出模型请求前读取已校验的文件并重新核对当前业务归属。Skills 使用明确选定的版本与内容摘要，经官方扩展展开正文，不自动扫描宿主机文件或执行包内脚本。
- 以下 SDK 矩阵和 JSONL 所有权规则仅说明已有 JSONL 会话的只读读取，不是新 Durable 会话的数据格式。

## 官方来源

| 来源 | URL / 路径 |
| --- | --- |
| 公开 SDK 文档（可能新于钉选） | https://pi.dev/docs/latest/sdk |
| 公开事件流说明 | https://pi.dev/docs/latest/json |
| 公开设置参考 | https://pi.dev/docs/latest/settings |
| 仓库 | https://github.com/earendil-works/pi |
| 钉选 Durable 文档 | `node_modules/@earendil-works/pi-durable/README.md` |
| 钉选 Durable 类型（`Conversation.reset` / `Harness.root` / `settings.stream`） | `node_modules/@earendil-works/pi-durable/dist/harness/types.d.ts` |
| 钉选 SDK 文档（旧 JSONL 只读路径） | `node_modules/@earendil-works/pi-coding-agent/docs/sdk.md` |
| 钉选事件语义 | `node_modules/@earendil-works/pi-coding-agent/docs/json.md` |
| 钉选设置默认值（旧运行时，仅参考） | `node_modules/@earendil-works/pi-coding-agent/docs/settings.md` |
| 旧 JSONL 示例（只读参考） | `examples/sdk/10-settings.ts`、`11-sessions.ts`、`12-full-control.ts`、`13-session-runtime.ts` |

## 复用矩阵

| 官方能力 | 决定 | 说明 |
| --- | --- | --- |
| `SessionManager` JSONL v3 | 只读 | 旧会话历史与画布轮次（`beeftv.canvas.turn` / `.started` custom entry）按官方 JSONL 读取；新回合不再写入。新会话的 transcript 在 Durable SQLite。 |
| `createAgentSession` | 不采用 | 旧 JSONL 会话执行运行时已退役；新会话由 Durable Harness 装配。 |
| `AgentSession.prompt` / `abort` / `subscribe` / `dispose` | 不采用 | 旧运行时的 create / prompt / replace / abort 执行路径已删除。 |
| `AgentSessionRuntime` | 不采用 | 画布级装配与替换由 Durable Harness 负责。 |
| `SettingsManager.inMemory` | 不采用 | 旧运行时设置已删除；Durable 的 `settings.stream` / `retry` / `toolExecution` 在 `durable-session-owner.mjs` 显式钉值。 |
| 全控 `DefaultResourceLoader` | 不采用 | 旧运行时 loader 已删除；Durable 把产品 `SYSTEM_PROMPT` 作为 instructions，工具由 `registry.install` 显式装配，不发现宿主机资源。 |
| `Harness.open` / `openNodeSqliteStorage` / `defineDoc` / `defineExtension` / `defineTool` / `watchEvents` | 采用 | 新会话唯一的执行装配与持久事件来源。 |
| `root.reset(handoff)` | 采用 | 旧会话退役交接：把旧会话文本写成新上下文开头的官方 reset 条目。 |
| `root.submit` / `submission.wait` / `root.abort` | 采用 | 回合提交、终态结算与停止；`whenBusy: "steer"` 用于运行中补充。 |
| `GenerationTask.beforeRequest` hook | 采用 | 准备请求前重读 Go 授权、历史素材归属与补充输入，并在实际 HTTP dispatch 前转换已验证的媒体结果。 |
| pi 的字节级空闲超时（undici `bodyTimeout` / `httpIdleTimeoutMs`） | 不采用 | 只按“收到任意字节”重置，SSE 心跳会把它续上；且不在 Durable 路径安装。宿主保留按实际文本/工具进展计时的空闲上限，见 `model-stream-idle.mjs`。 |
| `compaction_*` / `auto_retry_*` | 不映射到面板 | Durable 的压缩与重试在官方任务内部完成；宿主 NDJSON 只发 `text_delta` 与工具 `lifecycle` 行。 |
| 官方 TUI / RPC 实验服务器 | 不采用 | 产品 UI 是 React + Go 代理。 |
| `@earendil-works/pi-web-ui` | 不采用 | 钉选时代的包是过期 Lit + IndexedDB，且会在浏览器里跑 Agent。 |

## 宿主内部分工

| 模块 | 责任 |
| --- | --- |
| `durable-session-owner.mjs` | 官方 Durable 会话装配、按画布预约队列、提交/恢复/停止、原子指针、官方 SQLite 持久事件。 |
| `session-owner.mjs` | 旧 JSONL 会话只读历史、`current.json` 指针读取，以及旧会话 → Durable 的交接说明提取。 |
| `operation-bridge.mjs` | 已鉴权 `/api/ops`、scope 注入、`customTools`。 |
| `server.mjs` | 本机 HTTP、鉴权、预算 fetch 包装、NDJSON、SIGTERM/SIGINT 释放会话。 |

## 会话所有权

- 预约按 `canvasId`：`createSession` / `handoffSession` / `activateSession` / `ensureSession` / `submit` 共享一条队列；不同画布并行。
- `submit` 在同一把锁里恢复或新建 active，并把 `busy` 交给官方 generation；忙碌会话的 `createSession` 在发布指针前拒绝（409 `session_busy`）。
- 候选先 `prepareSession`（写清单、开 Harness），指针 `current.*.tmp` + `rename` 成功后才写入 Map；指针失败则关闭候选 Harness、保留旧活动会话。
- `ensureSession` 只把缺失指针（`ENOENT`）当成可回退：没有会话就新建。EISDIR、损坏 JSON、SDK 装配失败原样抛出。
- 交接 `handoffSession` 先 `root.reset(handoffNote)` 再发布指针；reset 失败则关闭候选 Harness，不安装。
- 进程 `SIGTERM`/`SIGINT` 先把 store 标为关闭，排空该画布预约队列，再 `disposeAll`（关闭官方 Harness）。关闭后新的预约直接失败。`SIGKILL` 仍无法拦截，中断回执语义不变。

## 仍由本产品持有

- 画布 scope、operationId、用户确认后的生成、单轮/总预算、中断回执、按画布身份。
- React 只消费 `/api/assistant/*` 流，不在浏览器建 Agent 或 SessionManager。

## 已验证（钉选 1.2.0，本地替身，无付费模型）

- `session-owner.test.mjs`：旧 JSONL v3 历史（用户消息、BeefTV 轮次）仍可读取；`handoffNote` 只取最近 20 条、总长截断到约 8000 字符；`readHandoffNote` 含旧会话文本，找不到会话时返回空说明。
- `session-identity.test.mjs`：同一 toolCallId 在两条会话不撞 operationId；旧 JSONL 会话仍能按 id 找回。
- `session-lifecycle-host.test.mjs`：真实宿主 HTTP 新建/并发替换、忙碌 409、指针目录失败、SIGTERM 释放；旧 JSONL 会话发新消息会新建 Durable 会话，模型请求带上交接说明，后续回合走新会话（本地替身模型）。
- `durable-session-owner-cases.mjs`：官方 Durable SQLite 崩溃/重放/steering/stop/history；`handoffSession` 用 `root.reset` 写入交接说明，模型请求带上旧会话文本。
- `durable-request-budget.test.mjs`：总预算跨真实宿主崩溃与文件系统故障。
- `host-runtime-probe.test.mjs`：预算耗尽、素材参数、引用画布读取。
- `system-prompt.test.mjs`：媒体策略与产品 system prompt 约束。
- React：`lifecycle` 与 `agent_end` 都不结算回合；压缩/重试文案不出现内部事件名。

2026-10-11 退役验证：`bun install --frozen-lockfile` 通过；完整 `agent-host` suite 119 项通过、0 失败（约 220 秒）。真实媒体/steer 探针仍为本机替身、没有付费模型调用。

## 宿主扩展装配

`createDurableSessionStore` 接受可选 `extensions(entry)`；当前只安装产品技能扩展 `createDurableSkillExtension`（按 Go 记录的 skill pins 展开正文）。Durable 的 instructions 直接使用 `system-prompt.mjs` 的 `SYSTEM_PROMPT`，工具由 `registry.install` 显式装配；媒体转换在宿主 HTTP dispatch 执行，同一会话只保留官方执行循环。

## 本地补丁候选的工具与模型修复

以下为本地候选实现，正式发布与原生验收状态以对应版本回执为准。

- `canvas_get` 的模型读取采用有界分页，完整字段读取和 revision 校验见 [`canvas-read-view.md`](../../agent-host/canvas-read-view.md)。Go 原始画布内容与授权校验不变。
- 新轮次通过官方 Durable 根 Agent 的 `configure` 同步宿主选定模型；未完成轮次按活动轮次中固定的模型恢复。原模型不可用时拒绝调度，不切换模型或假称完成。
- 内置 `canvas_search` 的可选 `projectId` 表示项目过滤条件，省略时搜索本账号全部画布；宿主转为现有公开操作的 `canvasId` 项目过滤字段，且不注入当前画布 ID。公开 MCP/CLI 参数保持原样。`project_canvas_search` 的 `canvasId` 仍表示用于确定项目的真实画布。
- 搜索回归覆盖内置工具实际 HTTP 参数、同账号未归项目的两张画布、显式项目过滤、跨账号隔离和原有 scope/CAS。测试路径为 `agent-host/operation-bridge-search.test.mjs` 与 `backend/internal/app/operations_workspace_canvas_search_test.go`；替身测试不能代替原生助手验收。

## 限制

- 未接官方 web-ui / TUI / 实验服务器。
- 旧 JSONL 会话只读：不自动迁入 Durable；发新消息时以交接说明开一条新 Durable 会话，旧文件保留。
- 压缩与自动重试依赖官方内部路径，其内部事件名不映射到面板。
- 官方 `SessionManager` 在出现 assistant 消息前延迟落 jsonl；宿主读取历史时只认已落盘的会话文件。
- Go 媒体操作、时间线修改、事务内本地渲染接入见 `agent-media-harness-integration.md`；没有改付费生成协议或默认主模型。
