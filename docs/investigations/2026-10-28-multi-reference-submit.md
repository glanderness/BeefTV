# 三张以上参考图「点生成无反应」：排查与修复（2026-10-28）

来源：飞书需求表 `reczz28SeZHL4IyW`（表 `tblvTTmtzdPF6qxx`，Base `OcHnbZCXjaMwwrsx4laciEvRnHo`），
需求原文「多张参考图（3 张及以上）点生成无反应，2 张正常」，采集自企微客服私聊（客户「灰灰哥（白嫖勿扰） @微信」）。
客户在客服索取诊断包后回复「弄好了」，**没有截图、没有诊断包、没有说明原因**；采集者写在「进度说明」里的
「本条是图片节点在多参考图下的提交失败」「确认是否有『一次最多添加 8 份参考素材』一类限制被静默吞掉」是猜测，不是结论。

## 一、结论（先行）

**已证明的缺陷（本次修复）**：画布图片节点在提交前被拦下时，原因只写进右上角 Toast，而全站 CSS 把右上角 Toast 整个隐藏了。
用户看到的就是「点了生成，什么都不发生」。这条与参考图张数只在一点上相关：**参考图超过当前模型上限**时走的正是这条被隐藏的提示。
修复把这些拦截原因改为写进节点、由提示词面板显示（详见第四、五节，含浏览器里的点击前后对照）。

**仍未证明的（客户那一次）**：客户所说的「3 张及以上点生成无反应」具体命中的是哪一条拦截，无法确定——
没有截图、没有诊断包、客户自行恢复。仓库里也不存在「2 张通过、3 张被拒」的数量边界（见第三节）。
**本次修复不能声明为客户那次问题的根因修复**；它修的是同一症状背后一条已被证明的缺陷，并让以后同类反馈能被看见和定位。

**本次改动只改原因展示**：不新增任何数量限制，不改后端，不改生成、免费取回、重试与扣费的判断（见第六节末）。

## 二、反馈原文与同族线索的区分

| 需求行 | 原文 | 与本次的关系 |
| --- | --- | --- |
| `reczz28SeZHL4IyW` | 多张参考图（3 张及以上）点生成无反应，2 张正常 | 本次处理对象 |
| `reczz28RZUV31Fnf`（#106） | 画布提示词引用失效，提交前被静默拦截 | 已由 PR #246 修为面板内可见提示，本次沿用同一口径 |
| `reczz28Rt7XgMiZJ`（#120） | 视频节点点发送无反应（MiniMax H3），待诊断包 | 另一条线，未在本次处理 |

采集记录里「3 张及以上」是**客户的自述分界**，不是产品规则；客户自行恢复说明该状态是可退出的（例如刷新、删掉多余连线、
或换模型后重新提交）。

## 三、排除「数量边界」

按「不因 3 张失败就凭空新增数量限制」的要求，先穷举了所有与参考图数量相关的判定：

| 位置 | 数值 | 与 2/3 分界的关系 |
| --- | --- | --- |
| `web/src/lib/model-capabilities.ts` | 图片默认 `maxImages: 16`；`grok-image` 1；`volcengine-jimeng-image` 14；`agnes-image` 9；`grok-imagine-image` 0；Seedream 族 10 / 14 | 无 2 |
| `backend/internal/providerpreset/image_contracts.json` | `hy-image-v3` 3；`midjourney-v8.2` 1 | 无 2 |
| `backend/internal/modelcatalog/capability.go:924` | 图片参考图上限按能力表拒绝 | 无 2 |
| `backend/internal/generation/image_seedream.go:48` | Seedream 10 / 14 | 无 2 |
| `backend/internal/generation/fullvideo_upload.go:78` | 视频参考素材合计 | 视频链路 |
| `backend/internal/generation/beefapi_h3.go:150` | H3 参考图 9、合计 12 | 视频链路 |

结论：**没有任何图片模型的能力表是 2**，也没有任何地方按「≥3」分支。因此「2 张正常、3 张无反应」不能由产品限制解释；
更可能解释这个观察的是「第 3 张让某个既有判定第一次成立，而它的提示是看不见的」——第四节列出的拦截点里，
参考图上限那条正好是按张数触发的，但客户是否命中它无法确认（见第七节）。

