---
half_life: 7d
archive_at: 2026-11-03
artifact_mode: delivery-doc
scope_type: roadmap
scope_name: BYOK 连接与协议整理
coverage: 连接流程、全部现有插件的去向、视频直连优先级、旧配置迁移和实施验收
not_complete_for: 各厂商全部模型与模式的实现规格、线上可用性认证、付费验收和正式发布
verification_level: docs-only
real_smoke_status: requires_approval
review_status: not_reviewed
reviewer: none
review_command: 未进行独立评审；本轮只做来源核对和文档静态检查
review_notes: 本文是建议方案，未改变代码、用户配置或发行包
review_owner: 项目负责人
review_due: 实施前复核厂商公告与并行任务结果
execution_backend: docs-only
lead_agent: current
peer_agents: none
builder_agent: none
verifier_agent: none
verification_independence: self_checked
cwf_decision: not_needed
cwf_trigger_boundary: none
goal_handoff: skipped
acceptance_contract_status: proposed
memory_required: false
memory_space: default
acceptance_memory_id: none
---

# BYOK 整理方案

## 1. 推荐结论

**BYOK 的目标是：用户不连接 BeefAPI，只凭自己的服务地址和凭证，就能在同一套创作界面里选模型、生成、取回视频，并在重启后继续找回任务和作品。** BeefTV 负责创作与可靠交付；费用由用户选择的服务商结算。不以插件数量或厂商 Logo 数量衡量支持程度。

建议采用以下整理方式：

1. **本体保留一个连接入口、一套模型配置、一套任务与素材交付机制。** 厂商差异交给现有声明式协议插件；工作流和附加能力按需安装。不再引入另一套请求引擎、模型会话循环或插件市场。
2. **保留真正不同的协议，合并重复实现和厂商包装。** 五套视频中转格式并不等价，不能按 `/videos` 路径合成一种。18 个文本兼容插件更适合先合并为共享协议实现和服务预设。
3. **从新建连接和默认发行目录撤下空壳、错误模板及已停服的官方模型推荐。** 有修复需求的厂商保留适配工作；不要继续把模板存在写成“支持官方直连”。
4. **先保护旧配置和未完成任务，再删包。** 当前启动逻辑会清除发行包中消失的官方插件记录，直接删目录会影响老用户。迁移不改服务地址、不换 Key、不换计费渠道、不重新提交生成。
5. **先承接 #26、#27、#28，再完成方舟与一个通用 JSON 中转的完整路径，随后分批补国内外官方直连。** 不等待全部厂商补齐才交付基础整理。

以上是工程建议，并非本轮已批准实施或已经上线的功能。当前任务仅交付本文；不改运行代码，不读写用户真实凭证，不启动应用，不发起供应商生成。

## 2. 核查依据与任务补充说明的修正

### 2.1 基线

- 当前工作树：`1bf517b93da7f5cddef9f4dc93d0a55d12c6176b`。
- 已读取 #24 分支的报告，固定提交：`6263990c60b842b8f751a462b057bb83bea64942`，文件为 `docs/research/video-byok-audit.md`。报告的源码补查基线也是上述 `1bf517b`，但其客户端观察不能外推到本轮或所有安装包。
- 已读取 #26、#27、#28 的任务说明；#27 的对话显示仍在实现凭证指引、表单与测试。读取时其远端分支尚不存在，无法评审最终 diff，因此本文给出衔接要求，不宣称三个任务已完成或已合入。
- 本轮用 Ego 阅读官方公告、Google 视频页、Runway、xAI、万相及 fal 队列说明，并查看 Infinite Canvas 和 LiteLLM 的固定提交源码。火山部分沿用 #24 已核对的文档证据；本轮页面未取得足够正文，不算再次独立验证。
- 记忆检索只作背景。当前 nmem 没有独立 BeefTV Space，相关记录在显式选择的 `default`；检索到的插件架构建议注明“未经用户确认”，没有当成既定产品要求。另查到既有视频协议决定 `8817c1ae-6632-4f91-90f6-9bc0431a9da0`：用户明确要求按协议通用处理，不按域名写死；它与当前仓库外接协议文档一致。本文以当前任务和仓库为准。

### 2.2 必须修正的说法

| 原补充说明 | 本轮核查 | 本方案采用的事实 |
| --- | --- | --- |
| 约 88 个插件、约 29 个视频插件 | `plugin-packages/*/manifest.json` 共 **86** 个；其中 **31** 个视频 provider，包含 `autodl-comfyui`、`runninghub-workflow` 两个工作流接入；去掉两者是 29 个视频 API provider | 全部 86 个目录均有去向，视频清单覆盖 31 项；数量只是源码盘点 |
| 万相等都只套通用模板 | `dashscope-wan-video` 有独立的 `input/parameters`、异步头、响应和素材映射；有版本字段不匹配，不能与完全通用模板混为一谈 | 万相保留并按模型版本修正。可灵、Vidu、PixVerse、混元等确实落在生成器的通用模板循环 |
| 连接页缺少 AK/SK 输入 | `model-service-editor.tsx` 已有 `Secret Key`，但藏在高级设置且提示不区分服务 | 复用现有字段并调整显示与说明，不新增第二套凭证存储 |
| Runway、Luma、Grok 生成成功却取不到视频 | #24 用官方形状的固定响应复现了解析缺陷；不是三家真实付费生成记录 | 修复与验收覆盖非空视频结果、下载、保存；不把样例解析称为线上打通 |
| Sora、Veo 停服 | 官方 Sora 2 / Videos API 已于 2026-09-24 关闭；Gemini API 三个 Veo 3.1 preview 于 2026-10-22 关闭 | 移除对应官方推荐，保留第三方兼容协议；不能推导成“Google 所有视频服务都停了” |

