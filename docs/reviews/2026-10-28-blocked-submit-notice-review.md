# 生成被拦提示修复：独立检查与免费界面证据

**结论：独立检查未通过，建议修正 1 项 P2 和原报告的脱敏问题后，再进入正式 PR 收尾。**

修复确实让原先不可见的拦截原因出现在提示词面板；本次已补参考图超限的免费界面对照。但新写入的提示在原任务成功取回后仍然显示，结果图片与“已停止取回，可以继续取回”的红字同时出现。相关自动测试全部通过，仍未覆盖这个过程。

客户那一次“三张以上无反应”的原因仍未确定，不能把本次检查写成客户故障已经定位或恢复。没有发现本次差异新增数量限制、修改扣费判断或替换原任务身份。

## 1. 检查对象与独立性

| 项目 | 固定对象 |
| --- | --- |
| 输入任务 | [#91](todo:Mw2TcPWGzlrxiwsCVrC05) |
| 基线 | `6a155448096d2425aa07e81cc6016410091ad0be` |
| 交付 | `8fd8be25386b8f1dcbd42ccd9d9ce08880f15a55` |
| 输入分支 | `tds/conv-01a18035-8c36-7ac9-906d-0e1222cb19d4` |
| 作者报告 | 交付提交中的 `docs/investigations/2026-10-28-multi-reference-submit.md` |
| 本次允许的改动 | 本报告及合成数据截图 |

已读取输入任务完整约定，并通过项目 git 工具获取输入分支、核对固定提交对象。先读固定差异、原有调用方、渲染、任务绑定和测试，记录独立初判，再阅读作者报告及其截图；没有读取原长会话，也没有让意见回流原会话。记忆仅用于找历史约定，不作为当前代码的证明。

运行验证使用两个固定提交的源码副本、现有依赖、合成配置和本机拒绝上游请求的测试服务器。工作分支的产品文件保持原样；没有操作正式客户端，没有启动桌面应用，也没有接触客户数据、真实模型凭据或付费接口。

以下代码行号均以交付提交为准。测试与截图证明的范围分别说明，不将组件测试写成正式桌面验收。

## 2. 需要处理的问题

### P2：成功取回后仍显示过期的“继续取回”提示

新增写入位置：[图片执行器第 63 行](https://github.com/glanderness/BeefTV/blob/8fd8be25386b8f1dcbd42ccd9d9ce08880f15a55/web/src/pages/canvas/canvas-image-generation-executor.ts#L63)、[生成 hook 第 191 行](https://github.com/glanderness/BeefTV/blob/8fd8be25386b8f1dcbd42ccd9d9ce08880f15a55/web/src/pages/canvas/use-canvas-generation-executor.ts#L191)。

免费重放过程：

1. 合成图片节点带有原任务标识、`resourceReloadAvailable: true`、`generationErrorCode: "download_failed"`，原因是“已停止取回，可以继续取回”。
2. 点击生成。真实 `executeImageGeneration` 拒绝新提交，并把原因写入 `generationPreflightError`。原任务标识和恢复字段均保留。
3. 让同一原任务进入成功状态，应用合成图片结果。真实前端结果转换及 `canvasGenerationTaskNodes` 得到 `status: "success"`、`taskStatus: "succeeded"`，恢复标记已清除，原任务标识不变，但 `generationPreflightError` 仍有旧内容。
4. 真实 `CanvasNodePromptPanel` 不检查这条提示是否过期，继续渲染红字。

这不依赖再次生成或连续点击的竞态。待取回节点先试生成、再取回原结果，就能到达这个矛盾状态。新增的运行中、重复点击和查不到原任务等提示也存在相同的清除风险；本轮直接重放的是上述待取回场景，不把其余风险算作已经完成的逐项界面验证。

原因由代码与独立重放交叉确认：

- [新增 helper 第 100 行](https://github.com/glanderness/BeefTV/blob/8fd8be25386b8f1dcbd42ccd9d9ce08880f15a55/web/src/pages/canvas/canvas-generation-failure.ts#L100)只写提示。
- [生成 hook 第 258 行](https://github.com/glanderness/BeefTV/blob/8fd8be25386b8f1dcbd42ccd9d9ce08880f15a55/web/src/pages/canvas/use-canvas-generation-executor.ts#L258)的清除在这些早退之后；免费取回无需再次经过正常生成预检。
- [任务状态投影第 104 行](https://github.com/glanderness/BeefTV/blob/8fd8be25386b8f1dcbd42ccd9d9ce08880f15a55/web/src/pages/canvas/canvas-generation-failure.ts#L104)保留此字段，前端成功媒体 metadata 也未清除此字段。
- 后端正式绑定函数 [applyGenerationBindMetadata](https://github.com/glanderness/BeefTV/blob/8fd8be25386b8f1dcbd42ccd9d9ce08880f15a55/backend/internal/canvas/task_bind.go#L421)同样保留此字段。对该函数运行独立 Go overlay 断言，成功状态和恢复标记符合预期，但“成功后旧提示应消失”的断言失败，输出见第 5 节。

作者在报告第五节承认提示可能滞留，但用“既有字段也如此保留”解释本次不处理。**本次不接受这个解释**：本次新增了对运行和恢复状态的提示写入，下一次编辑提示词才清除，不能保证当前任务成功后文字仍然真实。它影响的是这次提示修复本身，不是要求重写全站提示。

建议修复标准：当原任务继续推进、成功取回或进入新的明确结论时，清掉或替换已经失效的本次提示；保留原任务身份、恢复行为与费用判断。补“提示出现 → 原任务成功 → 旧提示消失”的回归测试。若修复必须调整取回、任务判定或后端绑定，则交 Chief 协调既有 #88 重构，不在本次只读检查里补产品代码。

### 原报告需要去除不必要的客户身份与私聊摘录

交付提交中作者报告开头包含可识别的客户昵称及私聊摘录，第二节也保留了多条原话。这些内容对证明 CSS 隐藏提示、重放超限和检查任务身份都不是必要条件。

本次不复制这些内容，也不修改原报告。正式 PR 前应保留匿名症状、证据是否缺失、代码和测试结果，删除不必要的身份与私聊原文；本次截图全部使用合成内容。

## 3. 已确认保持的行为

| 检查项 | 证据与结论 |
| --- | --- |
| 拦截原因可见 | `.ant-message` 的隐藏规则属实；交付新增字段由真实面板的 `role="alert"` 显示。超限与待取回分支均有独立界面证据。 |
| 原任务身份与恢复信息 | helper 只追加目标节点的提示。独立重放比较整个节点对象，除该字段外与输入完全一致；既有保存屏障测试也比较原任务及恢复 metadata。 |
| 被拦后没有新生成 | 两版本重放的新提交计数均为 0；界面服务器的 `/api` 和 `/upstream` 总请求数均为 0。 |
| 参考图数量规则 | 固定差异没有修改能力表、`canvasImageReferenceLimitError`、输入列表或上限数值。测试的 1 张上限只属于隔离合成模型，不是对真实模型增加限制。 |
| 免费取回、重试与扣费判断 | 差异未改这些判断；相关保存屏障、错误码、重试及原结果保护测试通过。没有进行真实账务或供应商验收，不能据此宣称所有费用场景都经过端到端验证。 |
| 提示清除 | 编辑提示词会清除真实已显示的提示，已在浏览器验证；新一轮正常预检也有清除代码。原任务成功后的清除不通过，见 P2。 |

数量依据沿用任务中已批准的“按适用模型官方规则，不另加总数限制”。本次没有重新认证全部供应商的最新数量规范；代码差异也不需要改变这些规范。

“客户说三张失败”不足以推导出产品固定上限。作者报告关于“没有任何图片模型上限为 2”的概括，只能理解为其枚举的内置默认值，不能排除用户保存的自定义能力配置，更不能用来排除客户现场的数量相关因素。

## 4. 免费界面证据

本次在 Ego 的独立 TaskSpace 内使用真实提示词面板、真实图片执行器、真实任务投影与当前样式，配合独立测试外壳。样式经项目现有 Tailwind/PostCSS 处理；没有修改全局提示的隐藏规则。

| 场景 | 观察 | 截图 |
| --- | --- | --- |
| 基线：测试上限 1，输入 3 张 | 执行器返回超限原因，面板没有 `alert`，无新提交 | [基线](assets/2026-10-28-blocked-submit-notice-review/reference-limit-base.png) |
| 交付：相同合成配置与输入 | 深色面板显示完整超限原因，无新提交 | [交付深色](assets/2026-10-28-blocked-submit-notice-review/reference-limit-dark.png) |
| 交付：浅色、390 像素宽 | 已出现的原因可以换行，文本区域位于屏幕内，页面无横向溢出 | [浅色窄屏](assets/2026-10-28-blocked-submit-notice-review/reference-limit-light-narrow.png) |
| 交付：已有结果待取回 | 点击生成后显示对应原因，原任务和恢复字段保留 | [待取回](assets/2026-10-28-blocked-submit-notice-review/pending-blocked.png) |
| 交付：注入同一原任务的成功结果 | 图片和成功状态已经出现，旧红字依然存在 | [成功后残留提示](assets/2026-10-28-blocked-submit-notice-review/success-with-stale-notice.png) |

证据的实际范围：

- 超限截图直接把三张合成参考图交给真实图片执行器，证明该分支和真实面板能连起来显示；没有重建完整画布连线、素材上传和型号切换流程。
- 成功截图用按钮注入合成成功回执，并调用真实前端结果转换与任务投影。它不是一次完整 HTTP 免费取回。后端真实绑定函数是否清除此字段另由 Go overlay 验证。
- 窄屏截图是在桌面尺寸点击生成后缩窄得到；独立测试外壳在 390 像素宽时有部分工具按钮被裁切，直接点击生成失败。因此只确认提示文字的窄屏显示，不宣称整套窄屏提交交互通过，也不把未改布局归为本次引入的问题。
- 两个界面服务器结束前均读取到 `apiRequests: 0`，合成提交计数为 0。没有上游调用和付费请求。

作者的两张固定截图也已逐一查看：它们支持“待取回原因在修复后可见”。但截图顶部的保存状态不同，单凭截图不能证明完整节点身份、保存状态和网络请求均保持不变；这些结论需要代码与测试支持。作者的待取回截图也不能替代参考图超限场景的界面证据，本次补的是组件层的对照。

## 5. 自动验证与失败重放

环境为本机 Bun `1.4.2`；复用现有依赖，没有安装或升级依赖。源码来自固定提交的独立副本，不以本工作分支的基线代码冒充交付版本。初次副本缺少仓库里的合同 JSON 和测试 fixture，出现模块加载错误；补入同一固定提交的依赖文件后重跑通过，该错误不记为产品测试失败。

| 对象 | 命令/范围 | 实际结果 |
| --- | --- | --- |
| 交付：核心 5 个文件 | `bun test test/canvas-blocked-submit-notice.test.ts test/canvas-image-save-barrier.test.ts test/canvas-generation-failure.test.ts test/canvas-generation-preflight.test.ts test/canvas-generation-live-graph.test.ts` | 43 通过，0 失败，287 个断言 |
| 交付：相邻 7 个文件 | `bun test test/canvas-model-policy.test.ts test/canvas-generation-error-codes.test.ts test/canvas-binding-conflict-actions.test.ts test/reference-preparation-retry.test.tsx test/midjourney-generation.test.ts test/vod-image-errors.test.ts test/vod-moderation.test.ts` | 136 通过，0 失败，3892 个断言 |
| 基线：已有核心 4 个文件 | 与第一组相同，去掉基线不存在的 `canvas-blocked-submit-notice.test.ts` | 40 通过，0 失败，273 个断言 |
| 独立前端双版本重放 | 同一份临时 fixture 分别调用两版本真实图片执行器、媒体结果转换和任务投影 | 基线超限/待取回提示均为空；交付两者均写入；交付成功后旧提示仍在，原任务身份不变 |
| 后端成功绑定 | `go test -overlay <overlay.json> ./internal/canvas -run TestReviewBlockedNoticeAfterSuccessfulBind -count=1` | 清除提示的预期断言失败；成功状态及恢复标记的前置断言通过 |

交付相关测试合计 **179 通过、0 失败、4179 个断言**。此外有 **1 个独立新增的失败断言**，用于证明 P2，不能把该失败掩入“全部通过”。本次没有重跑全仓构建、类型检查、全量测试或桌面测试；作者报告中的全量结果属于作者提供的证据，不冒充本轮执行结果。

后端复现断言如下。把测试内容用 Go overlay 映射到固定交付副本的 `backend/internal/canvas/review_bind_test.go` 即可运行，无需修改产品文件：

```go
package canvas

import "testing"

func TestReviewBlockedNoticeAfterSuccessfulBind(t *testing.T) {
    metadata := map[string]any{
        "status": "error", "taskId": "original-task",
        "resourceReloadAvailable": true,
        "generationPreflightError": "已停止取回，可以继续取回",
    }
    applyGenerationBindMetadata(metadata, TaskOutputBind{
        TaskID: "original-task", TaskType: "canvas_image", MediaType: "image",
        Content: "/api/resources/synthetic-result/file",
        StorageKey: "resource:synthetic-result", AssetID: "synthetic-asset",
    })
    if metadata["status"] != "success" || metadata["resourceReloadAvailable"] != nil {
        t.Fatalf("未得到成功的绑定：%v", metadata)
    }
    if metadata["generationPreflightError"] != nil {
        t.Fatalf("成功绑定仍保留过期提示：%v", metadata["generationPreflightError"])
    }
}
```

输出的关键行：

```text
--- FAIL: TestReviewBlockedNoticeAfterSuccessfulBind
成功绑定仍保留过期提示：已停止取回，可以继续取回
FAIL infinite-canvas/backend/internal/canvas
```

### 既有测试修改是否削弱保护

`canvas-image-save-barrier.test.ts` 将“节点零修改”改为“仅允许追加提示”是修复所必需的，仍检查原任务及恢复 metadata 不变、连接与待提交登记不变。其余保存失败、取消、账号离开、禁止再次付费生成的断言没有被删除。

但该条测试将**所有节点**的 `generationPreflightError` 排除后只比较 metadata，没有完整比较节点对象，也没有阻止提示误写到其他节点；不要把它描述成所有节点结构都经过严格相等验证。本轮独立重放额外比较了整个节点对象。作者新增的“只写目标节点”测试直接测 helper，未覆盖 hook 的重复点击、运行中、原任务查找和成功后清除。两个整体 mock fixture 只是补齐新 export，没有补上这些生命周期检查。这解释了为什么现有测试全部通过，P2 仍然存在。

## 6. 对原交付结论的取舍与下一步

- 接受：隐藏 Toast 会导致执行器早退没有可见原因；把原因写进真实面板有效；不应根据客户的张数描述增加限制；客户现场根因尚未确定。
- 部分接受：只改了原因展示，没有改变生成和费用判断；但“展示改完即可收尾”缺少提示失效后的处理，不能据此判独立检查通过。
- 不接受：因为下一次生成或改提示词会清除，就足以容许原任务成功后仍显示旧提示。本次已有真实函数和合成界面反例。
- 参考图超限界面原先未验证是证据缺口，不单独作为阻止 PR 的理由；本轮已补组件层对照，完整画布和正式桌面仍未验证。
- 需先处理 P2 和原报告脱敏，再复查对应小范围差异及“原任务成功后提示消失”的免费回归。无需扩展为全站提示重写，也无需付费验证。

本任务到此只交独立检查结果，不改产品、不合并、不发布。后续交 Chief 安排短任务，避免把修订自动追加到原重会话；涉及取回和任务判定的改动须与既有重构协调。原任务身份、免费取回、重试与扣费判断仍按原约定保持。

临时验证服务器、Ego TaskSpace 和源码副本在本轮结束前清理；保留本报告与五张无客户信息的合成截图。