## 四、可复现的缺陷：被拦下的提交只写进被隐藏的 Toast

`web/src/styles/globals.css:21449`：

```css
/* 全局反馈采用画布内状态与节点状态，不再渲染风格不一致的右上角 Toast。 */
.ant-message,
.ant-notification {
    display: none !important;
}
```

也就是说 `message.error / warning / info / success` 在正式版里**一律不可见**。设计意图（注释原文）是反馈必须落在
画布内状态或节点状态上；但画布提交路径上还有一批「拦下提交后只调 `message.*` 就 return」的地方，它们既不改节点状态，
也不置灰按钮，用户点下去没有任何可观察结果：

| 拦截点 | 触发条件 | 修复前用户可见反馈 |
| --- | --- | --- |
| `canvas-image-generation-executor.ts:71` 参考图上限 | 已连接参考图 > 当前模型 `maxImages` | 无（只有隐藏 Toast） |
| `canvas-image-generation-executor.ts:63` 待取回结果 | 节点/子节点有待取回结果（`resourceReloadAvailable`、`results_missing`、提交状态未知等） | 无 |
| `use-canvas-generation-executor.ts:191` 同类兜底 | 同上（非图片执行器路径） | 无 |
| `use-canvas-generation-executor.ts:198` 任务仍在进行 | 节点已有 queued/running 任务 | 无 |
| `use-canvas-generation-executor.ts:205` 合并成片节点 | 视频合并节点直接点生成 | 无 |
| `use-canvas-generation-executor.ts:348` 重试被拦 | 上次失败未改输入就重试（审核、提交未知等） | 无 |
| `use-canvas-generation-executor.ts:577` 重复点击 | 同一节点的提交锁未释放 | 无 |
| `use-canvas-generation-executor.ts:175` 查不到上次任务 | 提交身份存在但查不到任务 | 无 |

其中**只有「参考图上限」这一条与参考图张数直接相关**：它由
`web/src/lib/canvas/canvas-project-generation.ts:93` 的 `canvasImageReferenceLimitError` 计算，
文案是「当前图片模型最多支持 N 张参考图，当前已连接 M 张。请移除多余连线后重试」。
同一个判定在 `assertCanvasImageReferenceLimit` 里是**抛错**（走 `reportError`，会写进节点的可见提示），
在图片执行器里却是**只报 Toast**——两处行为不一致，说明执行器这一处是右上角 Toast 被全局隐藏后遗留的漏改。

同一文件里 `reportError` 早就写了正确的做法（`use-canvas-generation-executor.ts:140` 起）：

```ts
if (["validation", "references", "skills", "parameters"].includes(stage)) {
    setNodes((current) => current.map((node) => node.id === nodeId
        ? { ...node, metadata: { ...node.metadata, generationPreflightError: errText } }
        : node));
}
```

面板会把它渲染成「未开始生成：…」（`web/src/components/canvas/canvas-node-prompt-panel.tsx:535`）。
本次修复就是把上面表格里的漏改项补成同一口径。

## 五、修复

新增共享助手 `web/src/pages/canvas/canvas-generation-failure.ts:100`：

```ts
export function blockCanvasGenerationSubmit(nodes: CanvasNodeData[], nodeId: string, content: string): CanvasNodeData[] {
    return nodes.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, generationPreflightError: content } } : node));
}
```

调用点（全部保持原有 `message.*` 调用不变，只是**同时**写节点）：

- `web/src/pages/canvas/canvas-image-generation-executor.ts:63`（待取回结果）、`:71`（参考图上限）
- `web/src/pages/canvas/use-canvas-generation-executor.ts:117` 定义 `blockSubmit`，用于 `:175`、`:191`、`:198`、`:205`、`:348`、`:577`

为什么写 `generationPreflightError`：

- 该字段已有渲染（提示词面板「未开始生成：…」），是 PR #246 建立的口径，不新增 UI；
- 新一次尝试开始时会被清空（`use-canvas-generation-executor.ts:258`），改提示词也会清空（`canvas-node-prompt-panel.tsx:215`），
  所以提示不会永久粘住；
