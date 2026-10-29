---
half_life: 30d
archive_at: event:step-7-done
artifact_mode: delivery-doc
scope_type: roadmap
scope_name: BeefTV 重构 - 同一条规则只留一份
coverage: 修复集中区域（生成任务结论与取回、模型能力、错误分类、旧直连生成代码、助手、画布保存、后端分层）的步骤、顺序、每步交付与验收，以及大文件拆分时机
not_complete_for: 付费授权（报价、同意表、后台拒绝、外部程序付费开关）、画布性能、发布与更新器、插件生态、导演台与素材库新功能
verification_level: local
real_smoke_status: not_run
review_status: not_reviewed
reviewer: none
review_command: 未另派评审；第 0、1 步代码由 go test / bun test / bun run build 自查
review_notes: 方案基于 origin/main 285c7dec 的代码与 10 月提交记录，并对照 #84 原稿、#86 修订稿、统筹记录、助手方案 #38
review_owner: Sunny
review_due: event:step-2-start
execution_backend: direct
lead_agent: current
peer_agents: none
builder_agent: none
verifier_agent: none
verification_independence: self_checked
cwf_decision: not_needed
cwf_trigger_boundary: none
goal_handoff: skipped
acceptance_contract_status: owner-confirmed
memory_required: true
memory_space: default
acceptance_memory_id: 292b72ba-e32e-4c18-953b-ef5b27203328
memory_asserted_by: external:claude-code:refactor-plan-2026-10-28
memory_confirmed_by: human:Sunny
memory_intended_for: BeefTV 实施者与评审者
memory_validity: current
memory_valid_from: 2026-10-28
memory_review_due: event:step-4-done
---

# BeefTV 重构方案：同一条规则只留一份

本文替代 `refactor-plan-20261027.md` 的 #84 原稿（`05abab0f`）和 #86 修订稿（`bffc87f5`），两者都没有合进 main。生成任务的详细行为规则仍以[状态方案](generation-task-state.md)为准，助手部分以 [`docs/plans/assistant-refactor.md`](../plans/assistant-refactor.md)（#38）为准；本文只定顺序、每步交付和验收。用户于 2026-10-28 同意本方案。2026-10-29 方向调整：BeefAPI 模型的规则不放在 BeefTV 里，见第九节；第九节与前文冲突时以第九节为准。

## 一、为什么要做，以及上一轮为什么效果不理想

10 月 main 上有 246 个 `fix` 提交、52 个 `feat`。被修复提交改得最多的产品文件，正好是前后端各写一份同样规则的地方：

| 文件 | 行数 | 10 月修复次数 |
| --- | --- | --- |
| `web/src/lib/model-capabilities.ts` | 1509 | 16 |
| `backend/internal/generation/provider_error.go` | 1607 | 13 |
| `backend/internal/modelcatalog/capability.go` | 1244 | 13 |
| `agent-host/durable-session-owner.mjs` | 1221 | 13 |
| `web/src/lib/generation-error.ts` | 1180 | 12 |
| `web/src/pages/canvas/project.tsx` | 3556 | 12 |

具体重复：`isSeedance2Family` 有三份（前端、`modelcatalog`、`app`）；`generation-error.ts` 和 `provider_error.go` 有 89 个相同错误码，前端另有约 120 处按错误文字判断；前端 27 个文件自己推断任务能否重试、能否取回，没有一处读后台给的任务结论（`outcome`）。

上一轮在 Todos 上推进不顺，原因是做法：

- 产出以文档和取证为主。#86 把模型能力、错误分类都改成"等找到反例再说"，能开工的只剩生成任务第 3 步；#83 做了 16 项实验；画布性能做到第 6 轮采样，其中几个提交在修测量工具本身。
- 方案改了 4 轮，已合入的 `task/outcome.go` 照的是第 3 轮，和最新规则对不上。

## 二、做法约定