停服依据：[OpenAI 弃用公告](https://developers.openai.com/api/docs/deprecations)、[Gemini 视频说明](https://ai.google.dev/gemini-api/docs/video?hl=zh-cn)。Google 页面指向其他正式平台或模型，不代表原 `gemini-veo` 插件可直接换模型名使用。

### 2.3 当前有三处容易被遗漏的实现问题

1. **删包会影响运行时。** `backend/internal/plugins/bootstrap.go` 的 `reconcileBuiltIns` 会删除不再随包提供的官方记录；`TestRuntimeDropsRemovedOfficialProtocol` 还锁定了此行为。当前构建脚本遍历全部 manifest 打包，桌面发布脚本再复制全部归档。没有可靠的“仅不再推荐新用户，老用户照用”能力可直接套用。
2. **前端有独立的兜底清单。** `web/src/services/api/plugin-catalog.ts` 在目录请求失败时硬编码提供四个 OpenAI 兼容协议，其中有 `newapi`。整理必须检查它与后端实际可执行清单一致，不能目录失败后重新显示已撤下的官方推荐或不可用协议。
3. **宿主和厂商映射已经基本分开，应继续复用。** `generation-task.ts` 走后端任务，`generation/protocol.go` 统一执行创建、查询和下载。`web/src/services/api/video.ts` 仍有旧创建与轮询分派；本轮在 `web/src` 未找到这些执行导出的外部调用，但 `storeGeneratedVideo` 仍被使用。删除旧执行代码应先查全部调用与测试，不能整文件删除，也不把它恢复成第二条生成路径。

## 3. 用户应该怎样完成 BYOK

### 3.1 从连接到视频的路径

```text
设置 → 连接你的模型服务
  → 选择已支持的厂商，或第三方模型服务
  → 填服务地址和该服务要求的凭证
  → 读取模型，或手动填写模型 ID
  → 确认模型对应的调用协议和可用模式
  → 保存并使用
创作页 / 画布 → 选自己的连接和模型 → 生成
  → 后端保存任务 → 调用所选服务 → 查询同一任务
  → 下载并保存视频 → 回填画布 / 素材
```

“官方直连”指上游是厂商官方 API，不经过 BeefAPI 结算或渠道。请求仍通过用户本机的 BeefTV Go 后端完成签名、执行和下载；不等于浏览器直接带 Key 请求厂商。

具体行为：

- 不要求先登录、绑定或充值 BeefAPI，不因为 BeefAPI 未连接而阻止自己的连接。允许仅使用本地服务；无鉴权协议按其声明允许留空凭证。
- 已支持的官方服务自动给出正确地址、凭证说明及视频协议。方舟普通推理、Agent Plan、即梦 AK/SK 是不同接入，不能只改地址后沿用错误 Key 和协议。
- 目录读取是可选便利功能。目录失败只影响模型发现，不把连接判定为“无法生成”；用户可以手填准确模型或 endpoint ID。推理连接不为了读取目录额外要求管控 AK/SK。
- 通用中转无准确协议元数据时，复用现有协议选择器，在选择视频模型时就显示需要选择的格式；不把必要操作藏到“高级”里，也不通过发起生成猜格式。
- 保存只保存配置；不自动生成、不自动测试。连通性或目录检查成功也不显示成“视频已验证”。
- 模型能力决定现有时长、比例、参考素材等控件。不支持的模式或素材在提交前解释原因，不静默丢掉第二张图、尾帧或音频。
- 上游任务已有 ID 后，下载失败只恢复查询或取回结果，不重新创建任务。超时且是否受理不明时保留“结果未知”，不切到 BeefAPI 或另一协议再次扣费。
- 上游成功、视频下载完成、作品已保存是不同事实。最终完成需要可播放的本地素材及画布绑定；不能仅凭上游 `succeeded` 显示作品已完成。

### 3.2 少加界面，不少做必要选择

沿用“连接服务 / 选择模型”两步和现有模型配置编辑器。把现有协议选择器在需要时提前展示；把已有 `Secret Key` 在签名服务下展开并改成准确标签。厂商说明由协议元数据和服务预设产生，不增加“BYOK 模式”“高级渠道类型”等全局开关。

服务商列表只列已经达到本方案验收条件的接入。新增厂商是现有列表的数据项，不是一套新页面或独立按钮。未安装的扩展沿用插件中心安装；第一阶段不另建自动下载市场。

### 3.3 怎样算整理好了

必须同时满足以下条件，不能用“删了多少插件”替代：

1. 不连接 BeefAPI 的全新环境能完成自己的官方视频服务与通用 JSON 中转两条路径；所有出站请求只到用户所选上游及必要素材地址。
2. 每个默认推荐的厂商，都能指出**具体模型、具体模式、实际插件版本**的证据；未验证项不混入“已支持”名单。
3. 连接页不再让用户猜 Key 类型；目录失败可手填；官方已停服模型不再默认推荐；未选择准确视频协议不能误提交。
4. 老配置升级后凭证、地址、模型、协议选项不丢；原任务可恢复取回，升级或重试不新增生成请求。
5. 源码 manifest、构建归档、干净安装的可选列表、请求执行使用同一份协议定义；每层分别留证。
6. 厂商特殊实现集中在插件；宿主不出现一套按域名、品牌或模型名自动换协议的逻辑。

第 1、2 项的真实供应商验证需要另行批准的测试范围和费用。本轮只能设计这些验收，不会用付费调用证明它们。

## 4. 保留什么，放在哪里

### 4.1 本体、协议插件、服务预设各负责什么

| 对象 | 唯一责任与数据来源 | 本次建议 |
| --- | --- | --- |
| 本体 | 连接编辑、配置保存、任务生命周期、素材准备与下载、错误展示、安全传输与签名能力 | 保留现有实现；不为每家厂商增加专用页面或 Worker |
| 服务连接 | 用户地址、凭证、headers、模型选择；沿用 `ModelChannel` 和本地 `workspace.ProviderConfig` | 不再建 BYOK 配置库；复用 revision、原子保存与加密机制 |
| 模型配置 | 已明确选择的协议、能力与模型参数；沿用 `modelProfiles` | 用户显式配置优先；服务预设仅初始化，不持续覆盖已有模型 |
| 协议插件 | 请求、鉴权声明、查询、结果、错误、模式与参数限制 | 原有 `beeftv.plugin/v2`；共享模板消除重复，差异保留在各 profile |
| 服务预设 | 厂商显示名、地址、凭证说明、支持能力与协议默认值 | 随插件定义提供，投影到现有连接列表；不在 React 和 Go 各维护一份厂商表 |
| 插件目录 | 安装、启用、版本和是否允许新选择 | 继续由后端插件 registry 提供；前端只是展示。后端启用状态不由前端兜底猜测 |
| 工作流 / 附加功能 | RunningHub、ComfyUI、后处理等自己的业务与输入 | 按需扩展，不混在“官方视频 API”默认推荐里 |

现有目录 DTO 只有 `baseUrl/authType` 等概要，不能据此宣称已经能动态生成完整凭证指引。实施时仅给当前 catalog 补足所需展示信息，复用 manifest 中已有的 `configuration` / auth 声明；不要先造一个通用表单框架。目录格式 `apiFormat` 与生成协议 `modelProfiles[].protocol` 是不同用途，不能合成一个字段。

生成器管理的插件以 `generate-catalog.mjs` 为编辑源，manifest 为产物；手写插件以自身 manifest 为编辑源。不得只改生成后的 JSON，让下一次生成恢复错误模板。支持状态和预设信息也跟随这份源定义，不另维护会漂移的发布白名单。

### 4.2 现有连接预设

| 当前预设 | 去向 | 修改内容 |
| --- | --- | --- |
| 第三方模型服务 `compatible` | 保留，作为本体最小入口 | 地址自填；准确目录元数据或用户显式选择协议；不默认把所有视频当 Sora multipart |
| OpenAI `openai` | 保留文本、图片 | 删除官方视频默认推荐；第三方 OpenAI Videos 兼容协议独立保留，不和 `api.openai.com` 的服务状态混为一谈 |
| Google Gemini `gemini` | 保留仍在服务的文本、图片能力 | 撤下停服的 Veo 3.1 preview；替代视频模型按新协议单独核对，不能只换模型 ID |
| 火山方舟 `ark` | 保留并明确普通推理用途 | “即梦图片”建议改为准确的 Seedream / 方舟图片说明；Agent Plan 与即梦开放平台使用各自凭证指引和协议 |
| BeefAPI 连接（单独的托管能力） | 保留为可选服务 | 不作为 BYOK 前置条件，不与用户自带凭证自动合并；本单不删除 BeefAPI 产品能力 |

后续已验证的官方直连加入同一列表。方舟普通 Key、Agent Plan 专属 Key 和即梦 AK/SK 如需并用，保存为不同连接；一个连接内不能靠自动换 Key 类型来共享这些计费路径。

## 5. 视频协议和插件逐项去向

### 5.1 五套相似中转：合并入口，不抹掉格式

“合并”先指共享执行器、模板公共部分和一个“第三方模型服务”入口；不是把持久化协议 ID 全改成 `newapi`。本轮源码没有证明这五套中任意两套端到端等价。

| provider ID（包目录） | 已核对的关键区别 | 建议 |
| --- | --- | --- |
| `newapi`（`openai-videos`） | `POST /v1/videos`，multipart；`seconds` 字符串、`input_reference` 单图；轮询后可能到 `/content` 下载 | 保留兼容协议；显示名强调 Videos multipart；撤下官方 Sora 默认能力，不删第三方同格式服务 |
| `newapi-channel-1`（`newapi-media-task-v1`） | `/v1/videos` JSON，`input.prompt/media` 与 `parameters.duration/ratio`，素材有类型 | 保留独立格式，显示结构名称；补来源与固定样例后推荐，不再用“渠道 1”要求用户猜 |
| `newapi-channel-2`（`newapi-video-generations-v1`） | `/v1/video/generations` JSON，`seconds/aspect_ratio/image_urls/video_urls/audio_urls`；结果兼容多层嵌套 | 保留独立格式；已有嵌套任务与结果测试，仍需实际服务版本证据 |
| `video-generations-json`（同名目录） | 同上路径但用整数 `duration/ratio`；`images` 是带 `url/role` 的对象；结果在 `data[].url` | 保留，作为第一批通用 JSON 验收对象；已有明确文档与本地模拟路径 |
| `seedance-videos-compatible`（同名目录） | `/v1/videos` JSON 平铺 `prompt/images/videos/audios/duration/aspect_ratio`，是生成器通用模板 | 从默认推荐撤下；旧连接保留。未找到明确服务合同与固定样例前不叫“Seedance 通用支持”；无引用后删除模板。若后来有确实使用此格式的服务，作为该格式扩展修正后再上架 |

依据：[仓库外接协议调查](../refactor/external-video-protocols.md)及本轮逐个 manifest 对照。错误后尝试另一格式、按域名猜协议、把模型名包含 Seedance 当作方舟协议，都不属于合并方案。

### 5.2 31 个视频 provider 完整清单

下表“保留”表示方向或实现值得继续维护，**不表示本轮通过真实生成**。“撤下再修”表示新建入口和默认发行推荐撤下，旧配置按第 7 节处理；不是当场删除用户数据。`provider ID` 未另注明时与包目录同名。

| 包目录 | 去向与接入方式 | 必须完成的工作 / 限制 |
| --- | --- | --- |
| `openai-videos` | 保留通用中转；provider `newapi` | 仅承诺明确兼容格式；移除官方 Sora 推荐 |
| `newapi-media-task-v1` | 保留格式；provider `newapi-channel-1` | 补服务来源和完整固定样例，再决定默认可选性 |
| `newapi-video-generations-v1` | 保留格式；provider `newapi-channel-2` | 保持字段及嵌套响应，不与 ratio/duration 格式硬合并 |
| `video-generations-json` | 保留通用中转 | 作为最小完整验收路径；保留多图顺序与 role |
| `seedance-videos-compatible` | 撤下，条件满足后删除模板 | 没有明确合同前不新增推荐；不能迁成 multipart |
| `volcengine-ark-seedance` | 优先官方直连；provider `volcengine-ark-video` | 保留；验证 endpoint/model、素材角色和必要字段，不声称全模式支持 |
| `volcengine-ark-agent-plan-seedance` | 优先官方直连；provider `volcengine-ark-agent-plan-video` | 保留独立 plan 路径和专属 Key；与普通方舟共享映射代码，不合并连接 |
| `volcengine-jimeng-video` | 保留修复，旧接口有限支持 | 承接 #26；成功码、frames、比例、查询字段；仅对仍服务的 `req_key` 开放新配置，不推荐已下线中的旧版本 |
| `minimax-hailuo-video-v2` | 第一批官方直连；provider `minimax-video` | 已有 H3 V2 专用 content；按模型变体验收，不回退到旧 V1 或通用模板 |
| `dashscope-wan-video` | 第一批官方直连 | 保留专用实现；按模型版本核对地域主机、resolution/ratio/size、各模式路由；不是重新套模板 |
| `kling-video` | 撤下模板，第一批补官方直连 | 固定一代官方 API、区域与鉴权；新旧可灵不可仅改路径混用；从一个明确生成模式开始 |
| `vidu-video` | 撤下模板，第一批补官方直连 | 修官方 Token 鉴权、各模式路由与 creations 结果；不能用通用 Bearer `/v1/videos` 代替 |
| `pixverse-video` | 撤下模板，第二批官方直连 | 专用请求头、追踪 ID、业务码、素材上传 ID 与结果；追踪 ID 不作幂等保证 |
| `tencent-hunyuan-video` | 撤下模板，第二批官方直连 | TC3 已有；补官方服务、Action/Version、POST 查询与响应，不能只证明签名可运行 |
| `runway-video` | 保留修复，海外第一批官方直连 | 承接 #28；版本头、模式路由、promptText/promptImage/ratio、`output[]` 与下载 |
| `luma-dream-machine` | 保留修复为扩展，暂不默认推荐 | 承接 #28 的 `assets.video`；另核对 Dream Machine 当前入口与 Luma Agents，未经核实不整包删除，也不冒充新平台适配 |
| `xai-video` | 保留修复，海外第一批官方直连 | 承接 #28；`request_id`、`video.url`；新模型素材/时长按版本声明 |
| `google-gemini-veo` | 撤下官方 preview 推荐；provider `gemini-veo` | 保留旧记录及必要取回能力；无仍可用合同的模板从默认发行移出。第三方同格式是否可用要单独证据 |
| `vertex-veo` | 撤下模板，后续官方扩展 | 云项目、区域、令牌与长操作需专门验证；Gemini preview 停服不构成删除 Vertex 全平台的依据 |
| `fal-queue-video` | 保留方向，先修队列再默认提供 | 当前模板用 Bearer，且未完整表达 status/result 两步。官方要求 Key 鉴权和独立结果取回；不是已完成的通用中转 |
| `pika-via-fal` | 合并到 fal 队列实现与 Pika 模型预设 | 不作为 Pika 官方直连；保留 endpoint 的模型输入转换，旧 ID/选项迁移必须有固定样例 |
| `replicate-prediction-video` | 保留按需扩展 | Predictions 生命周期与模型 input/version 保持独立；不把所有模型 input 当成同一个视频 schema |
| `novita-video` | 保留按需扩展，补证后推荐 | 有独立实现；未做本轮官方全合同核查，不合并成 newapi，也不标已打通 |
| `agnes-video-25` | 保留按需扩展；provider `agnes-video` | 有专用多模态和限制；与 V2.0 共享公共代码，保留模式/模型差异 |
| `agnes-video-v20` | 保留按需扩展 | 有固定模型和首尾帧限制；不能仅因同厂商就改为 2.5 |
| `full-video` | 保留按需扩展 | 专用分片素材上传与原片下载；不能并入一般 JSON 模板，不作为所有 Seedance 的默认协议 |
| `rolldek-wan-video` | 保留按需扩展 | 有专用 lifecycle 和测试；不因名称 WAN 而改用阿里官方协议 |
| `zhipu-cogvideox` | 撤下模板，后续按需求补官方直连 | 当前在通用模板循环；先补准确请求与结果样例，再决定发布范围 |
| `baidu-video` | 撤下模板，后续按需求补官方直连 | 当前通用模板不足以证明千帆模型可用；无合同和引用时移除模板 |
| `autodl-comfyui` | 保留工作流扩展 | 不列作官方视频厂商；同包还有音频 provider，不能按视频清理误删整个包 |
| `runninghub-workflow` | 保留工作流方向，撤下未验证协议推荐 | 当前协议模板不等于完整工作流接入；与现有工作流功能核对后只保留一个执行入口，本单不扩大为全局工作流重构 |

厂商优先级依据是当前用户请求、#24 的确定性缺陷和现有实现成熟度，不是市场份额排名。没有使用量证据，不以“没人使用”为删除理由。

### 5.3 直连与中转的明确取舍

**用户有原厂 Key 时，主流视频厂商必须能走专用官方适配；通用中转不能代替这项能力。** 国内首批为方舟普通 / Agent Plan、海螺、万相、可灵、Vidu；海外先 Runway、Grok。即梦开放平台承接既有需求，但按仍在服务的接口版本交付。PixVerse、混元随后补；Luma、Google 正式视频平台先明确平台合同再推荐。

以下情况通用或托管格式就够：用户本来就在使用提供明确兼容协议的自建网关、中转服务、fal、Replicate。Pika 当前已有的路径就是 fal，不需要为了品牌再写一份队列执行器。文本厂商确实采用 Chat Completions 时，也无需为每个厂商维护重复引擎。

不新增“同名模型必定直连”的推断；不承诺一个厂商支持文生视频就等于图生、首尾帧、参考音频、编辑、延长全部支持。

## 6. 非视频插件也整理，但不借机全面重写

86 个目录中其余 **55** 个是 30 个文本、23 个图片、2 个独立音频包。下面按完整组列出；加上上一节 31 个目录，不漏掉或重复计算插件。

| 目录组 | 去向 |
| --- | --- |
| `openai-chat-completions`、`openai-responses`、`anthropic-messages`、`google-gemini-generate-content`、`ollama-chat`、`cohere-chat-v2` | 保留六种真实不同的文本协议。Chat Completions、Responses、Messages、Gemini、Ollama、Cohere 不按“都是聊天”硬合并 |
| `xai-grok-chat`、`deepseek-chat`、`mistral-chat`、`kimi-chat`、`zhipu-glm-chat`、`baichuan-chat`、`yi-chat`、`siliconflow-chat`、`together-chat`、`groq-chat`、`fireworks-chat`、`nvidia-nim-chat`、`openrouter-chat`、`atlascloud-chat`、`litellm-proxy-chat`、`newapi-chat`、`vllm-chat`、`localai-chat` | 18 个共享模板合并为 Chat Completions 的共享实现与服务预设，移除重复独立包装。先保留稳定 ID 和参数命名空间；工具调用、流式、推理和特殊 headers 的差异通过样例确认后再合并物理包 |
| `azure-openai`、`vertex-gemini`、`aws-bedrock-converse`、`aws-bedrock-invoke-model`、`dashscope-qwen-native`、`minimax-text-native` | 保留特殊协议需求，但撤下当前通用模板的默认推荐，按需补齐后作为扩展。不能为了删文件把 Azure header、云签名或原生消息体改成普通 OpenAI |
| `openai-images`、`google-gemini-image`、`volcengine-ark-seedream`、`volcengine-ark-agent-plan-seedream`、`volcengine-jimeng-image`、`xai-grok-images`、`agnes-image`、`dashscope-qwen-image`、`dashscope-wanx-image`、`stability-image`、`ideogram-image` | 保留现有专用适配；复用厂商连接与凭证，按协议能力决定 UI。本轮未做完整图片质量/线上支持认证，现有有效配置不重写 |
| `fal-queue-image`、`replicate-prediction-image` | 与各自视频插件共享队列/Predictions 生命周期；保留图片结果与模型输入映射，不能把 image/video 响应混成一套无约束对象 |
| `vertex-imagen`、`minimax-image`、`kling-image`、`zhipu-cogview`、`bfl-flux`、`recraft-image`、`adobe-firefly`、`runway-image`、`tencent-hunyuan-image`、`baidu-qianfan-image` | 当前来自通用 image 模板；默认推荐撤下，按需补真实合同。目录名、baseUrl 存在不足以证明这些官方 API 已适配；旧配置继续保留 |
| `openai-audio`、`async-audio` | 保留独立音频协议；同步二进制与异步任务不同，不为了减少包数硬合并。`autodl-comfyui-audio` 在工作流包内，已计入上一节 |

先合并生成器里的重复实现，再考虑减少物理包。包数量不是验收指标；如果合包会破坏 ID、权限、独立升级或模型参数，保留薄包装比增加复杂迁移更合算。空壳模板在完成第 7 节保护后，从生成器和默认发行中删除；Git 历史保留追溯，不长期养一份“有名字但没人能验收”的第二目录。

## 7. 旧用户如何处理：撤下入口、迁移配置、删除执行物分开

### 7.1 先做最小的停用区分

需要区分“允许新用户选择”与“旧任务仍需执行”，当前 `enabled` 一项不能同时表达这两件事。建议在现有插件/模型元数据中增加最小的停用说明和新选择限制，由现有 catalog 投影；保留 `enabled` 的执行含义。不要新增独立弃用数据库、自动迁移服务或用户可调开关。

只影响特定官方 host + model 的停服声明，应放在相应服务预设/模型规则中，不能禁用整个通用 provider ID。例如关闭 `api.openai.com` 上的官方 Sora，不应阻止用户自建网关里的 `newapi`。

### 7.2 按配置类型处理

| 旧配置类型 | 行为 | 明确禁止 |
| --- | --- | --- |
| 协议只是改显示名 / 共享模板 | 保留原 ID、地址、凭证、模型、选项、启用状态，显示新名称 | 用户重新填 Key；因改名重建连接；静默覆盖模型能力 |
| 确实等价的包合并，如 Pika 的 fal 生命周期 | 先比较完整请求/结果样例；必要时用现有 alias 能力保留旧 ID，明确转换 providerOptions 命名空间；配置事务保存、可恢复 | 把 ID alias 当作已解决参数命名空间、鉴权、模式差异；猜测转换用户自定义 body |
| 未验证模板，但用户已经配置 | 旧连接仍可查看、导出脱敏信息和编辑；默认不新增推荐。已工作配置不因“没证据”直接禁用。新任务仍必须通过现有协议与参数校验 | 清空连接或凭证；强行迁往 BeefAPI、fal 或另一厂商；宣称原厂已经下线 |
| 确认停服的官方模型 | 保留连接与历史，阻止该官方模型的新提交，现有位置说明停服与替代方向；用户自行改选仍服务模型 | 自动换成不同价格/凭证/协议的替代模型；删除用户已保存素材 |
| 已有上游任务 ID、下载未完成 | 原协议及必要包继续可供查询/结果取回；固定原请求来源。无法取回时保留明确错误及记录 | 删除协议后按新模板恢复旧任务；再次 create“补救” |
| 用户自行安装的包 | 保持现有来源、版本、权限和启用状态 | 用同名官方包覆盖或在默认目录清理时卸载 |

### 7.3 先修启动清理，再删除包

推荐实施次序：

1. 用合成配置建立引用盘点，覆盖本地 provider snapshot、系统渠道模型、项目/画布中保存的模型配置和未完成/结果未知任务。历史记录即使只需查看，也保留显示名与 ID；发现未知结构则保留，不猜测删除。盘点不输出凭证。
2. 在 `reconcileBuiltIns` 清理前处理引用：仍被旧配置或待取回任务引用的官方包保留已有 registry `Raw`、包哈希及包文件；从新建 catalog 隐藏，不因新版发行包缺失就丢弃。重新启用或升级的判定复用现有 registry，避免第二套状态来源。
3. 需要保留旧版查询解析器的任务，在活跃期间不替换其执行定义。优先利用现有包缓存与 hash；若当前任务没有保存可用的版本关联，则该包暂不升级/删除，先补关联和恢复样例，再迁移。不能把未来的版本锁定能力写成已经存在。
4. 只对已证明等价的配置做一次性、幂等的迁移。使用现有本地配置 revision 和备份；迁移后重复启动不再修改，用户手工覆盖优先。需要改变业务请求的“修复”和纯 ID 合并分开处理。
5. 新装只获得维护中的推荐项；升级用户保留被引用的历史执行物。无配置引用、无待取回任务，或已有等价迁移且恢复验证通过，才清掉旧包与旧生成器条目。按引用事实收尾，不靠“过两个版本应该没人用了”的假设。

执行前先完成迁移 dry-run 和可回退验证；本轮不读取真实用户配置进行盘点。该范围属于用户本单明确要求的旧配置处理，不扩展成长期支持所有旧接口的通用兼容层。

### 7.4 回退

每个删除批次与对应迁移独立交付。保留原配置版本、插件原始定义和哈希，恢复时通过现有配置保存与插件 registry 回到原映射；用户在迁移后作出的修改不得被整份旧备份覆盖。包删除前验证旧版/新版各启动一次及同一任务的继续取回。

回退不能恢复厂商已关闭的服务，也不能重新提交未知状态任务。若迁移失败或发现自定义 body 无法无损转换，保留旧执行物并停止该条迁移，其余不相关项继续处理。

## 8. 与 #26、#27、#28 怎样衔接

**#27 与本方案方向一致，应继续，不需要等本方案实施完。** 它解决当前凭证误导；本方案后续才整理预设与元数据来源。当前未拿到 #27 最终 diff，以下是合入时的核对项，而非已完成的代码审查。

| 任务 | 本单承接的结果 | 不应额外塞入该任务的工作 |
| --- | --- | --- |
| [#26 即梦](https://todos.dev/app/project/PXDVKNL49Xml43kpH_cph/files?ref=tds%2Fconv-01a17904-7fbf-7b86-ae2e-2e5981feaff1) | 即梦局部成功码、frames/比例/查询参数修复及离线样例；保留当前 ID | 全部厂商整理、通用成功码放宽、宣称下线中的接口重新可开通 |
| [#27 设置页凭证](https://todos.dev/app/project/PXDVKNL49Xml43kpH_cph/files?ref=tds%2Fconv-01a17904-7fbd-7105-a5a3-b204e68ea094) | 复用 apiKey/secretKey；清楚区分方舟普通、Agent Plan、即梦；目录失败可手填 | 重建设置页、发明第二套凭证表、把全部厂商适配元数据一次塞入前端 |
| [#28 结果与停服提示](https://todos.dev/app/project/PXDVKNL49Xml43kpH_cph/files?ref=tds%2Fconv-01a17904-7fbe-725b-afc8-e037c4c2f68e) | Runway/Luma/Grok 的正确结果映射与样例，官方 Sora/Veo preview 提示更新 | 删除所有 `newapi`/Google 视频协议、自动迁往新平台、把字段样例通过写成真实生成验收 |

#27 的具体衔接要求：

- 凭证说明依据已明确选择的服务/有效模型协议，不能仅凭方舟 hostname 把 Agent Plan 当成普通推理。
- `apiFormat` 继续只负责目录等既有用途；不要让 OpenAI 目录格式决定方舟或即梦生成协议。
- 复用同一 `apiKey/secretKey` 存储及 `hasApiKey/credentialRef` 等现有含义，切换显示文案不清除已保存的 Key；普通方舟、Agent Plan 与 AK/SK 并用时是不同连接。
- “手动添加模型”在目录失败后仍可走；不为 Agent Plan 推理强制请求管控 AK/SK。
- #27 如果加入临时凭证指引模块，应限定为三条已确认接入的展示信息；后续从插件 catalog 提供同样数据时删除该重复表，不让两个来源长期并存。
- “保存并使用”不附带模型测试；现有测试结果必须对应当前连接与模型，改变协议后不能沿用旧测试通过的显示。

三单最终代码可读后先复核本文相关行，再开始后续切片。不要为了方案中的目录重组而重写正在修复的文件或覆盖他人结果。

## 9. 落地顺序与每步交付

| 阶段 | 交付范围 | 完成依据与停止条件 |
| --- | --- | --- |
| P0-A 承接现有修复 | 完成 #26–#28 并复核实际差异；纠正停服与凭证误导 | 正确/错误/处理中固定样例；#27 的表单截图与手填路径。只有报告没有最终代码时不宣称已完成 |
| P0-B 保护配置与任务 | 先区分新选择与旧执行；保护启动清理；固定旧包引用和配置迁移规则 | 升级、回退、用户覆盖、缺包、禁用包、未知任务均有本地合成用例。此步失败则禁止物理删包 |
| P1-A 最小完整 BYOK | 方舟普通直连 + `video-generations-json`；从保存配置到素材回填，明确 Agent Plan/即梦分路 | 本地模拟上游验证只创建一次、轮询、下载、重启取回；前端不用 BeefAPI 即可到达该路径；发行包与干净安装分别核查 |
| P1-B 精简默认目录 | 撤下空壳和停服推荐；修掉 catalog 兜底漂移；预设改为插件元数据投影；共享 18 个文本模板及 fal/Pika 实现 | 新装推荐名单与源定义一致；旧配置可继续解析；合并前后请求和响应样例等价。未知选项停止自动迁移 |
| P2-A 补国内官方接入 | 海螺、万相、可灵、Vidu，随后 PixVerse、混元；每次一个厂商一个明确模式 | 逐个通过创建/错误/查询/结果/素材/取消能力验证后才进入推荐。任一模式未验收就不展示为支持 |
| P2-B 补海外与平台扩展 | 在 #28 上完成 Runway/Grok 的完整路径；修 fal 队列并合并 Pika；核对 Luma/Google 正式平台；Replicate 等按需提供 | 不以换品牌名完成适配；云权限、区域或生命周期不明确时保留为未推荐扩展 |
| P3 删除旧包装并交付 | 清掉已无引用的旧包、生成器空模板和确认无调用的前端旧执行路径；更新用户文档、协议文档与发布清单 | 迁移与回退证据、包内样例、实际安装可选性齐全；获另行授权后才做供应商付费验收与正式发布 |

这是依赖顺序，不是日历承诺。P2 每完成一家就可形成可审查的独立交付；没有需求和证据的长尾厂商不阻塞 P1。本方案不自动创建任务、不发消息、不安排他人评审或上线。

## 10. 可复用的上游实现

优先顺序保持为 Infinite Canvas → 现有 BeefTV 实现 → 适用许可证的成熟映射/样例。比较问题只有一个：哪些现成字段映射与结果处理可以减少本次适配工作，不搬入对方的计费、路由、任务引擎或运行时。

| 来源 | 本轮结论与复用范围 |
| --- | --- |
| [Infinite Canvas `video.ts`](https://github.com/basketikun/infinite-canvas/blob/9cd3deacbcc598361807afc16c059a80dd18b6f9/web/src/services/api/video.ts) | 已重新读取固定提交；主要是 OpenAI multipart、Gemini 长操作和脚本插件，不包含本任务所需的官方厂商全套适配。可以参考协议细节，不能用它的浏览器轮询替换 BeefTV 后端持久任务 |
| [LiteLLM Runway 映射](https://github.com/BerriAI/litellm/blob/dddbaa803d6e9fcc862ea7a5412f771cb1ae040e/litellm/llms/runwayml/videos/transformation.py) | 已重新读取；有 promptText/promptImage/ratio、版本头、模式路由、output 处理，适合 #28 与后续完整链路。转为现有 manifest/Go 样例，不引入 Python |
| LiteLLM 同提交的 `volcengine/videos`、`minimax/videos`、`dashscope/videos`、`gemini/videos`、`vertex_ai/videos` 及对应单测 | #24 已定位这些文件；实施时只读相关文件并再次对照现行官方合同。复用适用的非 enterprise MIT 部分并保留许可声明，不能把旧模型限制直接变成产品规则 |
| new-api 的 `plugins/tasks` 与即梦签名参考 | 按 #26 已定范围仅参考字段、状态与文档，不复制 AGPL 代码进本项目。现有签名宿主已经能用，不再复制一套 |
| one-api | #24 未找到匹配的视频适配，不因为“支持很多渠道”就列作已可照搬方案 |

## 11. 验收矩阵与本轮证据限度

### 11.1 后续实现必须留下的证据

| 验收项 | 证据层次 / 检查位置 | 当前状态 |
| --- | --- | --- |
| 86 个目录全部有去向，31 个视频 provider 不混淆包 ID | 源码清单和本文第 5、6 节；按 manifest 统计 | 已静态核对；不证明发行可用 |
| 凭证与目录失败路径 | 组件/本地界面：方舟、Agent Plan、即梦；使用占位凭证，不连接厂商 | 等 #27 最终代码；本轮没有界面运行验证 |
| 没有 BeefAPI 也可完成自己的连接 | 本地模拟环境：BeefAPI 未连接；从配置选择到任务请求；断言没有调用 BeefAPI 上游 | 本轮未执行 |
| 每条协议正确映射 | 直接加载实际 manifest 和构建归档；成功、处理中、业务失败、未知状态、空结果样例 | #24 有部分反例；不等于修复通过 |
| 下载与保存是真完成 | 本地 HTTP mock：轮询、带凭证/临时地址下载、保存资源、画布绑定、下载中断恢复 | 复用 `video_unified_delivery_test.go` 等既有测试补缺；本轮未运行 |
| 请求未知或取消不重复收费 | mock 统计 create 次数；超时、重启、取消后按原任务继续查询，不换协议/渠道 | 后续必验；不能只测普通成功响应 |
| 五种中转不误合并 | 各格式分别锁定 Content-Type、字段、素材角色、查询和结果；HTTP 415 不换格式重发 | 已静态核对差异；后续回归必验 |
| 配置迁移不丢数据 | 临时数据目录：旧 ID、providerOptions、自定义 headers、已保存凭证引用、用户禁用包、用户安装包、失败恢复、重复升级、降级回退 | 后续必验；不使用用户数据做实验 |
| 源码、发行包、客户端一致 | 构建清单与 hash；从归档加载同一套样例；干净安装逐条比对 catalog 和协议选择器 | 本工作树 `.beeftv-plugin` 数量为 0；未构建，不推断发行包缺失 |
| 可声称真实官方支持 | 经用户另行授权，指定厂商/模型/模式/次数/费用，真实生成、保存、播放；保留脱敏回执 | 未执行；本任务禁止付费调用 |

现有“所有视频 provider 走统一下载”测试验证的是下载消费层，测试注释明确厂商轮询解析另测。不能拿这类 roster 测试通过来证明 31 家请求协议正确。旧的内置 adapter 测试也不能代替实际发布 manifest 测试。

### 11.2 本方案的完成状态

本轮已完成源码阅读、86 个插件目录统计、五种中转结构对照、输入报告和关联任务阅读、关键在线资料核查，以及方案文件的静态检查。没有执行生成测试、构建发行包、修改本机 BeefTV、浏览真实用户配置或开展真实厂商验收。

本文作为后续实现的建议依据；若用户确认成为实施合同，再更新同一文件和验收记忆，不另复制一份“已确认版本”。当前 `acceptance_contract_status` 为 `proposed`，不是用户批准的新增功能清单。厂商服务状态在实施与发布前再次核对；一周后的复查提示不表示现有用户配置自动失效。

## 12. 来源导航

### 仓库证据

- [连接预设与协议默认值](../../web/src/lib/model-service-presets.ts)、[连接表单](../../web/src/pages/settings/model-service-editor.tsx)、[协议目录及兜底](../../web/src/services/api/plugin-catalog.ts)。
- [模型配置保存](../../web/src/services/model-config-repository.ts)、[本地配置实现](../../backend/internal/workspace/provider_config.go)、[生成任务入口](../../web/src/services/api/generation-task.ts)。
- [声明式协议执行](../../backend/internal/generation/protocol.go)、[启动插件清理](../../backend/internal/plugins/bootstrap.go)、[清理与升级测试](../../backend/internal/plugins/runtime_test.go)。
- [协议生成器](../../plugin-packages/generate-catalog.mjs)、[插件打包](../../plugin-packages/build-packages.sh)、[桌面构建复制](../../scripts/build-beeftv-release.sh)、[官方插件测试](../../backend/internal/protocol/official_catalog_test.go)、[统一下载测试](../../backend/internal/generation/video_unified_delivery_test.go)。
- [#24 固定提交报告](https://github.com/glanderness/BeefTV/blob/6263990c60b842b8f751a462b057bb83bea64942/docs/research/video-byok-audit.md)、[既有外接视频协议调查](../refactor/external-video-protocols.md)。

### 官方资料

- [OpenAI 服务弃用](https://developers.openai.com/api/docs/deprecations)、[Gemini 视频及 preview 关停](https://ai.google.dev/gemini-api/docs/video?hl=zh-cn)。
- [Runway API](https://docs.dev.runwayml.com/api/)、[xAI 视频](https://docs.x.ai/developers/model-capabilities/video/generation)、[万相文生视频](https://help.aliyun.com/zh/model-studio/text-to-video-api-reference)、[fal 队列生命周期](https://fal.ai/docs/documentation/model-apis/inference/queue)。本轮已读；Wan 当前页特别标明新版协议和地域主机，不能只更改字段名。
- [方舟视频任务](https://www.volcengine.com/docs/82379/1520757)、[Agent Plan 视觉接入](https://docs.volcengine.com/docs/ark/agent-plan-personal-visual-models?lang=zh)、[即梦 3.0 接口](https://docs.volcengine.com/docs/JimengAI/JimengAI-VideoGeneration30720P-Text-to-Video-InterfaceDocumentation?lang=zh)。本轮采用 #24 的已读证据，不冒充重复验证。
- 可灵、Vidu、PixVerse、混元、海螺、Luma 的官方链接和逐字段缺口见 #24 第 5、6、10 节；其是否已经修复以各实施任务的最终提交和验收为准。

建议依据：用户要求本体轻量、不依赖 BeefAPI、尽量复用上游与现有控件；排序与删除条件是本次架构判断。本文不包含真实密钥、付费授权或发布授权。
