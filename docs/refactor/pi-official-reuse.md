# 官方 Pi SDK 复用矩阵（钉选 0.87.1）

本页记录 BeefTV 内置助手宿主对 `@earendil-works/pi-coding-agent@0.87.1` 的取舍。实现以本仓库 `agent-host/` 与钉选包内声明、示例、文档为准；`pi.dev` 最新文档可能对应更高版本。

测试版本：`@earendil-works/pi-coding-agent@0.87.1`（未升级；撰写时 npm latest 为 0.99.2）。

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
| 全控 `ResourceLoader` + `createExtensionRuntime` | 采用 | 空 skills/prompts/themes/AGENTS，不读 cwd 祖先。 |
| `noTools: "builtin"` + `customTools` | 采用 | 不暴露 read/bash/edit/write 等内置工具。 |
| `message_end` | 采用 | 本轮助手正文的权威来源。 |
| `agent_settled` | 采用 | 自动工作结束。宿主 `turn_end` 只在 prompt 返回且观察到 settled（或 prompt 抛错）后发出。 |
| `agent_end` | 不当前终态 | `willRetry` 时后面还有压缩恢复或重试。不映射成 `turn_end`。 |
| `compaction_*` / `auto_retry_*` | 转发 | 经现有 NDJSON 的 `lifecycle` 行到 React；面板只显示用户语。 |
| `DefaultResourceLoader` | 不采用 | 会发现 AGENTS/skills/shell。 |
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

## 已验证（钉选 0.87.1）

- `session-owner.test.mjs`：真实 `createAgentSession` 创建 / 替换 / `abort`+`dispose`，以及 SessionManager JSONL 往返（不打模型）。并发 replace、指针 EISDIR 回滚、chat 占 busy、ensure 失败不吞。
- `session-settings.test.mjs`：真实 `SettingsManager.inMemory` 读出压缩/重试钉值与 `cacheWarming: "off"`。
- `session-lifecycle-host.test.mjs`：真实宿主 HTTP 新建/并发替换、忙碌 409、指针目录失败、SIGTERM 释放（本地替身模型）。
- `interrupted-host.test.mjs`：SIGKILL 后重启仍能读到 `turn_interrupted` 原话。
- `host-runtime-probe.test.mjs`：预算耗尽、素材参数、引用画布读取。
- React：`lifecycle` 与 `agent_end` 都不结算回合；压缩/重试文案不出现内部事件名。

## 限制

- 未接官方 web-ui / TUI / 实验服务器。
- 未升级 SDK。
- 压缩与自动重试依赖官方内部路径；测试覆盖事件映射与设置钉值，不打付费模型。
- 官方 `SessionManager` 在出现 assistant 消息前不落 jsonl。刚创建就被替换或释放的会话可能不会出现在 list 里；活动会话仍以内存 Map 与 `current.json` 为准。
- Go 运行时、操作层、数据库、生成链路不在本切片。