1. 每一步交一个能合并的代码 PR。说明写在 PR 描述里，不另写长文档。
2. 规则写成测试表。方案要改规则，就改测试表。
3. 删重复代码不需要先取证；会改变用户看到的行为时才先复现。
4. 加新路径的同一个 PR 里删掉旧路径；同一批文件同一时间只开一个 PR。
5. 新代码不再放进 `backend/internal/app`；不新增状态机、通用检查框架或内容过滤。

## 三、步骤

工作量是粗估，不含 review 和发版等待。

### 第 0 步：修 `outcome` 的三处问题（已完成）

- 审核失败（`content_policy_violation` / `content_moderation` / `SAFETY.INPUT.*`）由 `blocked` 改为 `confirm`，节点有出口；审核失败不代表没扣钱，所以仍要确认。
- 删除恒为 false 的 `ConfirmedUncharged`。
- "请求尚未提交"改由写入阶段的 `app` 层给出 `RequestNotSent`，`task/outcome.go` 不再比较中文显示文字。
- 长条件拆成 `provablyNotSubmitted` / `isInputRejectedCode`，补表格用例。

验收：`go test ./internal/task/ ./internal/taskdelivery/` 通过。改动前 `outcome` 没有任何前端或后台守门在读，所以这一步没有用户可见变化。

### 第 1 步：删前端旧的直连生成代码（已完成）

- 删除 `requestVideoGeneration` / `createVideoGenerationTask` / `pollVideoGenerationTask`、`requestGeneration` / `requestEdit`，以及只为它们存在的 `video-provider-*.ts`（8 个）、`video-transport.ts`、`video-response.ts`、`video-reference-roles.ts` 和 `image.ts` 内的私有辅助函数。
- `video.ts` 只保留仍在用的 `storeGeneratedVideo` 和类型。`requestImageQuestion`、`requestToolResponse`、`video-validation.ts` 保留。
- 测试：删除 `agnes-video.test.ts`，在其余 8 个文件里只删通过已删代码发请求的用例（共约 43 个）；同文件里测仍在用模块的用例保留。

验收：相关 9 个测试文件 63 个用例通过；前端全量测试和 `bun run build` 结果见本分支 PR 描述。

未做：被删用例里有一部分是在前端验证上游请求格式（例如 H3 关键帧、Seedance 参考素材角色）。产品实际走后端，这些格式要由后端测试保证；本步没有逐条核对后端是否已有对应用例，第 2 步做 Seedance/H3 时一并补。

### 第 2 步：模型能力只留后端一份（3–5 天，先 Seedance/Seedream）

- 删除 `app/modelcatalog_delegate.go` 里那份 `isSeedance2Family`，改调 `modelcatalog`。
- 前端删除按型号写死的规则（Seedance、Seedream 覆盖），改读后端 `capabilityConfig`。
- 后端缺的 `thinking` 补到后端；未保存的自定义配置也交给后端计算。桌面版和 Compose 部署都带后端，不存在后端不在线。音频暂不动。
- 10 月相关修复（时长下限、参考素材合计 12 个、Pro/Flash 识别、线路识别、#273 尺寸校验）各写成一条后端表格用例；补第 1 步留下的请求格式用例。
- 之后每个 PR 只换一个型号系列。

验收：后端表格测试通过；同一已保存型号，前端表单可选项与后端返回一致。

### 第 3 步：错误分类只留后端一份（3–5 天，可与第 2 步并行）

- 逐条列出前端按文字判断的规则，确认后端已给出对应 `reason`；没有就补到后端，同一个 PR 删除前端那条。
- 结束后前端只剩"错误原因 → 显示文字"一张表。

这是状态方案第 7 步"前端不再分类任务错误"，提前做，因为它是修复第二多的地方，且不依赖付费部分。

### 第 4 步：生成任务由后台取回，前端只读 `outcome`（1.5–2 周）