- 只写目标节点，不碰任务身份、恢复标记和连线。

**没有做的事**：不新增数量限制；不改后端；不改 `canvasImageReferenceLimitError` 的判定本身；不动提交流程与扣费；
不动 `web/src/pages/canvas/*` 之外的文件。

已知边角：提示会保留到下一次尝试或修改提示词为止。若提示出现后节点又由后台任务正常完成（例如「任务仍在进行」那条在竞态下被写下），
这行提示会滞留到下一次交互；这与既有 `generationPreflightError`（PR #246）的行为一致，本次没有改它的清理时机。

## 六、验证

新增用例 `web/test/canvas-blocked-submit-notice.test.ts`（3 条）：

1. 超过模型参考图上限（`maxImages = 1`、连了 3 张）时：不提交（`submissions === 0`），
   隐藏 Toast 文案与节点上的 `generationPreflightError` 一致；
2. 已有待取回结果时：不提交，节点写入「生成结果已保留，请点击「继续取回」」；
3. 拦截提示只写目标节点，不污染其他节点。

用例有牙齿：把 `canvas-image-generation-executor.ts` 换回 HEAD 版本后重跑，第 1、2 条失败（`Received: undefined`），
即修复前节点上确实什么都没有、用户点下去没有任何可见反应。

既有用例 `web/test/canvas-image-save-barrier.test.ts` 里「取回前的提交必须不改节点」这条断言与本次行为冲突，
按它的真实意图改写为：**连接与待提交登记一次都不能动，节点只允许追加这一条可见提示，取回所需的任务身份与恢复标记必须原样保留**
（用例名同步改为 `main generation and batch generation stop before a paid submission and only add the visible notice`）。

另外两个夹具（`web/test/fixtures/generation-preflight.fixture.ts`、`web/test/fixtures/generation-live-graph.fixture.ts`）
整体 mock 了 `canvas-generation-failure` 模块，需要补上 `blockCanvasGenerationSubmit` 的等价实现，否则 hook 路径拿到 `undefined`。
漏补时全量套件正好有 2 条失败（`real generation hook handles preparation, cancellation and retry without paid calls`、
`delayed second regeneration uses live graph while retaining confirmed billing inputs`），补上后恢复。

执行结果：

- `cd web && bun run typecheck`（`tsc --noEmit`）通过；
- `bun test` 本次改动相关 10 个文件：**173 pass / 0 fail**（`canvas-image-save-barrier`、`canvas-generation-failure`、
  `canvas-model-policy`、`canvas-generation-error-codes`、`canvas-binding-conflict-actions`、`reference-preparation-retry`、
  `midjourney-generation`、`vod-image-errors`、`vod-moderation`、`canvas-blocked-submit-notice`）；
- `bun run scripts/run-test-suite.mjs` 全量：**0 失败**（共享批次 3390 pass / 1 skip / 0 fail，覆盖 475 个文件；
  随后隔离运行的浏览器用例逐个通过，整份日志没有 `(fail)`）。

### 隔离环境里的观察（假上游，本机）

- 创作页图片模式 + 3 张参考图：上传成功（面板显示「图片 (3/16)」），点发送**正常提交**并打到假上游的编辑接口，
  失败原因是我方假上游没有实现该接口（返回的错误体被映射成权限类错误）——**创作页在 3 张参考图下不静默**。
  这条也解释了为什么本次没有改创作页。
- 创作页提交按钮的 `busy` 早退（`web/src/pages/create/index.tsx:661`）在 UI 上不可达：按钮 `disabled={interactionBusy || !canSubmit}`，
  而 `interactionBusy` 正是页面自己的 `busy`（`creation-workspace.tsx:404`）。参考图超限在创作页走的是面板内可见提示
  （`setReferenceNotice`），视频提交前核对走输入框内可见提示（`setComposerNotice`）——两条都是 PR #258 已修的口径。
