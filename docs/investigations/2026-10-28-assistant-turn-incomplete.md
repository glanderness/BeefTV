# 内置助手停在「正在读取处理结果」、回合未完成（2026-10-28）

## 结论

1. **报错原因代码 `model_error` 是模型侧失败，不是客户端缺陷。** 该回合「工具调用数 0、失败数 0」，说明这一轮在第一次模型请求上就没拿到回复。宿主把传输层失败/超时归类成 `model_error` 并保留已完成的工具结果（`agent-host/model-transport-error-cases.mjs` 断言响应头超时 → `errorReason: 'model_error'`；超时口径见 `docs/refactor/assistant-host-lifecycle.md`：响应头 180s、成功后无进展 95s，均不自动重试）。模型渠道当时为什么没回（鉴权、余额、被中断还是超时）属于上游原文，宿主只保留在内部诊断里，客户没有导出诊断包，无法进一步分辨。
2. **客户端确有两个缺陷，让「等回执」变成「卡住」，已修。**
   - 面板在断流后等待回执时，读的是**画布当前指针指向的对话**，而不是这一轮实际落在的对话；指针被切走（会话交接、别处切换）后，回执永远认领不到，面板一直停在「正在读取这次处理的最终结果」，输入框一直被禁用。
   - 「知道了」只清错误和待发送文本，**没有收回等待回执**，所以点完它输入框仍然锁着，还每 2 秒继续轮询一个永远不会认领的回执。
3. **与生成任务取回/扣费无关**，未触碰该路径（交 #88 统一实施）：本轮失败发生在模型请求，没有创建生成任务，也没有工具调用。

## 原始诊断（已去客户标识与密钥）

来源：飞书需求表 Base `OcHnbZCXjaMwwrsx4laciEvRnHo` / 表 `tblvTTmtzdPF6qxx` 行 `reczz28SeZHL5QwN`，由每日企微反馈采集登记；截图附件 `bug4-canvas-error.png`。

- 客户界面：停在「正在读取处理结果」，随后出现提示「这一轮未能确认完成，可能已有改动。请先查看画布并重新读取对话，再决定下一步。」（按钮：重新读取 / 知道了）。
- 客户通过界面「复制排查信息」提交：应用版本 v2.0.4、构建提交 `542124b`、助手状态「未完成」、**原因代码 `model_error`**、轮次创建时间 `2026-10-27T16:16:18Z`、**工具调用数 0、失败数 0**、未记录 Trace ID。
- `542124b` 已核对：是 `v2.0.4` 与当前 `main` 的共同祖先，即客户跑的确实是 v2.0.4 的助手代码。
- v2.0.4 → 当前 main 在助手这条路径上的差异只有「思考过程展示」（`#283`）新增的 `reasoning` 投影与展开状态；断流恢复、回执认领、`awaitingReceipt` 相关代码逐行比对**没有变化**，所以旧版本反馈里的这一段在当前代码同样成立，不能按「新版已修」放过。

## 因果链

```
模型请求失败/被截断（上游没给出回复）
  → 宿主按传输失败收尾：status=unanswered，errorReason=model_error，toolCalls=[]
  → 浏览器这一条 NDJSON 观察流没有拿到 turn_end（也没有 observer_error）
  → use-canvas-assistant 进入不确定态：error=「这一轮未能确认完成…」，
    recovery 已登记，awaitingReceipt=true → 面板显示「正在读取这次处理的最终结果」
  → 之后每 2 秒读一次回执；回执只认「发送时那条对话里、新出现的、正文与选中项都对得上的那一轮」
```

停在最后一步的原因（本次修复的两处）：

- 读回执时请求里不带会话标识，宿主回的是**画布当前指针**指向的对话。发送之后指针若移走（旧会话交接成 Durable 会话、别处切换对话），当前对话里根本没有这一轮，`findRecoveredAssistantTurn` 的会话校验永远不过，等待无解。
- 唯一给用户的出口「知道了」只做了一半：清掉错误与待发送文本，却留着 `recovery`，于是 `awaitingReceipt` 仍为真 —— 输入框继续禁用（`send()` 里 `awaitingReceipt` 早退、输入区 `inputBusy` 为真），轮询也继续。

## 复现与验证（免费、可重放）

`web/test/assistant-receipt-recovery.browser.test.ts` 用真实 `useCanvasAssistant` + 假宿主（无模型、无付费）复现：

| 用例 | 修复前 | 修复后 |
| --- | --- | --- |
| 画布当前对话被切走，回执仍按这次发送的对话读回来 | 失败（`awaitingReceipt` 永远为真，8s 超时） | 通过 |
| 回执永远读不到时，「知道了」释放输入框并停止轮询 | 失败（`awaitingReceipt` 仍为 true） | 通过 |

「修复前」是把 `web/src/pages/canvas/use-canvas-assistant.ts` 换回 `HEAD` 版本后实测（两条都失败），不是推断。

```bash
cd web && bun test test/assistant-receipt-recovery.browser.test.ts
```

本次跑过的验证：

| 命令 | 结果 |
| --- | --- |
| `bun test test/assistant-receipt-recovery.browser.test.ts`（修复后 / HEAD 版本） | 2 通过 / 2 失败（失败即上面两行） |
| `bun test test/assistant-proposal-invalidation.browser.test.ts`（修复后） | 2 通过（改动前该文件在 `loadHistory` 兜底版本下第一条稳定失败，见上一节） |
| `bun test test/assistant-stop.browser.test.ts test/assistant-stream-progress.browser.test.ts test/assistant-proposal-invalidation.browser.test.ts test/assistant-receipt-recovery.browser.test.ts` | 15 通过 0 失败（4 个文件） |
| `bun run typecheck` | 通过 |
| `bun run test`（项目全量入口：共享批次 + 每个浏览器用例单独跑） | 通过：586 个文件、4357 项、0 失败、退出码 0（日志确认新用例 `assistant-receipt-recovery` 2 通过、既有 `assistant-proposal-invalidation` 2 通过） |