| 子步 | 内容 | 验收 |
| --- | --- | --- |
| 4a 后台补齐取回 | `/recover`、视频与超分自动查上游、同一操作编号只生成一次；复用既有租约、操作回执、交付器，取 #68 中正确部分 | #83 的 16 项夹具接真实入口；重启后不重复生成 |
| 4b 前端读 `outcome` | 按钮、确认框、节点锁定改看 `phase` / `regenerate` / `reason`；删除 `resourceReloadAvailable`、`shouldBlockManualRetry`、`generationSubmissionState` 推断和前端恢复扫描；现有付费确认框保留 | 一次完整操作：提交 → 上游成功 → 下载失败 → 后台取回 → 节点显示成片，含重启；双击重新生成只生成一次；审核失败的节点确认后可重新生成 |
| 4c 扣费原值 | 读 BeefAPI 结算原值，BeefAPI 渠道的 `regenerate` 按结论给出 | 状态方案 3.11 的六种映射 |

4b 不等 4c：4c 之前 BeefAPI 任务一律 `confirm`，只多问一次，不会多扣钱。

不在本方案：报价、同意表、后台拒绝提交、外部程序"允许发起付费生成"开关，另行立项。

### 第 5 步：助手，按 #38 执行

- 现在可开：#38 第 1 步（旧任务回执不覆盖新任务；实时显示与历史读回同一规则；方案明细折叠）和第 4 步（自动接续只由后台发起，删除前端认领）。
- #38 第 2 步（助手读后台任务结论）排在本方案第 4 步之后。
- #38 第 5 步（宿主瘦身、创作方法放 Skill）最后，和拆 `durable-session-owner.mjs` 一起做。
- PR #265 以 #38 为准，不整包合并。

### 第 6 步：画布保存只补一条测试（1–2 天）

现有共用保存入口保留。补一条测试：手动编辑、助手写入、后台写回成片同时发生，不丢改动、版本连续。测试能复现问题才修对应调用。PR #279（#55）先按原流程合入。

### 第 7 步：后端分层，跟着前面各步做

哪一步改到哪个 handler，就在同一个 PR 里把它从 `*app.Service` 换成 `localapp` 的窄接口；44 个文件不一次性迁移。多数迁完后，把 `handler` 加进 `bootstrap/dependency_boundary_test.go`。

### 顺序

第 0、1 步（已完成）和助手 #38 第 1 步 → 第 2、3 步并行 → 第 4 步 → 助手其余步骤与拆大文件。一个人约 5–7 周，两人并行约 3–4 周。

## 四、遇到过的问题能否解决

| 问题 | 例子 | 步骤 | 结果 |
| --- | --- | --- | --- |
| 节点锁死、取不回成片、"继续取回"闪烁 | #15、#16/#263、#193、#246、Runway/Luma/Grok 取不回 | 0、4 | 大部分能修。上游本身没出结果、过了保留期，只能确认后重新生成 |
| 恢复前又点生成、双击重新生成报错 | 状态方案 5.1 第 1、2、11 条 | 4 | 能修。外部程序绕过确认花钱，要等付费部分另行立项 |
| 审核失败被误判 | #255、5.1 第 13 条 | 0、3 | 能修 |
| Seedance/Seedream 参数反复修 | 时长下限、参考素材 12 个、Pro/Flash 识别；Issue #244 | 2 | 以后只改后端一处。#244 是否同一原因未查，不保证修好 |
| 错误提示不准 | #172、#178 VOD 错误码 | 3 | 能修 |
| 修到没人用的旧代码 | `video-provider-*` | 1 | 已修 |
| 助手：旧回执改坏新节点、回复消失或攒到最后、自动接续重复 | 10-17/18 二十多条修复、#36 评审 | 5 | 大部分能修。模型回答质量和提示词不在范围 |
| 画布丢改动、版本冲突 | 10-17 保存对账 | 6 | 测试能复现才修 |
| Mac 画布卡顿、闪烁、丢节点 | 10-26 会议第 5 项 | 不在范围 | 性能单独做；取回按钮来回切造成的闪烁会在第 4 步去掉 |
| 发布与更新器、Topaz 预扣、"拍不了照片"、助手缺 Flash | — | 不在范围 | 不是重构问题 |

