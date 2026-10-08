# 官方 Pi SDK 复用矩阵（钉选 1.0.4）

本页记录 BeefTV 内置助手宿主对官方 Pi 1.0.4 的复用。新会话使用 `@earendil-works/pi-durable`，已有 JSONL 会话继续使用 `pi-coding-agent`。每条会话只由一个官方执行框架驱动。实现以本仓库 `agent-host/` 与钉选包内声明、示例、文档为准；`pi.dev` 最新文档可能对应更高版本。

本地钉选版本：`pi-durable`、`pi-coding-agent`、`pi-ai` 与 chord 1.0.4。配套 agent-core、codemode、mcp、tui、telemetry 通过 overrides 同钉 1.0.4，避免上游范围依赖自动选择未经验证的版本。锁文件由 Bun 生成；没有修改官方包或另建模型执行循环。Durable 接入验证见 [持久宿主验收](durable-host-verification-20261008.md)。

## 新会话的官方 Durable 路径

- `durable-session-owner.mjs` 使用 `Harness.open`、`openNodeSqliteStorage`、`defineDoc`、`defineExtension`、`defineTool` 与 `watchEvents` 管理会话、提交、工具与持久事件；不在 AgentSession 外再套 Harness。
- Go 拥有业务回合、素材归属、权限、付费批准、操作去重与撤销。宿主开始或恢复执行前读取 Go 回合记录；HTTP 客户端离开不自动结算持久执行。
- 每轮工具通过官方 `registry.install` 和 `root.configure` 配置。内置“只读 / 当前画布 / 完全访问”由 Go 持久记录决定，补充消息和恢复不能升权；具体合同见 [Agent 权限与外部工具](agent-access-20261008.md)。
- 媒体短引用保存在会话中，实际发出模型请求前读取已校验的文件并重新核对当前业务归属。Skills 使用明确选定的版本与内容摘要，经官方扩展展开正文，不自动扫描宿主机文件或执行包内脚本。
- 以下 SDK 矩阵和 JSONL 所有权规则仅说明已有 SDK 会话，不是新 Durable 会话的数据格式。

## 官方来源

| 来源 | URL / 路径 |
| --- | --- |
| 公开 SDK 文档（可能新于钉选） | https://pi.dev/docs/latest/sdk |
| 公开事件流说明 | https://pi.dev/docs/latest/json |
| 公开设置参考 | https://pi.dev/docs/latest/settings |
| 仓库 | https://github.com/earendil-works/pi |
| 钉选 SDK 文档 | `node_modules/@earendil-works/pi-coding-agent/docs/sdk.md` |
| 钉选事件语义 | `node_modules/@earendil-works/pi-coding-agent/docs/json.md` |
| 钉选设置默认值 | `node_modules/@earendil-works/pi-coding-agent/docs/settings.md` |
| 全控装配示例 | `examples/sdk/12-full-control.ts` |
| 会话替换示例 | `examples/sdk/13-session-runtime.ts` |
| 设置示例 | `examples/sdk/10-settings.ts` |
| 会话持久化示例 | `examples/sdk/11-sessions.ts` |

## 复用矩阵

| 官方能力 | 决定 | 说明 |
| --- | --- | --- |
| `SessionManager` JSONL v3 | 采用 | 唯一 transcript。画布轮次写 `beeftv.canvas.turn` / `.started` custom entry，不另建聊天库。 |
| `createAgentSession` | 采用 | 每条画布会话的工厂：`noTools: "builtin"` + `customTools` + 全控 `resourceLoader`。 |
| `AgentSession.prompt` / `abort` / `subscribe` / `dispose` | 采用 | `prompt({ expandPromptTemplates: false, source: "rpc" })`。替换前 `await abort()` 再 `dispose()`，与 Runtime `teardownCurrent` 相同。 |
| `AgentSessionRuntime` | 不采用 | 官方 factory 面向 cwd 发现服务；`switchSession` 用 `SessionManager.open(path, undefined)`，会丢掉本宿主按画布编码的 `sessionDir`。画布级 `customTools` 仍要重绑。显式 dispose 更短且正确。 |
| `SettingsManager.inMemory` | 采用并显式钉值 | 压缩 `enabled/16384/20000`，重试 `3/2000/60000`，`provider.maxRetries=0`。不提高这些上限。`cacheWarming: "off"`，避免官方默认 streaming 额外打模型。 |
| 全控 `DefaultResourceLoader` | 采用 | 每条会话单独装配；`noExtensions/noSkills/noPromptTemplates/noThemes/noContextFiles` 全开，仅加载产品明确传入的 `extensionFactories`；设置使用 in-memory，保留产品 system prompt。 |
| `before_provider_request` | 保留扩展能力，本次不挂媒体转换 | 官方会捕获 hook 异常并继续原请求。本次在实际 HTTP dispatch 前转换已验证的媒体结果，失败阻止请求。pi 的 text/image 消息仍用官方会话保存，音视频由有界 MIME data URI 进入已验证的 Gemini OpenAI-compatible 路由。 |
| `AgentSession.steer` | 采用 | 当前会话运行中接受文字补充；旧响应中的写工具被拒绝，下一次官方模型请求读取补充。扩展到图片补充或离线后台继续不在本切片。 |
| `noTools: "builtin"` + `customTools` | 采用 | 不暴露 read/bash/edit/write 等内置工具。 |
| `message_end` | 采用 | 本轮助手正文的权威来源。 |
| `agent_settled` | 采用 | 自动工作结束。宿主 `turn_end` 只在 prompt 返回且观察到 settled（或 prompt 抛错）后发出。 |
| `agent_end` | 不当前终态 | `willRetry` 时后面还有压缩恢复或重试。不映射成 `turn_end`。 |
| `compaction_*` / `auto_retry_*` | 转发 | 经现有 NDJSON 的 `lifecycle` 行到 React；面板只显示用户语。 |
| 官方 TUI / RPC 实验服务器 | 不采用 | 产品 UI 是 React + Go 代理。 |
| `@earendil-works/pi-web-ui` | 不采用 | 钉选时代的包是过期 Lit + IndexedDB，且会在浏览器里跑 Agent。 |

