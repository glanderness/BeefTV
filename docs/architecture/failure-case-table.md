# 生成失败怎么显示：用例表（第 7、8 项的前置）

状态：Sunny 2026-10-29 确认按建议执行。
依据：main `d3b3d773`。重构方案第十节第 7 项（前端错误改读错误码）、第 8 项（删 `task-outcome.ts` 的旧节点推断）。

## 一、为什么要先定这张表

第 7、8 项原本当作"行为不变的重构"来做。实际做了一版，Codex 对照旧代码实测，有 20 多种失败的提示会变，所以没合。

原因是失败的显示现在由三处各自决定，规则不在一处：

1. **后台任务结论**（`backend/internal/task/outcome.go`）：有任务号的失败，后台算出"处于哪个阶段、能不能直接重新生成、为什么"（`phase` / `regenerate` / `reason`）。前端按 `reason` 选文案（`web/src/lib/task-outcome.ts` 的 `taskOutcomeCopy`）。
2. **前端错误类别**（`web/src/lib/generation-error.ts`）：把错误文字或供应商错误码归成 35 类之一（`auth`、`throttled`、`input_too_large` 等），每类配一句原因和一句操作建议，再按具体文字细化（如"第 1 个参考视频超过 50MB，请压缩"）。
3. **前端旧节点推断**（`task-outcome.ts` 的 `readNodeTaskOutcome` / `readTaskOutcome`）：节点上没有后台结论时，看 `status`、`taskStatus`、`taskStage`、`generationErrorCode` 自己推一个结论出来。

第 8 项要删的是第 3 处。但删之前要先回答：没有任务号的失败，结论从哪来？这类失败现在还在不断产生，不只是旧数据。

## 二、失败分三种来源

| 来源 | 例子 | 有任务号吗 | 结论现在从哪来 |
| --- | --- | --- | --- |
| A. 后台任务失败 | 供应商拒绝、审核不过、额度不足、超时、结果取不回 | 有 | 后台 `ComputeOutcome`；打开画布时会自动刷新 |
| B. 提交前就失败 | 本地保存节点失败、参数校验没过、网络断了没发出去、浏览器直连渠道直接返回错误 | 没有 | 前端推断（第 3 处） |
| C. 结果回不到画布 | 后台生成成功，但下载、写回节点失败，或原节点已删 | 有 | 前端在写回失败时自己写一个结论（`canvas-generation-failure.ts`） |

A 类已经单源化：后台给结论，前端照读。第 8 项真正要处理的是 B 类和 C 类。

## 三、建议的规则

### 3.1 结论只有一个来源：写失败的地方当场写结论

不再在读的时候推断。每个写失败的地方（第四节列出全部 16 个文件），在写 `generationErrorCode` 的同时写 `taskOutcome`，按下表定：

| 节点上的情况 | 阶段 | 能否重新生成 | 原因 | 显示 |
| --- | --- | --- | --- | --- |
| `generationSubmissionState` 为 unknown，或 `taskStage` 为 `submission_unknown` | retrievable | 不可以 | `submission_unknown` | "上次生成结果已保留，系统正在自动取回" |
| 错误码 `result_target_unavailable` | failed | 不可以 | `result_target_unavailable` | "生成结果已保存在生成历史，当前目标节点已变更" |
| 错误码 `canvas_conflict`、`download_failed`、`result_apply_failed`、`delivery_failed`、`submission_uncertain`、`results_missing` | retrievable | 不可以 | `delivery_pending` | "上次生成结果已保留，系统正在自动取回" |
| 错误码 `moderation_*`、`invalid_params`、`context_too_long`、`input_inaccessible`、`input_too_large`、`content_policy_violation`、`sensitive_words_detected` | failed | 先确认 | `input_rejected` | "提示词、参考素材或参数未通过校验" + 确认框 |
| 错误码 `request_not_sent`，或任务已取消 | failed | 直接可以 | `not_charged` | "上次请求未扣费，可以直接重新生成" |
| 其余失败（鉴权、额度、限流、网络、超时、服务不可用、未知等） | failed | 直接可以 | `task_failed` | "上次生成未完成，可以直接重新生成" |

这张表就是今天 `readNodeTaskOutcome` 里的规则，只是改到写入时执行一次、存下来，读的时候不再推。所以对已经在跑的用户，显示不变。

**第 1 点（已确认，按建议）：** 浏览器直连渠道的鉴权、额度、限流失败，今天就允许直接重新生成、不弹确认框，上表保持这个行为。核对代码时发现初稿把这一点写反了，把"超时、网络"写成了"不可以重新生成"，也和今天不符，已改回。

### 3.2 错误类别和提示文案：只在第一次归类时算一次

`generation-error.ts` 的归类规则保持现状，不删、不调顺序（Codex 指出的 20 多处变化都来自调顺序和改优先级）。

现状：第一次归类时，`generationFailureMetadata` 已经把类别存成 `generationErrorCode`，把算好的中文原因和操作建议合成一句存成 `errorDetails`，原始错误文字存成 `generationErrorSummary`。问题出在读的时候：显示节点时又把 `errorDetails` 当成错误文字重新归类一遍。上一版让已存类别优先，但文案改从原始文字重算，于是出现 "Failed to fetch" 这类英文提示。

改法：

1. 显示节点时，节点上有 `generationErrorCode` 和 `errorDetails`，就直接用存下来的类别和 `errorDetails`，不再重新归类。
2. 没有类别的旧数据，照旧现场归类。
3. 三处没存类别的写入点（Codex 指出的浏览器直连 `channel-transport.ts`、分镜 `use-canvas-storyboard.ts`、深度捕捉等 `use-canvas-media-tools.ts`）改成经 `generationFailureMetadata` 写，类别和文案一起存，不再只存原始文字。