全量套件按项目脚本 `web/scripts/run-test-suite.mjs` 跑（`bun run test`）：先跑共享批次，再逐个跑隔离用例（浏览器用例与替换模块的用例）。**本轮该命令已跑完，退出码 0，记为通过。**

### 全量套件（`bun run test`）

- 2026-10-28 本轮实测（修复后）：`pretest` 通过；共享批次（一次调用，0 失败）；隔离用例按文件逐个跑完 106 个文件，全部 0 失败；合计 586 个文件、4357 项、0 失败，整条命令退出码 0。日志里没有任何 `(fail)` 行，新增与既有助手用例都在其中跑过。
- 上一轮（改动前）同一条命令的结果是：整套只有 `test/assistant-proposal-invalidation.browser.test.ts` 第一条失败，其余通过；该失败已在本轮查明并消除（见上一节），修复后该文件单独重跑 2 通过，全量里同样通过。
- 注意：不要用不带参数的 `bun test` 当全量入口。它会把这 586 个文件塞进同一个进程（含 62 个浏览器用例各自拉起 Chrome），实测 30 分钟仍未结束；项目自己的入口 `bun run test` 才是把隔离用例逐个跑的脚本。

## 改动

`web/src/pages/canvas/use-canvas-assistant.ts`

1. **等这一轮回执的读取都点名「面板正在显示的那条对话」**（`run.sessionId`），而不是让宿主按画布当前指针去挑：断流后的读回执（`AgentStreamDetachedError` 分支）、发出后失败分支的读回执、2 秒轮询（`backgroundActive || recovery` 时）、以及「停止」取消后的读回执，四处调用都带上会话标识。回执只可能落在发出去的那条对话里；宿主对点名请求直接读那条对话，所以这是「读该读的地方」，没有放宽 `findRecoveredAssistantTurn` 的判定（仍是「发送那条对话里、唯一一条正文与选中项都对得上的新回合」）。
2. 抽出 `clearPendingSend`，让「停止」和「知道了」共用同一套收尾：`dismissError` 现在把等待回执一起收回，输入框解锁、轮询停止，已显示内容与历史回合不动。

`web/test/fixtures/assistant-stop-harness.tsx` 增加「知道了」按钮（夹具补一个 hook 出口）。

宿主侧口径已对照 `agent-host/server.mjs` 的 `GET /history` 确认（假宿主按同形实现）：点名 `sessionId` 时读的就是那条对话（Durable 会话走 `durable.history(canvasId, sessionId)`，会话不在当前指针上也照样按标识从落盘状态读出它的回合），不点名才回落到 `currentId(canvasId)`（画布当前指针）。

### 为什么不是改 `loadHistory` 的默认目标
第一版把兜底放在 `loadHistory` 里（不点名时读 `run.sessionId`），行为上等价，但会让既有回归用例 `web/test/assistant-proposal-invalidation.browser.test.ts` 的第一条稳定失败（`historyReads` 期望 2、实际 1）。查明原因并**独立验证**如下：

- 该用例把「turn_end 后的权威回执读取」按住不放，再触发一次手动「重新读取」，用两个响应构造「旧读取晚于新读取返回」的竞态。
- 兜底放进 `loadHistory` 后，手动「重新读取」的 URL 与那条被按住的读取**完全相同**（都带 `sessionId=s1`），而 Chromium 会把同一时刻发往同一 URL 的 GET 合并成一个网络请求（后发的等前一条结束才发出）。用与业务无关的最小探针验证过：页面里并发 `fetch` 同一个 URL 两次 + 另一个不同 URL，服务端在第一条被按住期间只收到 `1` 次同 URL 请求、另一次不同 URL 请求，释放后才补上第二条同 URL 请求。也就是说这条用例构造的竞态在该改动下已经**不可能发生**，用例失去牙齿。
- 因此改为只在「等这一轮回执」的调用点点名会话：`loadHistory` 的默认语义（不点名读画布当前指针）和手动「重新读取」的目标都不动，既有用例一行不改、继续通过，本次也没有放宽任何断言。



## 仍未确认的部分

- 上游原始报错（鉴权/余额/超时/被中断）只存在于宿主内部诊断，客户未导出诊断包，无法给出确切的上游原因；`model_error` 是「没有匹配到更具体分类」的兜底归类。
- 客户那一次到底是「指针移走」还是「回执根本没落地」导致认领失败，缺该机宿主的会话指针与回合历史，无法断定。本次修的是两条让等待**无解**的客户端路径：修复 1 让回执在它真正所在的位置被读到；修复 2 让用户永远能收回等待、重新拿到输入框。若实际是「回执没落地」，则由修复 2 兜底，面板不会再无限卡住。
- 会话标识已失效（客户端还没拿到「这一轮实际落在哪条对话」）这一种更窄的情况：正常路径上宿主在流的第一行就给 `session`（会话交接时是新会话的标识），客户端 `onSession` 会把 `run.sessionId` 与 `run.recovery.sessionId` 一起更新，所以点名读回执落在正确的对话上；只有流连第一行都没送到（或宿主重启后这条会话已不在本地）时，点名读会得到空对话，回执读不到，仍由「知道了」释放，而不是自动认领。要覆盖它需要宿主在历史里给出「这条旧会话的接续者」，属于宿主侧改动，本轮不做。
