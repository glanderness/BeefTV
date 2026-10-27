# PR #283 第三轮独立复查

结论：**不通过，仍有一项 P2 必须修复：思考清空后，轮询读取进行中历史的路径会继续显示旧内容。** 跨工具调用的思考丢失已经修复；实时快照和终态清空也已经修复，但进行中历史漏传空数组。

评审对象：[PR #283](https://github.com/glanderness/BeefTV/pull/283)，固定 head `a7fa434784da139987cf93d57378b7b46ffd3468`。本轮只新增这份报告，没有修改产品代码、评论 PR、推送或合并 PR，没有调用真实付费模型或操作用户正在使用的客户端。尚未满足“检查没问题再发群、更新飞书表格”的条件，这两项未执行。

## 必须修复

### P2：进行中历史省略空思考，轮询中的界面保留旧内容

位置：[agent-host/server.mjs:482](https://github.com/glanderness/BeefTV/blob/a7fa434784da139987cf93d57378b7b46ffd3468/agent-host/server.mjs#L482)。受影响调用方：[web/src/pages/canvas/use-canvas-assistant.ts:327](https://github.com/glanderness/BeefTV/blob/a7fa434784da139987cf93d57378b7b46ffd3468/web/src/pages/canvas/use-canvas-assistant.ts#L327)，轮询入口为同文件 `:368`。

`/history` 只在 `entry.turnProjection.reasoning.length` 非零时写 `active.reasoning`。可读思考被整块、整条消息或 snapshot 替换为空／redacted 后，投影虽然已经清空，也会向当前流订阅者发送 `segments: []`，历史响应却省略 `active.reasoning`。前端在没有流控制器、改为每两秒读取历史时，只在这个字段是数组时更新思考；字段缺失便继续保留之前的内容。

因此，面板通过历史恢复进行中的回合，或流断开后继续轮询时，如果先读到过可读思考，之后宿主把思考清空，旧抽屉和旧文字仍会显示，直到拿到结束回执。修复 `reasoning_snapshot` 和 `turn_end.reasoning` 不能覆盖这条正在使用的历史读取路径。这属于上一轮“清空后别留旧内容”的遗漏，不涉及新增过滤要求。

**独立反例：** 使用被审版本的真实 `createDurableTurnProjection`、真实 React hook 与侧栏。历史响应执行从该版本 `server.mjs` 直接读取的 `waitForDurableProjection` 到 `respond` 之间的实际语句，仅把持久存储和 HTTP response 换成本地端口替身；没有重新写一份历史字段筛选算法。

1. 投影收到可读 thinking；第一次历史返回它，浏览器展开后看见“轮询里应当消失的旧思考”。整个场景没有 `/chat` 流控制器。
2. 用官方 `message_update` 的 `block` 替换，把唯一思考块改为 `redacted: true`。投影变为零段，并正确产生一个 `segments: []` 清空事件。
3. 再次通过真实 hook 读取历史。实际历史出口省略 `active.reasoning`；浏览器仍显示旧文字。
4. 对照只让同一历史响应明确携带 `reasoning: []`，真实 hook 随即撤掉抽屉，无需改动组件。

反例回读：

```json
{"probe":"轮询清空","hostSegments":0,"clearEvents":1,"historyHasReasoning":false,"oldTextStillVisible":true}
```

反例测试的 `1 pass` 表示成功复现缺陷及验证空数组对照，不表示产品通过。这里没有用真实供应商验证“已公开文本变成 redacted”的发生频率；输入是官方支持的替换事件，与上一轮清空问题采用同一验收条件。

**最小修复方向：** 与相邻的 `active.streamed` 一样，投影已经初始化时总是写 `active.reasoning`，包括空数组；未取得初始投影时仍可省略字段。补“已有内容→空／redacted→读取进行中历史→撤掉旧抽屉”的回归。不要把所有字段缺失一概清空，以免将尚未观测到的状态当成确定空值。

## 已确认通过的部分

| 核查项 | 本轮独立证据 |
| --- | --- |
| 工具前思考保留 | 官方 Pi 1.3.0、真实宿主、本地 Anthropic SSE 替身完成“思考→真实 `canvas_get` 调度→另一条 assistant 的思考→正文”。实时最后快照、`turn_end.reasoning`、历史三者相等。 |
| 最终消息没有可读思考 | 独立脚本让最后一条 assistant 只有 redacted 块和正文，工具前可读思考仍保留。连续两轮、四次本地模型请求，轮次内容没有重复混入。 |
| 停止和重启 | 工具后收到第二段思考时停止；结束记录和进程重启后的历史仍有两段。恰好两次本地模型请求，读历史未新增模型请求。 |
| 实时和终态清空 | 原投影用例覆盖空 thinking、redacted、整条消息及 snapshot 替换；浏览器原用例验证 `segments: []` 和 `turn_end.reasoning: []` 分别撤掉旧抽屉。遗漏仅见上面的进行中历史路径。 |
| 签名与 redacted 载荷 | 独立假模型同时发送 `signature_delta` 和 `redacted_thinking.data`；NDJSON、终态及重启后历史均没有合成标记。可读 thinking 继续按文本显示。 |
| 工具参数 | 投影的原负向用例仍通过：工具参数标记不进入正文／思考快照；工具记录仍走原有字段。 |
| 删除过滤后的引用 | 在宿主、打包脚本、后端、前端和对应测试搜索 `hostCredentialValues`、`publicThinkingText`、`CREDENTIAL_FORMATS`，没有残留引用。旧投影文件名仅在说明改名的历史文档中出现；实际打包与打包后宿主启动通过。 |
| 前端类型和相邻功能 | TypeScript 检查通过；助手展示、流式解析和历史恢复相邻用例全部通过。 |
| 结构 | 依据 structural-review 直接检查投影取数、宿主完成记录及前端更新路径；没有发现需要另外提出的结构性必修项，没有引入外部评审模型。 |

独立宿主探针回读：

```json
{"probe":"跨工具与重启","finalThinking":true,"modelCalls":4,"turns":2,"segmentCounts":[2,2],"historyEqual":true}
{"probe":"跨工具与重启","finalThinking":false,"modelCalls":4,"turns":2,"segmentCounts":[1,1],"historyEqual":true}
{"probe":"工具后停止与重启","modelCalls":2,"segmentCount":2,"historyEqual":true}
```

## 输入与范围

- 已读取 #61 分支 `tds/conv-01a17ce0-f9ad-74d0-8d5b-c4e8ba58e226` 的完整 `reviews/pr283.md`，以及 #58 分支 `tds/conv-01a17ca2-4d49-73c4-ba1b-dfd071ca77f2` 的完整 `docs/plans/assistant-message-display.md`。
- 已读取 #62、#65 任务约束，对照 `7880e20 → 7489cbb → a7fa434` 的实际修改，重点检查两项 P2 是否保留修复、删除过滤有没有影响字段选择和引用。相对原共同祖先 `3f251c7862ed97fb48c6d38e958798e9c2e720da` 共 25 文件，`+1231/-115`。
- **凭据过滤不作为通过条件。** 用户当前决定取代旧评审 P1 和旧方案中的凭据正则替换、未完整前缀扣留要求。本轮不要求恢复这些代码，也不把方案中未经用户确定的其他防护或展示建议升级成必修项。
- “只发送可读文字”经当前代码和合成本地协议回读核实：投影显式挑选 thinking／text，不序列化完整 SDK block；React 思考组件按纯文本显示。这个结论针对结构化签名、redacted 载荷和工具参数，不附加对普通文字的过滤要求。
- 本轮是 Codex 直接独立复查，未调用其他代理或付费评审模型。

## 本轮验证

在固定 head 的临时源码副本安装锁文件依赖并运行；当前任务工作树只写本报告。使用 Bun 1.4.2、Node 24.22.1。Node 可执行文件取自已安装应用的运行时，仅执行隔离测试进程，没有启动或修改正式客户端。

| 命令／验证 | 结果 |
| --- | --- |
| `bun test agent-host/durable-stream-events.test.mjs agent-host/durable-session-owner.test.mjs` | 21 通过、0 失败；包含官方 Node SQLite 子套件，包装用例确认 `fail 0`。 |
| `bun test agent-host/durable-stream-events.test.mjs agent-host/durable-session-owner.test.mjs agent-host/session-lifecycle-host.test.mjs --test-name-pattern 'Anthropic\|跨工具\|projection\|reasoning\|思考\|durable session'` | 14 通过、26 过滤、0 失败；包含两项真实宿主思考场景。完整 session-owner 包装用例由上一行单独运行。 |
| `bun test scripts/package-agent-host.test.mjs`，指定 Node 24.22.1 运行时目录 | 3 通过；macOS arm64 打包、锁文件依赖、带空格路径和打包宿主启动，打包启动场景零模型请求。 |
| `cd backend && go test ./internal/handler -run Reasoning -count=1` | 通过。 |
| `cd web && bun test test/assistant-stream-progress.browser.test.ts` | 4 通过、0 失败。 |
| `cd web && bun run typecheck` | 通过。 |
| `cd web && bun test test/canvas-assistant-presentation.test.ts test/canvas-agent-assistant-stream.test.ts test/assistant-history-recovery.test.ts test/assistant-history-failure.test.ts` | 88 通过、0 失败。 |
| 独立宿主探针：正常／无最终思考／停止、连续轮次、重启后历史、签名和 redacted 负向断言 | 3 通过、34 项断言；共 10 次本地假模型请求。 |
| 独立浏览器反例：实际历史出口语句＋真实投影＋真实 hook／侧栏＋空数组对照 | 1 通过、7 项断言，确认上述 P2 仍存在。 |
| 被审差异 `git diff --check` | 通过。 |

临时探针复用 `session-lifecycle-host.test.mjs` 的 `withHost` 基础设施，只新增本地 SSE 脚本与断言，产品模块原样运行。历史清空反例按前文说明替换持久存储／HTTP response 端口，没有声称跑过完整 Go→宿主→浏览器清空链路。测试完成后清理本轮临时副本、探针及依赖。

本轮未跑全部后端／前端测试、完整桌面构建、正式 App UI、真实模型或其他供应商协议验收。现有证据足以确认两项原缺陷的修复范围和本轮遗漏，不能据此声称上述未测环境通过。

## CI

最后读取：**2026-10-27 11:24:07 UTC**，PR 仍为 `OPEN`，head 仍为 `a7fa434784da139987cf93d57378b7b46ffd3468`。

| 检查 | 状态 |
| --- | --- |
| [Director P0 Chrome E2E](https://github.com/glanderness/BeefTV/actions/runs/40494424633/job/122156145864) | 通过 |
| [Linux desktop package checks／linux](https://github.com/glanderness/BeefTV/actions/runs/40494424747/job/122156145920) | 通过 |
| [Windows storage migration](https://github.com/glanderness/BeefTV/actions/runs/40494424630/job/122156145957) | 通过 |
| [Release publisher checks](https://github.com/glanderness/BeefTV/actions/runs/40494424630/job/122156146424) | 通过 |
| [Backend checks](https://github.com/glanderness/BeefTV/actions/runs/40494424630/job/122156146579) | 通过 |
| [Web checks](https://github.com/glanderness/BeefTV/actions/runs/40494424630/job/122156146214) | 仍在运行，步骤为 Run tests；尚无最终通过结论 |
| Published Windows upgrade and rollback | 跳过 |
| SQLite and runtime | 跳过 |

已通过的 CI 没有覆盖上面复现的进行中历史空值问题；Web 未完成也未被记作通过。

已更新原有项目记忆与 nmem 学习记录 `a847ec9c-4e2d-45d2-a9aa-7952cdf021f9`，补充“空数组检查须覆盖活动历史”的复查方法；本次主动沉淀未另建本地记忆副本，版本结论仍以本报告及后续代码为准。
