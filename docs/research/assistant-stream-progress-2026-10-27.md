# 画布助手：回复像「最后一大串一下子出来」—— 沿链路找停顿点的实测结论

报障来源：2026-10-26 会议待办 §4.3「流式：沿已有链路找停顿点」。用户口径是「助手回复不是边生成边出，而是最后一大串一下子出来」，只看 Mac 客户端，不涉及 Web/Nginx 部署路径。

涉及模块：`agent-host/durable-stream-text.mjs`（Durable 正文投影）、`backend/internal/handler/agent_proxy.go`（NDJSON 转发）、`web/src/services/api/agent-assistant.ts`（流解析）、`web/src/pages/canvas/use-canvas-assistant.ts`（回合状态）、`web/src/pages/canvas/canvas-assistant-sidebar.tsx` + `canvas-assistant-turn.tsx`（回复组件）。

## 一、结论

1. **客户端四层都没有把正文攒到最后。** 宿主、Go 转发、前端 hook、回复组件，以及**原生桌面 v2.0.3 的 WKWebView** 全部逐段出字：本地慢速替身分 8 段、每段间隔 1.5s 时，真实客户端面板依次看到 2 → 5 → 7 → 8 段。因此「只修攒住内容的那一处」在客户端里没有对应的那一处。
2. **用户看到的现象对应 §4.3 的第二种情况：推理阶段没有正文。** 真实会话里模型（`claude-opus-5-5`，`thinkingLevel: low`）先长时间推理，期间面板只有「助手正在处理…」；客户端按既有边界不展示推理内容（`durable-stream-text.mjs`「Only visible text is projected. Reasoning… stay private」、`canvas-assistant-copy.ts` 剥离 `<thinking>`/`<think>` 标记）。推理结束后正文开始吐字，视觉上就像一次性涌出。§4.3 明确要求区分这两种情况，且不允许用逐字动画掩盖真实等待，因此这里不改产品行为。
3. 本次改动只补上**界面级回归用例**：终态之前面板必须已经显示多个分开发出的片段（并附负向对照，证明用例真的会因为「有一层攒内容」而失败）。宿主侧的快照替换/不重复字/不丢字用例 `agent-host/durable-stream-events.test.mjs` 已覆盖，不重复新增。

## 二、四层实测（全部指向本地慢速替身，零付费模型调用）

慢速替身：一个约 40 行的 `node:http` 服务，按 `SLOW_DELAY_MS` 间隔在 OpenAI Chat Completions SSE 里逐段写正文。

| 层 | 探针 | 首个响应 / 分片到达 |
| --- | --- | --- |
| 宿主 `agent-host/server.mjs` | `/chat` 直连（sim-go + 慢速模型 400ms×8） | HTTP 200 @+104ms；`text_snapshot` +846/+1253/+1647/+2049/+2459/+2855/+3253/+3562ms；`turn_end` +3564ms |
| Go 转发 `agent_proxy.go` | `go run ./cmd/server` + 真宿主 + 慢速模型 | `POST /api/assistant/chat` 200 @+99ms；`text_snapshot` +914/+1304/+1705/+2106/+2513/+2921/+3329/+3638ms；`turn_end` +3648ms |
| Anthropic Messages + thinking | `BEEFTV_AGENT_API=anthropic-messages` + 慢速模型 | 200 @+320ms；`text_snapshot` +1449/+1860/+2270/+2658/+3090/+3378ms；`turn_end` +3384ms |
| 前端（真实 `CanvasAssistantSidebar` + 真实 `useCanvasAssistant`） | `web/test/assistant-stream-progress.browser.test.ts` | 终态前已显示第 1~3 段、尚未显示第 4 段；1 pass |

关键代码位置（现状即逐段下发，无缓冲）：

