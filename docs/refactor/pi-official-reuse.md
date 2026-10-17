# 官方 Pi SDK 复用矩阵（钉选 1.2.0）

本页记录 BeefTV 内置助手宿主对官方 Pi 1.2.0 的复用。执行运行时只有 `@earendil-works/pi-durable` 一套：新会话走 Durable，已有 JSONL 会话只保留只读历史，不再在其上执行新回合。在旧会话里发新消息会为该画布新建一条 Durable 会话，并用旧会话最后的 user/assistant 文本作为交接说明开头。实现以本仓库 `agent-host/` 与钉选包内声明、示例、文档为准；`pi.dev` 最新文档可能对应更高版本。

本地钉选版本：`pi-durable`、`pi-coding-agent`、`pi-ai` 与 chord 1.2.0。配套 agent-core、codemode、mcp、tui、telemetry 通过 overrides 同钉 1.2.0，避免上游范围依赖自动选择未经验证的版本。锁文件由 Bun 生成；没有修改官方包或另建模型执行循环。Durable 接入验证见 [持久宿主验收](durable-host-verification-20261008.md)。

从 1.0.4 升到 1.2.0 时已适配破坏性改动：业务工具的结果改用 `output` 字段返回；已有会话的磁盘格式标记仍是 1.0.4，旧会话照常打开。

## 新会话的官方 Durable 路径