## 宿主内部分工

| 模块 | 责任 |
| --- | --- |
| `session-owner.mjs` | 官方会话创建、按画布预约队列、替换、abort+dispose、原子指针、prompt 结算。 |
| `operation-bridge.mjs` | 已鉴权 `/api/ops`、scope 注入、`customTools`。 |
| `server.mjs` | 本机 HTTP、鉴权、预算 fetch 包装、NDJSON、SIGTERM/SIGINT 释放会话。 |

## 会话所有权

- 预约按 `canvasId`：`ensureSession` / `replaceSession` / `acquireChatSession` 共享一条队列；不同画布并行。
- `acquireChatSession` 在同一把锁里 restore/create 并置 `busy`，然后才释放锁去跑 prompt。忙碌会话的 replace 在工厂之前拒绝（409 `session_busy`）。
- 候选先 `createAgentSession`，指针 `current.*.tmp` + `rename` 成功后才写入 Map；指针失败则 dispose 候选、保留旧活动会话。
- `ensureSession` 只把缺失指针（`ENOENT`）和 `session_not_found` 当成可回退：先 list 可恢复历史，再新建。EISDIR、损坏 JSON、SDK 装配失败原样抛出。
- `disposeOwnedSession` 用 `disposed` 标记，abort+dispose 只走一次。进程 `SIGTERM`/`SIGINT` 先把 store 标为关闭，排空该画布预约队列里已入队的 ensure/replace/chat 占位，再 `disposeAll`。关闭后新的预约直接失败。`SIGKILL` 仍无法拦截，中断回执语义不变。

## 仍由本产品持有

- 画布 scope、operationId、用户确认后的生成、单轮/总预算、中断回执、按画布身份。
- React 只消费 `/api/assistant/*` 流，不在浏览器建 Agent 或 SessionManager。

## 已验证（钉选 1.0.4，本地替身，无付费模型）

- `session-owner.test.mjs`：真实 `createAgentSession` 创建 / 替换 / `abort`+`dispose`，以及 SessionManager JSONL 往返（不打模型）。并发 replace、指针 EISDIR 回滚、chat 占 busy、ensure 失败不吞。
- `session-settings.test.mjs`：真实 `SettingsManager.inMemory` 读出压缩/重试钉值与 `cacheWarming: "off"`。
- `full-control-loader.test.mjs`：不加载外部 AGENTS、Skill、extension、追加 system prompt；两条真实 SDK 会话的官方 payload hook 分别保持自己的画布 scope。
- `session-owner.test.mjs`：prompt 正常返回但最终 assistant 为 error 时仍判失败；自动重试最终成功不沿用旧错误；升级前 JSONL v3 fixture 的用户消息、BeefTV 轮次与会话身份仍可读取。
- `session-lifecycle-host.test.mjs`：真实宿主 HTTP 新建/并发替换、忙碌 409、指针目录失败、SIGTERM 释放（本地替身模型）。
- `interrupted-host.test.mjs`：SIGKILL 后重启仍能读到 `turn_interrupted` 原话。
- `host-runtime-probe.test.mjs`：预算耗尽、素材参数、引用画布读取。
- React：`lifecycle` 与 `agent_end` 都不结算回合；压缩/重试文案不出现内部事件名。

2026-10-08 当前升级验证：`bun install --frozen-lockfile` 通过；完整 `agent-host` suite 97 项通过、0 失败（185.98 秒）。额外实际 Node + 官方 SDK 原生媒体/steer 探针 4 个场景通过，JPEG/WAV/MP4 真实字节进入模型 HTTP 请求，9 次请求均为本机替身、没有付费模型调用。

## 宿主扩展装配

`createSessionStore` 接受可选 `createResourceLoader({ canvasId, cwd, agentDir })`。工厂返回官方 loader，宿主在创建会话前调用 `reload()`；默认使用 `createFullControlLoader({ cwd, agentDir })`。显式扩展可由 `extensionFactories` 装配；本次媒体转换直接在宿主 HTTP dispatch 执行，不依赖 hook 的异常处理，同一会话只保留官方执行循环。

## 限制

- 未接官方 web-ui / TUI / 实验服务器。
- SDK 路径不自动提供进程被杀后继续工具执行；新 Durable 会话另由官方 SQLite storage 持久执行。已有 JSONL 历史、会话指针与中断回执继续由官方 SessionManager 和宿主持有，不自动迁入 Durable。
- 压缩与自动重试依赖官方内部路径；测试覆盖事件映射与设置钉值，不打付费模型。
- 官方 `SessionManager` 在出现 assistant 消息前延迟落 jsonl。宿主在发布新会话指针前写官方 header 并重新打开，空会话跨进程恢复已有针对性测试。
- Go 媒体操作、时间线修改、事务内本地渲染接入见 `agent-media-harness-integration.md`；没有改付费生成协议或默认主模型。