- `agent-host/server.mjs`：`sendLine(res, …) = res.write(JSON.stringify(payload) + '\n')`，Durable 事件经 `createDurableTextProjection()` 每来一个 `text_delta` 就产出一次 `text_snapshot`。
- `backend/internal/handler/agent_proxy.go`：`reader := bufio.NewReaderSize(resp.Body, 32<<10)`，逐行 `c.Writer.Write(line)` 后立即 `c.Writer.Flush()`；`assistantChatClient` 只设 `ResponseHeaderTimeout`，没有整体超时。v2.0.3 tag 上的这段代码与 HEAD 相同。
- `web/src/services/desktop-runtime.ts`：桌面版把 `/api/*` 指向 `http://127.0.0.1:<port>/api` 的真 HTTP 监听（并给 `fetch` 补 `X-Desktop-Token`），不走 Wails 的 in-process AssetServer，因此不经过 Wails 的响应缓冲。
- `web/src/pages/canvas/use-canvas-assistant.ts`：`onText` 用整段快照替换 `run.streamed`，`onLifecycle` 只写 `lifecycleNotice`，不清正文。

## 三、原生桌面实测（已安装 v2.0.3，cua-driver）

用隔离数据目录 + 环境变量覆盖，把已安装的正式 App 指向本地慢速替身（不碰用户数据目录）：

```bash
CANVAS_DESKTOP_DATA_DIR=/tmp/…/desktop-run3 \
BEEFTV_AGENT_BASE_URL=http://127.0.0.1:55165/v1 BEEFTV_AGENT_API_KEY=fake-key \
BEEFTV_AGENT_MODEL=slow-model BEEFTV_AGENT_PROTOCOL=openai-completions \
/Applications/BeefTV.app/Contents/MacOS/BeefTV
```

操作与读数（窗口先用 `set_window_frame` 移到虚拟屏，只操作自己启动的实例）：

- 慢速替身侧：`+1501/+3001/+4506/+6015/+7516/+9024/+10526/+12027ms 写第1…8段`，`完成 +12029ms`。
- 面板侧（无障碍树文本，两次独立回合）：`第1段内容。第2段内容。` → `…第5段内容。` → `…第7段内容。` → `…第8段内容。`；第二回合同样在终态前只看到前 2 段、随后 6 段。
- 截图（本地，未入库）：`/tmp/beeftv-pr-shots/4.3/desktop-stream-partial-1.png`（2 段）、`desktop-stream-partial-2.png`（6 段）。

## 四、真实会话观察（付费模型 1 次，非计划内）

**这一节同时是一条操作事故记录**：测试时误把消息发进了用户当时正在运行的正式实例（画布 `M5MjFRq6hYZnLRH4PCBr6`），产生 1 次真实模型调用（`agent-requests.jsonl` 记录 `model=claude-opus-5-5`，`at=2026-10-27T08:34:31.658Z`）。该实例的窗口位置已复原，测试消息与回复仍留在那个画布的助手面板里。

它给出的观察正好是「推理阶段没有正文」的现场：发送后第一次取样只有「助手正在处理…」、没有任何正文；下一次取样正文已经完整出现。该回合的 Durable 记录里 assistant 消息为 `[thinking, text]`，没有工具调用，即整个可见等待都发生在推理阶段。

## 五、负向对照（用例有没有牙齿）

把同一段正文改成「攒到 `turn_end` 之前一次性发出」（模拟有一层在攒内容），用例在「终态前不应包含第 4 段」这一断言上失败：

```
Expected to not contain: "第四段内容。"
Received: "第一段内容。第二段内容。第三段内容。第四段内容。"
```

## 六、未决与后续

1. **用户实际渠道是否逐段回正文尚未证实。** 用户机器上 `agent-requests.jsonl` 出现最多的是本机中转 `http://127.0.0.1:18794/v1/messages`；该中转当时没有监听，且客户端已排除，所以只能在渠道侧确认（对同一条上游做一次直连流式取样即可）。
2. **若希望等待期更可读**，可选做法是把推理阶段展示到面板（仓库已有 `web/src/components/ai/message-reasoning.tsx`，目前只用于创作页）。这会改变「推理不进 UI」的既有安全边界（推理文本可能含系统提示与画布快照），需要产品侧确认后再动。