- `durable-session-owner.mjs` 使用 `Harness.open`、`openNodeSqliteStorage`、`defineDoc`、`defineExtension`、`defineTool` 与 `watchEvents` 管理会话、提交、工具与持久事件；不在 AgentSession 外再套 Harness。
- 旧 JSONL 会话退役交接：每个画布内的旧会话固定对应一条 Durable 接续会话，身份写入清单，交接完成状态写入官方 SQLite；`handoffSession` 仅首次用官方 `root.reset(handoffNote)` 写入旧文本，再发布当前指针。失败、断线或重启后的旧 ID 重试复用该会话，不重置已有上下文；显式新建仍创建独立会话，切换旧会话仍可只读历史。NDJSON 在首轮开始时发送 `session` 行，让界面及断流恢复立即使用实际会话 ID；未收到此行也不影响服务端幂等。不调用模型生成摘要，也不把旧 JSONL 导入 Durable。
- Go 拥有业务回合、素材归属、权限、付费批准、操作去重与撤销。宿主开始或恢复执行前读取 Go 回合记录；HTTP 客户端离开不自动结算持久执行。
- 每轮工具通过官方 `registry.install` 和 `root.configure` 配置。内置“只读 / 当前画布 / 完全访问”由 Go 持久记录决定，补充消息和恢复不能升权；具体合同见 [Agent 权限与外部工具](agent-access-20261008.md)。
- 媒体短引用保存在会话中，实际发出模型请求前读取已校验的文件并重新核对当前业务归属。技能目录使用官方 section，常驻显示名称、说明和 id（每页最多 50 个、说明最多约 300 字）；更多技能通过 `skill_catalog` 搜索或翻页。每次新的明确选择都按固定版本展开到用户消息，模型调用 `skill_load` 时正文进入工具结果；相同请求的网络重试由 Durable 提交回执去重。`loadedSkills` 只记录历史读取，Go 的 `AssistantSkillContext` 单独保存活动版本、scope 和 revision。活动规则通过官方 section 从 Go 重建，压缩和进程重启不会依赖摘要保留原文；每次真正发出模型请求前重新验证权限、版本和正文。Durable 会容纳 section/hook 异常并保留旧段落，因此硬性拒绝由 Pi Models 的 provider 准入适配执行，不仅靠 hook 抛错。清除活动技能保留当前对话历史；独立任务调用官方 reset 切断旧的模型可见上下文，界面历史仍保留。具体 HTTP、幂等与预算合同见 [技能上下文](./assistant-skill-context.md)。
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
| pi-coding-agent 技能（`formatSkillsForPrompt` / `/skill:name` 展开） | 照样实现 | Durable 没有技能组件。目录按 `<available_skills>` 的格式写成常驻系统提示段，正文按官方 `<skill name=…>` 块写进用户消息或 `skill_load` 工具结果；目录函数要求本机文件路径，不直接复用。 |
| `thinkingLevel`（根会话） | 采用 | 默认 `low`（约 2048 个思考 token），可用 `BEEFTV_AGENT_THINKING` 改为 off、minimal、low、medium 或 high；已有对话在下一轮开始时跟上。只对 Anthropic 协议的模型打开思考，思考和回答共用 `BEEFTV_AGENT_MAX_TOKENS`（默认 16384）。 |
| `GenerationTask.beforeRequest` hook | 采用 | 准备请求前重读 Go 授权、历史素材归属与补充输入，并在实际 HTTP dispatch 前转换已验证的媒体结果。 |
| pi 的字节级空闲超时（undici `bodyTimeout` / `httpIdleTimeoutMs`） | 不采用 | 只按“收到任意字节”重置，SSE 心跳会把它续上；且不在 Durable 路径安装。宿主保留按实际文本/工具进展计时的空闲上限，见 `model-stream-idle.mjs`。 |
| `auto_retry_start` / `auto_retry_end` | 采用（只读进度） | 重试仍由官方任务按 `settings.retry` 执行，宿主不另做重试。事件映射为已有的 `lifecycle` 行 `retry`（`attempt` 与归类后的 `reason`：`rate_limited`、`timeout`、`provider_unavailable`、`network`、`model_error`）和 `retry_end`；上游错误原文不进入 NDJSON 或历史。映射在 `durable-session-owner.mjs` 的 `durableStreamEvents`。 |
| `compaction_*` | 不映射到面板 | Durable 的压缩在官方任务内部完成。 |
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
- 读取不重放恢复：`recover` 在该会话已有官方 `wait` 观察时直接返回，不再 hydrate、不重读 Go 授权、不重新提交；并发读取共用同一次恢复。`/history` 读取当前会话的活动 owner 时不重写 `current.json`。
- 运行中进度：宿主把最近一条重试或工具进度只保存在内存，`/history` 的 `active.lifecycle` 返回它，不为每个事件写持久文档；回合结束或观察结束即清空。重复的 `/chat` 接到运行中的回合时先补发这条进度。
- 观察断开：`/chat` 已开始输出后宿主观察失败时发 `observer_error`；界面不报失败，改为读取历史，直到读到最终回执。
- 按请求停止：界面每次发送生成一个 `requestId`（`[A-Za-z0-9_-]{1,128}`），随 `/assistant/chat` 转给宿主，作为官方 `submit` 的 `requestId`。Go 只校验格式，回合 ID 与授权仍由 Go 生成，`requestId` 不能代替它。停止带 `{canvasId, sessionId, requestId}`：Go 校验两者成对、格式有效、画布归属，只转发这三个字段；宿主核对会话属于该画布（Durable 清单所在目录，或该画布的旧会话），否则 404。不带这两个字段的旧调用仍按画布停止当前回合。
- 停止意图沿 STATE 文档与官方提交记录：`cancelRequest` 先按画布、会话、请求身份同步记入内存（同一进程里正持有画布锁的 `submit` 也能读到，同画布其他会话的同名请求不受影响），再一次提交写入 `STATE.stopRequests`（有上限）；该请求已是 `active` 时同时置 `active.stopped`。会话还没打开（如重启后）就在画布锁内临时打开它写入再关闭，不调度任何官方工作。返回 `stopped`（正在执行：沿用原有的标记停止、结算 Go 回合、官方 `abort`）、`finished`（已有记录）或 `pending`（这里还没开始执行它）。别的请求不受影响。
- `submit` 在三处读停止意图：已有记录时不再执行（同一请求重发、换了 Go 回合 ID 时，结算这个新回合并返回原记录）；准备前（停止早于 `/chat` 到达）；写入 `active` 之后、调用官方 `root.submit` 之前同步再读一次（停止发生在准备期间）。命中时如果官方队列里还没有它，先把停下结果存为 `active.result`（`cancelled: true`，`status: unanswered`，没有 `submissionId`，`change: null`），撤下它本要载入的技能记录；Go 确认结束后才移入历史并清空 `active`。确认失败或进程退出后，恢复只补确认；Go 已关闭时直接完成本地历史，不要求存在官方提交。这个路径没有模型请求、工具或画布写入。已在官方队列里则按该请求身份标记停止并 `abort`，按官方结算记录。
- 停止与后续请求竞争：HTTP handler 固定原 `requestId`，从停止标记提交取得原 `turnId`，不在等待 Go 后重新读可变的当前回合。`stop` 在画布预约锁内再核验原请求，持锁完成官方会话级 `abort`，防止期间新请求被接受后遭误停。观察旧提交的 `wait` 也只结算该提交的请求，不能用旧结果结束新回合。
- 崩溃窗口：停止已提交、官方 `submit` 还没发生时进程退出，或停止与官方入队之间进程退出，重启后的 `recover` 读到停止意图就走 `stop`：先查 `active.submissionId`，再按 `requestId` 查官方提交；都没有时在画布锁内记为已停下，有则 `abort` 后等官方结算。不会重新提交。
- 界面在消息发出前（就绪检查、读取对话阶段）停下时，清掉待发送内容，提示“已停下，这条消息没有发出。”，可用“重试”原样再发。发出后停下：停止返回 `pending` 且历史里既没有进行中的回合也没有它的记录时，提示“已停下，这条消息没有被处理。”，结束等待、不再轮询，可重试（新的 `requestId`）。其余按历史里的停下记录收尾。
- Go 转发 `/assistant/chat` 不设整体超时，只限制等宿主回应头的时间（10 分钟）；NDJSON 持续到官方回合结束，包括模型重试与退避。
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
- `durable-recovery-cases.mjs`：延迟停止旧请求不能中止新请求；观察旧提交不能结算新回合；停止意图不能跨会话影响同名请求；提前停止的 Go 确认失败后，重开可补确认或按 Go 已关闭状态完成历史，始终零模型请求。官方 `wait` 进行中反复 `recover` 零提交、零写入、零授权，且不覆盖内存中的本轮改动；并发 `recover` 只提交一次。停止已写入、官方 `submit` 前崩溃，重启后记为已停下、零提交、同一请求重发也不执行；崩溃后按 `requestId` 停止，`recover` 不重新提交，下一条请求照常执行；已进官方队列的停下请求崩溃后被 `abort`，零模型请求。
- `durable-stream-events.test.mjs`：官方事件到 NDJSON 的映射、重试原因归类，以及历史进度的设置与清空。
- `model-stream-idle-cases.mjs`：官方空闲重试产生 `retry`（`timeout`）与 `retry_end`，不带上游原文。
- `session-lifecycle-host.test.mjs`：真实宿主运行中反复读取历史不再请求 Go 回合接口、不重写指针；503 首轮经官方重试后，流与历史都显示归类后的重试进度，结束后 `active` 为空；在 `/chat` 读取 Go 回合时、以及 `submit` 自己的授权读取时按请求停止，都零模型请求、零画布操作，历史记为已停下，Go 只结算这两条回合，之后的新请求照常执行；停止早于 `/chat` 到达时只停这一条，同一请求换 Go 回合重发、重启后都不执行且各自的 Go 回合被结算，重启后没有活动会话的停止返回 `pending` 而不是 404，未知会话或别的画布 404；运行中指向别的请求的停止不影响当前回合。
- React：`lifecycle` 与 `agent_end` 都不结算回合；压缩/重试文案不出现内部事件名；`observer_error` 后改为读取结果并显示历史里的进度（`assistant-stop.browser.test.ts`）；停下前已改动画布的回合提供“继续处理”，没有改动的停下回合不提供；发出前停下不留待发送内容，不发聊天或取消请求；发出后、助手还没处理就停下时，停止带这次发送的会话与请求标识，结束等待、不再轮询，重试用新的请求标识。
- Go：`assistant_request_stop_test.go` 覆盖 `requestId` 格式校验（不合格 400 且未进入回合）、不替代 Go 回合 ID、旧调用不带它；停止只转发校验过的目标，成对缺失或格式不对 400，别人的画布 404。

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
- 旧 JSONL 会话只读：不自动迁入 Durable；发新消息时以交接说明开一条新 Durable 会话，旧文件保留。在接续会话创建之前按请求停止只记在宿主内存里：这段时间宿主崩溃会丢掉这条停止。
- 压缩依赖官方内部路径，其内部事件名不映射到面板。自动重试只以归类后的进度显示，次数与退避仍由官方策略决定。
- 官方 `SessionManager` 在出现 assistant 消息前延迟落 jsonl；宿主读取历史时只认已落盘的会话文件。
- Go 媒体操作、时间线修改、事务内本地渲染接入见 `agent-media-harness-integration.md`；没有改付费生成协议或默认主模型。
