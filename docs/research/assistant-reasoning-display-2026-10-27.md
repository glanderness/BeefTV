# 画布助手显示思考过程（默认折叠）：实现与验证记录

需求：助手面板显示模型的思考过程，默认折叠；工具与正文分开显示。方案见 `docs/plans/assistant-message-display.md`（#58，未合并分支），本文件记录这一轮的实现与实测证据。

涉及模块：`agent-host/durable-turn-projection.mjs`（原 `durable-stream-text.mjs`）、`agent-host/server.mjs`、`agent-host/durable-session-owner.mjs`、`backend/internal/handler/agent_proxy.go`（转发核查）、`web/src/services/api/agent-assistant.ts`、`web/src/pages/canvas/use-canvas-assistant.ts`、`web/src/pages/canvas/canvas-assistant-sidebar.tsx` + `canvas-assistant-turn.tsx`、`web/src/components/ai/message-reasoning.tsx`。

## 一、结论

1. 宿主原来只投影可见正文（`createDurableTextProjection`），思考事件被有意丢掉。现在同一次投影同时产出两份只读视图：正文仍是 `text_snapshot.text`，思考是新增的 `reasoning_snapshot.segments`（`{id, text, status}`）。投影仍只读官方事件，签名、redacted 载荷、工具参数、上游原文都不进投影。
2. 终态与历史用同形字段：`turn_end.reasoning`、`history.turns[].reasoning`、活动回合 `history.active.reasoning`。宿主**总是**写这个字段：没有可读思考时是空数组，界面据此区分「这一轮没有思考」与「旧记录没有该字段」。**注意**：`publicDurableTurn` 用 key 白名单裁剪公开回合，新增字段必须同时加入白名单，否则「流里有思考、重开历史就没了」。这一条是本轮实际踩到的坑，已补用例。终态取本轮全部助手条目（原提交与补充输入之间、以确切结束条目为上限），与实时流共用同一份投影，所以工具调用前后的思考都在。
3. 界面：思考区在回复正文上方，默认折叠；标题按真实阶段从「正在思考…」变成「思考过程」；展开状态按回合记在运行记录里（进行中的那一轮用 `live` 键，回合结算后转到 `turnId`），用户展开后不自动折回，切换会话不串用。思考正文按纯文本渲染（保留换行），不按 Markdown 渲染，也不提供「复制思考」；复制回复仍只复制正文。
4. 工具与正文本来就是分开的（工具进度是正文之外的一行状态，工具结果/失败/改动是正文之后的卡片）。本轮没有把工具并入思考，也没有重做交错时间线。

## 二、数据形状（回环、合成凭据实测）

```
{"type":"session","sessionId":"durable:…"}
{"type":"reasoning_snapshot","segments":[{"id":"live-1:0","text":"先看当前画布上有哪些节点","status":"streaming"}]}
{"type":"reasoning_snapshot","segments":[{"id":"live-1:0","text":"先看当前画布上有哪些节点，再确认时间线顺序。","status":"streaming"}]}
{"type":"reasoning_snapshot","segments":[{"id":"live-1:0","text":"…","status":"done"}]}
{"type":"reasoning_snapshot","segments":[{"id":"live-1:0",…"done"},{"id":"live-1:1","text":"可以按开场和冲突连起来。","status":"streaming"}]}
{"type":"text_snapshot","text":"画布上一共有两个节点，"}
{"type":"text_snapshot","text":"画布上一共有两个节点，已经按开场、冲突连好。"}
{"type":"turn_end",…,"reasoning":[{"id":"reasoning:0","text":"…","status":"done"},{"id":"reasoning:1","text":"…","status":"done"}]}
```

规则：每次 `reasoning_snapshot` 都是**当前回合的完整替换**；`status` 只有 `streaming`/`done`，一个消息里最后一块还在长时才是 `streaming`，正文开始后思考一律 `done`（界面据此换标题）；进行中片段的 `id` 用轮内临时键（`live-<序号>:<contentIndex>`），`message_end` 后由官方 entry 身份接管，终态与历史沿用同一身份（`<entryId>:<contentIndex>`）；从没有可读思考时不发空快照，也不生成空抽屉，已经显示过又变空（块被替换成空或 `redacted`）时发完整空数组让界面撤掉旧内容。`turn_end` 与历史回合总是带 `reasoning`（可能为空数组）。