## 五、什么时候拆大文件

拆分同时满足三条才做：最近常出问题或常冲突；拆出去的部分只负责一件事；拆完要传的参数变少。只因为行数多不拆。

| 文件 | 行数 / 10 月修复 | 时机 |
| --- | --- | --- |
| `model-capabilities.ts` | 1509 / 16 | 第 2 步自然变小 |
| `generation-error.ts` | 1180 / 12 | 第 3 步自然变小 |
| `provider_error.go` | 1607 / 13 | 第 3 步后它是唯一一份，仍难改再按渠道系列拆 |
| `project.tsx` | 3556 / 12 | 第 4 步后。12 次修复约 7 次与生成、取回有关，先删再拆。已抽出 40 多个 hook，页面仍有 67 个 `useCallback`；这次拆出去的部分要自己管自己的状态 |
| `canvas-node-prompt-panel.tsx` | 1161 / 10 | 第 2、4 步后 |
| `durable-session-owner.mjs` | 1221 / 13 | #38 第 5 步 |
| `use-config-store.ts` | 1280 / 9 | 第 2 步只移走模型能力部分 |
| `repository.go`、导演台两个文件、`project_mutate.go` | 1300–2300 / 0–3 | 不拆 |
| `assets/index.tsx` | 2116 / 7 | 不排期，下次修素材库时顺手拆那一块 |

## 六、与在途工作的交点

- PR #279（#55 绑定修复）仍开着，第 6 步前先合。
- PR #265 评审结论为需修改，助手部分以 #38 为准。
- `8fd8be25 fix(canvas): show blocked generation reasons in the node panel`（Mac 上 Todos 工作区，未合入）改了 `use-canvas-generation-executor.ts` 等第 4 步要动的文件。它管提交前检查，不冲突，可以先合，第 4 步时留意。
- #68 已暂停，第 4a 步取其中正确部分，不整包合入。

## 七、尚未验证

- 第 0、1 步只在本机跑了后端相关包测试和前端测试；`internal/app` 有 3 个视频恢复用例在未改动的 main 上同样失败（本机未装视频插件），与本次改动无关。
- 未运行客户端，未做真实生成。
- 修复次数按提交标题和改动路径统计，标题写法不规范的提交可能计错模块。

## 八、进度（2026-10-29，PR #290）

按 `origin/main` 与 PR 分支实测对比，不按提交说明计。

| 步骤 | 状态 | 实测 |
| --- | --- | --- |
| 第 0 步 outcome 三处问题 | 完成 | 审核失败不再锁死；`ConfirmedUncharged` 与中文阶段比较已删 |
| 第 1 步 删旧直连生成代码 | 完成 | 删 11 个文件约 2350 行 |
| 第 2 步 模型能力只留后端 | 后端完成，前端未完成 | `app` 里那份 Seedance 规则已删，后端有表格用例和能力计算接口；前端 Seedance 规则删除后导致参考素材上限变 0（CI 38 项失败），已恢复。三份变两份 |
| 第 3 步 错误分类只留后端 | 部分完成 | 后端任务失败改用后端类别；前端按文字判断 103 处减到 93 处，浏览器直连渠道和只存文字的批次项仍在前端判断 |
| 第 4a 步 后台取回 | 完成 | 视频、超分自动查询上游，不重新提交；`POST /tasks/:id/recover` |
| 第 4b 步 前端读 outcome | 部分完成 | 32 个前端文件读 `outcome`；旧推断字段从 27 个文件减到 12 个；新增的 `lib/task-outcome.ts` 对没有 outcome 的旧节点仍按错误码推断，属于过渡代码。审阅时修复 4 处回归：批量重试会重发需确认的子节点、查询失败后丢掉「待确认」标记、已有结果的超分节点被锁、失败视频不显示「取回结果」 |
| 第 4c 步 扣费原值 | 完成 | 读 BeefAPI 结算原值；结算列改由 v27 迁移添加，已验证 v2.0.5 库可升级 |
| 第 5 步 助手 #38 | 代码完成，未做桌面实测 | 自动接续只由后台发起；`durable-session-owner.mjs` 1221 → 858 行；两条分镜规则移入「剧本资产视频一条龙创作」技能 |
| 第 6 步 画布三方保存 | 完成 | 并发测试通过，未发现丢改动 |
| 第 7 步 后端分层 | 未开始 | 44 个 handler 文件仍直接用 `app.Service`；`internal/app` 反而增加约 580 行（主要是 `video_auto_recovery.go`） |
| 拆大文件 | 部分 | 提示词面板 1161 → 724 行；`project.tsx` 3556 → 3277 行 |