- 画布图片节点 + 仅用 `@[node:…]` 提及（未连线）的参考图：面板出现「生成前请修正 2 处引用 / 未连接到当前生成节点」，
  点生成不提交——**提及路径本来就是可见的**，不是静默。

### 浏览器里的「点击 → 看见原因」验证（本机隔离环境，免费）

在隔离环境（后端 `127.0.0.1:18099`、前端 `127.0.0.1:5199`、假上游 `127.0.0.1:18111`，无任何真实付费调用）里，
把画布图片节点置入「有待取回结果」状态后点击面板的「生成」，对比修复前后：

| | 点击前 | 点击「生成」后 |
| --- | --- | --- |
| 修复前（`git show HEAD` 版本，dev server 返回的模块里确认 `blockCanvasGenerationSubmit` 不存在） | 无提示 | **无任何变化**：没有提示、没有 loading、没有跳转，节点状态与地址栏都不动 |
| 修复后 | 无提示 | 面板出现红色「未开始生成：已停止取回，可以继续取回」，地址栏仍停在画布（没有提交、没有跳设置页） |

截图（同一次会话、同一节点状态、同一次点击）：

- 修复前：`assets/2026-10-28-multi-reference-submit/canvas-blocked-submit-before-fix.png`
- 修复后：`assets/2026-10-28-multi-reference-submit/canvas-blocked-submit-after-fix.png`

做法（可复跑）：用 owner 凭据注入 + `POST /api/ops/canvas.document.commit` 把节点 metadata 写成
`{ status: "error", taskStatus: "failed", resourceReloadAvailable: true, generationErrorCode: "download_failed", errorDetails: "已停止取回，可以继续取回" }`
（这个状态在真实使用中由「结果下载失败/超时」产生，见 `canvas-generation-failure.ts:119`），
然后选中节点、点「生成」。选这个状态是因为它同时满足「按钮可用（`isCanvasNodeGenerating` 为 false）」和
「提交被拦（`canvasImageGenerationHasPendingResult` 为 true）」，并且它排在模型配置检查之前，所以整条链路不需要可用的模型凭据。

注意：这条验证用的是**已有的测试数据与假上游**，没有真实生成、没有取回、没有扣费。

### 本次改动只改「原因展示」

被拦下的提交在修复前后都是**不提交**：单测断言 `submissions === 0`、浏览器验证里地址栏与节点状态不变、任务列表没有新任务。
本次没有触碰生成、免费取回（「继续取回」按钮与其任务绑定）、重试判定（`canvasGenerationRetryBlocked`）与扣费判定，
也没有改任何上限数值；这些判断若需要修改，仍按约定并入 #88。

### 未完成的部分

- 参考图上限那条拦截（`canvasImageReferenceLimitError`）没有在浏览器里单独复现：需要把渠道模型的能力表 `maxImages` 改成 2 并连出 3 条参考连线。
  它与「有待取回结果」走同一个修复函数、同一条渲染路径，因此本次没有为它单独铺一遍 UI 链路。
- 客户那一次的具体拦截点仍未定位（见第七节）。

## 七、还需要的输入与后续

- **定位客户那一次的具体拦截点，需要客户信息**：模型、客户端版本、入口（创作页 / 画布图片节点 / 助手），
  以及诊断包（可看到提交阶段的 `generation_submit_started` / `generation_*_blocked` 诊断事件）。
  采集侧下次收到同类反馈时建议一并索取，否则只能停在「同族缺陷已修」。
- 画布上仍有一批 `message.*`（该目录共 274 处）属于「用户点按钮后唯一的反馈」。本次只改了提交路径上会**拦下整个提交**的那几条；
  其余（例如成功的轻提示、非阻塞告警）不属于「点生成无反应」，未一并改动，需要时单独评估。
- 创作页剩余两处不可见提示，属于同一类缺陷但与本条反馈无关，本次未改：
  `web/src/pages/create/index.tsx:666`（未配置模型时 `toast.warning`）、`:707`（技能上下文加载失败 `toast.error`）。
- 若后续证据指向生成任务取回、重新生成、扣费或任务状态判定，按约定只交定位证据并入 #88，不在此单独打补丁。