公开文本清理：思考正文在宿主出口统一走 `publicThinkingText()`（实时、终态、历史同一份），清掉已知宿主／模型凭据（`BEEFTV_AGENT_HOST_TOKEN`、`BEEFTV_AGENT_DESKTOP_TOKEN`、`BEEFTV_AGENT_API_KEY`）与明确凭据格式（`sk-…`、`Bearer …`、`名字 = 值` 形式的 key/token/secret/password）。已知秘密的未完整前缀先扣住，等后续分片到齐再决定替换或放行，避免跨分片先漏出去；只在秘密可能从一个值或词的开头出现时扣住，普通英文词尾不会被反复截断。签名、redacted 载荷与工具参数仍按字段白名单丢弃。这里只覆盖已知值与可判定的格式，不承诺识别任意自然语言里的秘密。

## 三、验证（全部零付费模型调用）

| 层 | 用例/命令 | 结果 |
| --- | --- | --- |
| 宿主投影 | `bun test agent-host/durable-stream-events.test.mjs` | 23 pass；含增量累积、streaming→done、思考→工具→思考→正文、redacted/空思考不出抽屉、溢出快照不重复、签名与工具参数不进快照、终态与历史同形，以及第二轮新增的凭据清理与「变空发空数组」用例 |
| 公开回合裁剪 | `bun test agent-host/durable-session-owner.test.mjs`（跑 `durable-session-owner-cases.mjs`） | 28 pass；含新增「历史投影保留可读思考、仍丢弃 provider 块」 |
| 真实宿主 + Anthropic 假模型 | `bun test agent-host/session-lifecycle-host.test.mjs` | 19 pass；含「两段思考各自增量到达、第二段追加、正文开始后不再 streaming、`message_end` 后片段身份换成官方 entry、正文快照不含思考、签名不出现在任何一行、`turn_end.reasoning` 与实时流同一份」与第二轮新增的「跨工具调用两段思考 + 合成凭据不外泄」 |
| Go 转发 | `go test ./internal/handler/ -run Reasoning` | 新增用例：`reasoning_snapshot` 逐行原样转发；`turn_end` 重新编码后 `reasoning` 仍在；历史回合保留 `reasoning`、同时后端仍覆盖宿主伪造的 `outputs` |
| 真链路（假 Anthropic 模型 → 真宿主 → 真 Go） | 见下「复现」 | 6 条 `reasoning_snapshot`、`turn_end.reasoning`、`history.turns[0].reasoning` 全部到位；签名 `sig-local-fake-secret` 在 NDJSON 与历史里都不出现 |
| 浏览器（真实 hook + 真实侧栏） | `cd web && bun test test/assistant-stream-progress.browser.test.ts` | 4 pass；新增思考用例断言默认折叠（正文不在 DOM 里）、展开看增量、正文与思考分开、回合结束后仍展开且标题变「思考过程」，第二轮新增「宿主发空思考快照」与「终态权威空思考」两个撤掉旧内容的用例 |
| 前端类型 | `cd web && bun run typecheck` | 通过 |
| 界面截图 | `/tmp/beeftv-pr-shots/60/`（本地，未入库） | 01 生成中折叠、02 生成中展开、03 回合结束折叠、04 回合结束展开、05 深色展开、06 窄栏抽屉折叠 |

负向对照（用例有没有牙齿）：

- 把生成中那一轮的思考抽屉改成强制展开，浏览器用例在「默认折叠」断言上失败：`Expected to not contain: "先看画布" / Received: "正在思考…\n先看画布上的两个节点。"`。
- 把 `reasoning` 从 `publicDurableTurn` 白名单里去掉，真实宿主用例在 `turn_end.reasoning` 断言上失败。

### 复现（本机回环，合成凭据）

