# 生成失败怎么显示：用例表（第 7、8 项的前置）

状态：待 Sunny 确认。只描述规则，不含代码改动。
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

| 失败类别（`generationErrorCode`） | 阶段 | 能否重新生成 | 原因 | 显示 |
| --- | --- | --- | --- | --- |
| `request_not_sent`、本地保存节点失败、`cancelled`（未提交时取消） | failed | 直接可以 | `not_charged` | "上次请求未扣费，可以直接重新生成" |
| `canvas_conflict`、`download_failed`、`result_apply_failed`、`delivery_failed` | retrievable | 不可以 | `delivery_pending` | "上次生成结果已保留，系统正在自动取回" |
| `result_target_unavailable` | failed | 不可以 | `result_target_unavailable` | "生成结果已保存在生成历史，当前目标节点已变更" |
| `submission_uncertain`、`timeout`、`network`（已发出、不知道对方收没收到） | retrievable | 不可以 | `submission_unknown` | "正在核实并取回上次生成结果" |
| `moderation_*`、`invalid_params`、`context_too_long`、`input_inaccessible`、`input_too_large` | failed | 先确认 | `input_rejected` | "提示词、参考素材或参数未通过校验" + 确认框 |
| 其余（`auth`、`permission`、`quota_*`、`throttled`、`concurrency`、`provider_unavailable`、`model_missing`、`malformed_response`、`unknown` 等） | failed | 见下一行 | `task_failed` | 见下一行 |
| ↳ 能证明请求没发出（浏览器直连收到明确拒绝、本地校验拦下） | failed | 直接可以 | `not_charged` | "上次请求未扣费，可以直接重新生成" |
| ↳ 不能证明 | failed | 先确认 | `task_failed` | "这个渠道无法确认上次是否已扣费，重新生成可能会再扣一次" + 确认框 |

这张表就是今天 `readNodeTaskOutcome` 里的规则，只是改到写入时执行一次、存下来，读的时候不再推。所以对已经在跑的用户，显示不变。

**要你确认的第 1 点：** 鉴权失败、额度不足、请求过于频繁这几类，浏览器直连渠道收到的是供应商明确的拒绝，基本可以认定没扣钱。我建议归到"直接可以重新生成"，不弹确认框。今天的推断对它们统一弹确认框。这会改变用户看到的东西：少弹一次确认。

### 3.2 错误类别和提示文案：只在第一次归类时算一次

`generation-error.ts` 的归类规则保持现状，不删、不调顺序（Codex 指出的 20 多处变化都来自调顺序和改优先级）。

现状：第一次归类时，`generationFailureMetadata` 已经把类别存成 `generationErrorCode`，把算好的中文原因和操作建议合成一句存成 `errorDetails`，原始错误文字存成 `generationErrorSummary`。问题出在读的时候：显示节点时又把 `errorDetails` 当成错误文字重新归类一遍。上一版让已存类别优先，但文案改从原始文字重算，于是出现 "Failed to fetch" 这类英文提示。

改法：

1. 显示节点时，节点上有 `generationErrorCode` 和 `errorDetails`，就直接用存下来的类别和 `errorDetails`，不再重新归类。
2. 没有类别的旧数据，照旧现场归类。
3. 三处没存类别的写入点（Codex 指出的浏览器直连 `channel-transport.ts`、分镜 `use-canvas-storyboard.ts`、深度捕捉等 `use-canvas-media-tools.ts`）改成经 `generationFailureMetadata` 写，类别和文案一起存，不再只存原始文字。

这样同一个失败第一次和后来看到的提示一样，也不改变任何现有归类结果。

**要你确认的第 2 点：** 前端约 135 处按文字归类的规则这一轮不删。它们仍然负责第一次归类，只是不会再被重复调用。要真正删掉，得让后台和 BeefAPI 返回带类别的错误。浏览器直连渠道的错误来自第三方供应商，前端只能看文字，这部分可能永远删不掉。我建议第 7 项的完成标准改成"已归类的失败不再重新归类"，而不是"文字判断降到只剩浏览器本地错误"。

### 3.3 旧节点

打开画布时，有任务号的旧节点已经会自动查后台、拿到结论（`canvasNodeNeedsGenerationRecovery` → 恢复流程）。没有任务号的旧节点，打开时按 3.1 的表补写一次结论并保存，之后就不用再推。

补写一段时间后（建议两个发版周期），删除 `readNodeTaskOutcome` 和 `readTaskOutcome` 里的推断分支，没有结论的节点统一显示"上次生成未完成，可以直接重新生成"（就是现在 `taskOutcomeCopy` 对空结论的兜底）。

**要你确认的第 3 点：** 删除推断的时间点。我建议两个发版周期，因为桌面客户端用户不一定马上升级。

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