这样同一个失败第一次和后来看到的提示一样，也不改变任何现有归类结果。

**第 2 点（已确认，按建议）：** 前端约 135 处按文字归类的规则这一轮不删。它们仍然负责第一次归类，只是不会再被重复调用。要真正删掉，得让后台和 BeefAPI 返回带类别的错误。浏览器直连渠道的错误来自第三方供应商，前端只能看文字，这部分可能永远删不掉。我建议第 7 项的完成标准改成"已归类的失败不再重新归类"，而不是"文字判断降到只剩浏览器本地错误"。

### 3.3 旧节点

打开画布时，有任务号的旧节点已经会自动查后台、拿到结论（`canvasNodeNeedsGenerationRecovery` → 恢复流程）。没有任务号的旧节点，打开时按 3.1 的表补写一次结论并保存，之后就不用再推。

补写一段时间后（建议两个发版周期），删除 `readNodeTaskOutcome` 和 `readTaskOutcome` 里的推断分支，没有结论的节点统一显示"上次生成未完成，可以直接重新生成"（就是现在 `taskOutcomeCopy` 对空结论的兜底）。

**第 3 点（已确认，按建议）：** 删除推断的时间点。我建议两个发版周期，因为桌面客户端用户不一定马上升级。

## 四、要改的写入点

前端写 `generationErrorCode` 的文件（不含测试）：

- `lib/canvas/canvas-depth-capture.ts`
- `lib/canvas/canvas-generation-task-sync.ts`
- `lib/canvas/canvas-image-batch-retry.ts`
- `lib/canvas/canvas-project-domain.ts`
- `lib/canvas/canvas-project-generation.ts`
- `lib/generation-error.ts`（`generationFailureMetadata`，大部分失败从这里出）
- `pages/canvas/canvas-generation-failure.ts`
- `pages/canvas/canvas-image-generation-executor.ts`
- `pages/canvas/canvas-media-generation-executors.ts`
- `pages/canvas/canvas-text-generation-executor.ts`
- `pages/canvas/use-canvas-generation-executor.ts`
- `pages/canvas/use-canvas-generation-retry.ts`
- `pages/canvas/use-canvas-resource-handoff.ts`
- `pages/create/creation-conversations.ts`
- `pages/create/index.tsx`
- `services/creation-text-task-recovery.ts`

其中多数只是清空（成功时把错误码置空）。真正写失败的集中在 `generationFailureMetadata` 和 `canvasGenerationFailureMetadata`，3.1 主要改这两个函数；3.2 另外改显示节点时的读取，以及三处没存类别的写入点。

## 五、验收

1. 用例表测试：上面 3.1 表每一行写一个测试，输入一个失败，断言存下的 `taskOutcome` 和显示文案。
2. 回放测试：取 Codex 列出的 20 多种输入，断言改动前后第一次显示的原因和操作建议完全一致。
3. 再次展示测试：同一个失败保存、重新打开画布，显示和第一次一致（上一版就是这里坏的）。
4. 旧节点测试：没有 `taskOutcome` 的旧节点打开后被补写，且补写结果与今天推断的结果一致。

## 六、实施记录（2026-10-29 晚）：两次尝试都没合，顺序要反过来

1. **3.1 写入时定结论**：全量测试 2 项失败。失败写下之后，还有 4 个文件会往节点上追加"提交未确认"标记（`canvas-project-generation.ts`、`use-canvas-generation.ts`、`use-canvas-upscale-batch.ts`、`canvas-generation-target.ts`）。读时推断看得到这些后加的标记，写入时定死的结论看不到。
2. **3.2 本地失败多存一个错误类别**：测试全过，但 Codex 实测指出 8 类行为变化，包括：已有后台任务的节点的结论被覆盖，批量重试会把运行中的子节点也带上；错误卡片原本隐藏"重新生成"按钮，现在会显示；"视频结果下载失败"的提示从"继续取回原结果"变成"可以直接重新生成"；审核失败后改提示词会清掉任务绑定；被删目标节点的恢复路线从"单节点恢复"变成"去生成历史"。

**原因**：至少 8 处代码各自读节点上的 `generationErrorCode`、`errorDetails`、`taskOutcome`、`taskStage` 来做判断（`task-outcome.ts` 的 `readNodeTaskOutcome`，`canvas-depth-capture.ts` 的 `canvasNodeFailureExplanation`，`canvas-node-content.tsx` 的重试按钮，`generation-error.ts` 的 `isContentModerationError`，`canvas-generation-orchestration.ts` 的批量重试筛选，`use-canvas-generation-batches.ts` 的提交未确认判断，`canvas-project-generation.ts` 的自动恢复判断，`use-canvas-node-editor.ts` 的改提示词重置）。只要写入的字段变了，这些地方就各自得出不同的结论。

**新的顺序**：

1. 先把上面 8 处读取收成一个函数：输入节点，输出"阶段、能否重新生成、原因、提示文字、操作建议、要不要显示重新生成按钮、要不要自动恢复、恢复走哪条路"。8 处都只调这个函数。
2. 用测试把每一处今天的表现锁住：至少覆盖 Codex 两轮找出的全部输入，外加"已有后台任务的节点再失败一次"和"审核失败后改提示词"。
3. 这一步做完，节点上存什么字段就只影响这一个函数。之后再按 3.1、3.2 改写入端，只改这一个函数的输入，用第 2 步的测试证明输出没变。
4. 第 8 项（删旧推断）在第 3 步之后，按 3.3 的时间点做。

第 1、2 步本身不改任何用户可见行为，可以按普通重构做、按普通标准审。