```bash
# 1) 假 Anthropic Messages 模型（本地 SSE，两段思考 + 两段正文，不请求任何上游）
bun run /tmp/beef60/fake-anthropic.mjs                      # 127.0.0.1:18191
# 2) 隔离数据目录 + 环境变量覆盖模型（provider.go 的受控测试路径）
CANVAS_BACKEND_DATA_DIR=/tmp/beef60/data CANVAS_BACKEND_ADDR=127.0.0.1:18099 \
BEEFTV_AGENT_BASE_URL=http://127.0.0.1:18191 BEEFTV_AGENT_API_KEY=fake-local-key \
BEEFTV_AGENT_MODEL=fake-claude-4 BEEFTV_AGENT_PROTOCOL=claude-api BEEFTV_AGENT_THINKING=medium \
go run ./cmd/server
# 3) 数据目录里放 agent_config.json 指向宿主入口（开发态没有随包运行时）；
#    宿主运行时用 Node ≥ 24（NODE_USE_ENV_PROXY=1 时需要 http.setGlobalProxyFromEnv）
# 4) 签发 UI 会话（owner token 来自数据目录）→ 建画布 → 发一轮 → 读历史
```

## 四、未覆盖与边界

1. **哪些渠道真的会返回可读思考**：`canvas-turn.mjs` 的 `providerRegistration` 目前只把 `anthropic-messages` 标为 reasoning，OpenAI 兼容协议保持关闭。不返回思考时面板维持现状（工具进度 + 正文），不伪造、不生成空抽屉；「模型未提供可查看的思考内容」这类提示本轮未做。
2. **没有跑真实桌面客户端**：WKWebView 的 localStorage 按 bundle id 存储，仅换数据目录不隔离，测试实例会写进用户真实客户端同一份存储。本轮用真实浏览器（真实 hook + 真实侧栏）+ 真实宿主/Go 链路验证，未驱动已安装的正式 App。
3. **方案 §5 规则 3 的「工具操作记录收成一处、默认折叠」未在本轮实现**：工具进度仍是正文之外的既有状态行，工具结果/失败/改动仍是正文之后的卡片；`lifecycle` 也没有补 `toolCallId`（本轮的展示没有消费者，补字段属另一项工作）。
4. **交错时间线未做**：同一回合里「正文 A → 工具 → 正文 B」仍按既有行为拼成一段正文；方案已把重做完整交错时间线列为新增工作，第一版不以此为前提。
5. 思考文本是模型给的参考文本，不是执行回执、授权或计划依据；默认折叠只是视觉状态，不提供保密。

## 五、PR 复查修复（第二轮）

独立复查（PR #283 的评审记录）指出三项缺陷，本轮逐项修复并补了修前会失败的用例。

1. **P1 思考文本未经凭据过滤**：公开出口现在统一走 `publicThinkingText()`，清掉已知宿主／模型凭据与明确凭据格式；已知秘密的未完整前缀先扣住。合成凭据只在本地回环替身里出现，未使用真实凭据。负向探针（同一份无模型片段）修前 `{host:0, events:0, shown:1, leaksHostToken:true, leaksKey:true}`，修后 `{host:0, events:1, shown:0, leaksHostToken:false, leaksKey:false}`。
2. **P2 终态只投影最后一条消息的思考**：`completionRecord()` 改用原提交、补充输入与确切结束条目限定的本轮全部助手条目，终态与历史复用实时流的同一份投影，片段身份为 `<entryId>:<contentIndex>`。真实宿主用例（两段思考中间夹 `canvas_get`）断言流式最后一个快照、`turn_end.reasoning`、`history.turns[0].reasoning` 三者相等，且恰好两次本地模型请求。
3. **P2 思考被替换为空或 redacted 时前端收不到清空通知**：投影在已经推送过可读思考后变空时发 `segments: []`（从未有可读思考时仍不发）；终态与历史总是带 `reasoning`（可能是空数组），前端只在字段确实缺失（旧记录）时才退回流里的片段。

修前对照：把两个生产模块还原到本轮 head 再跑新增的真实宿主用例，在「合成凭据被清掉」的断言上失败（收到的是原样的 `host_token="synthetic-lifecycle-host"`）；只还原投影模块的负向探针见第 1 条。