剩余工作按优先级：前端模型能力改读后端（需先让目录导入与配置加载路径拿到后端结果）；删 `task-outcome.ts` 的旧节点推断（旧节点补齐 outcome 后）；第 3 步剩余文字判断；第 7 步并把新增的取回代码移出 `internal/app`；`project.tsx` 按职责继续拆。

## 九、方向调整：BeefAPI 与 BeefTV 职责分离（2026-10-29 用户确认）

### 9.1 原则

**BeefTV 不知道具体模型的规则。** BeefAPI 负责供应商协议、走 URL 还是 Base64、结果转存（CF→COS）与恢复、扣费结论、错误归类和能力目录。BeefTV 按能力目录展示已有控件、提交任务、把结果放到画布上。

- BeefAPI 新增现有能力范围内的模型（例如又一个"文字加参考图出图"的模型），只改 BeefAPI，BeefTV 刷新模型列表即可使用，不发新版。
- 只有出现 BeefTV 从没支持过的交互或结果类型时，才更新客户端；不能静默降级。
- "由 BeefAPI 决定"不等于文件经过主 API：参考图按上传票据直传 COS，生成结果由 CF 转存到 COS，主 API 只处理小 JSON。

### 9.2 已确认的决定

1. **自带 Key（BYOK）和第三方直连渠道的各家协议改为协议插件。** BeefTV 主体只保留 BeefAPI 统一协议和通用 OpenAI 兼容协议，不再有按模型名写的代码。
2. **PR #290 先合**，新方向在其上继续。用户确认此 PR 不再另做交叉 review。
3. **统一媒体协议**采用 Codex 会话的设计（`SERVER-OWNED-MEDIA-DECISION.md`：先协商协议版本 → 按票据直传素材 → 提交小 JSON 引用 → 拿回结果地址；新请求带协议版本，版本进入请求指纹，同一编号换版本直接冲突；历史任务按原请求恢复），并做以下修改：
   - **按通用媒体设计，不只做图片。** 先实现图片，视频、超分、音频随后接入同一套上传票据、引用格式、结果地址和能力目录。
   - **重发和取回只由 BeefAPI 负责。** 协议上线后，BeefAPI 渠道的任务 BeefTV 只按任务号查询结果，不再自己同键重发或自动取回；BeefTV 里对应代码随之删除，仅 BYOK 渠道保留。
   - **BeefTV 只在一个地方跟 BeefAPI 打交道**：本地后端的 BeefAPI 适配层。`generation/` 下按模型命名的文件中属于 BeefAPI 渠道的部分，跟协议上线同一批删除。
   - 协议版本除响应头外也写进 `/v1/models` 的返回内容。

### 9.3 对原步骤的影响

| 原步骤 | 调整后 |
| --- | --- |
| 第 2 步 模型能力 | 规则来源由 BeefTV 后端改为 BeefAPI 能力目录（沿用现有 `ImageCapabilityConfig` 结构，不另建表单框架）；BYOK 能力随协议插件声明 |
| 第 3 步 错误分类 | BeefAPI 返回统一错误类别，BeefTV 只按类别选显示文字；`provider_error.go` 只留给协议插件 |
| 第 4 步 取回 | BeefAPI 渠道由 BeefAPI 负责转存与恢复，BeefTV 只查任务状态；#290 加的视频自动取回仅 BYOK 使用 |
| 第 4c 步 扣费 | 不变，照读 BeefAPI 结论 |
| 第 5、6 步 | 不变 |
| 第 7 步 后端分层 | 不变；BeefAPI 渠道代码移出后 `internal/app` 需要搬的内容减少 |

### 9.4 分工

同一批文件同一时间只有一条线在改。

| 负责方 | 范围 |
| --- | --- |
| Codex（会话 `sess_8XgILdwXifvNnQ`） | BeefAPI 仓库（媒体协议服务端、转存、恢复、能力目录、错误类别）；BeefTV 的 BeefAPI 适配层：`backend/internal/beefapi/`、`backend/internal/generation/`、`backend/internal/modelcatalog/`、`backend/internal/app/` 中的 `image_auto_recovery`、`video_auto_recovery`、`provider_task_recovery`、`beefapi_seedance_preupload`、`seedream_outputs`、`generation_runtime`，前端 `lib/model-capabilities.ts`、`stores/use-config-store.ts` 的能力部分、`services/api/image*.ts`；PR #291 在合并 #290 后的 main 上重做，删除按模型选传输的名单 |
| 本线（Claude） | 第 7 步中与生成无关的 handler（画布、项目、素材、助手等）改用 `localapp` 窄接口；`project.tsx` 按职责拆分；`lib/task-outcome.ts` 旧节点推断的清理；`agent-host/`。BYOK 协议插件化在 Codex 的适配层合入后开始，因为两者都会动 `generation/` |

### 9.5 验收

- 服务端加一个 BeefTV 没见过的模型名，同一份客户端代码能上传参考图、生成、取回结果，不需要按模型名的补丁。
- 缓存的 Base64 选项、插件默认值都不能改掉协商好的协议；每条选中或重试的路由在调用供应商前拒绝不兼容的传输，原付费任务的供应商创建次数保持 1。
- 显式的旧 Base64 请求、第三方 multipart 和历史任务按原请求恢复，行为不变。
- 大图实测：50MB 参考图直传、COS 完整解码与哈希校验、主 API 媒体上传下载次数为 0。
- BeefTV 主体里不再有按模型名分支的生成代码（BYOK 协议在插件包中）。

### 9.6 当前候选实现（2026-10-29，尚未发布）

本批先完成图片的 `managed-media-v1`。内置 BeefAPI 连接按 `/v1/models` 的响应头和正文协商，参考图与蒙版使用通用上传票据直传；生成只提交小 JSON，结果接收存储 URL。图片传输不按型号选择，陌生模型 ID、旧 Base64 配置及插件默认值均按同一份服务端合同执行。第三方连接保留原协议。

每次用户授权的 attempt 在首次 POST 前复用现有发送记录保存稳定编号；断线、429、重启和历史冻结任务随后只 GET 原任务。v28 仅增加加密的小型查询信息，24 小时后仍清理原始大请求。已经丢失查询信息的历史任务保持未知，不创建替代任务。层信息、原输出顺序、用量和 API 结算字段保留；旧 Base64 回执由适配层直接从存储读取。

现有视频、超分及语音的 BeefAPI 网络调用集中到 `internal/beefapi`，视频发送通用角色与用户选定的 operation，供应商差异由 API 处理。视频和超分恢复改为查询原任务，不再由客户端重发或调用上游取回。它们仍使用现有 API，并未接入新的通用任务引擎；语音仍保留旧 SSE 兼容处理。BYOK 插件化、剩余业务型号判断和通用视频/音频引擎属于后续工作，不能据此宣称所有媒体均已统一或全部不经过 API 主机。

本地定向验证已覆盖陌生模型、多张约 50MB 参考图与蒙版、上传失败时零创建、断线和 SQLite 重启后仅 GET、旧冻结回执与层信息、第三方协议，以及 5GiB 流式上传。完整后端、race、独立评审、CI、合并和公开版本分别验收，候选测试结果不代表已经上线。
