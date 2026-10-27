# 视频模型 BYOK 接入调查

调查时间：2026-10-26 至 2026-10-27（北京时间）。本报告只调查，不实施修补。

## 一、结论与建议

1. **不是“没写方舟、Agent Plan、即梦这三条协议”，而是“已有协议不等于官方链路已经可用”。** 方舟原生、Agent Plan 的基础请求和视频响应较完整；即梦官方视频存在可以离线复现的成功码误判、请求字段不匹配。
2. **客户的唯一根因仍未确定。** 截图没有客户端版本、选中协议、Key 类型、请求和错误。当前能确定代码缺陷及入口障碍，不能说这些就是客户那一次失败的直接原因。
3. **应先修已有适配，不宜再批量增加“通用模板 + 厂商名字”。** 可灵、Vidu、PixVerse、混元、Runway、Luma 等插件存在明显的官方字段或生命周期差异。Runway、Luma、Grok 的官方成功响应，经现有源码插件解析后，均复现“成功状态、零个视频地址”。
4. **优先复用现有宿主和 LiteLLM 的非 enterprise 映射/测试。** Infinite Canvas 已先检查，没有比 BeefTV 更完整的这些官方视频适配；new-api 有很有价值的即梦、可灵等实现，但它是 AGPL-3.0，不能当 MIT 代码直接搬入。
5. **必须更新服务生命周期认知。** OpenAI 官方文档说明 Sora 2 和 Videos API 已于 **2026-09-24** 关闭；Gemini API 的 Veo 3.1 预览模型已于 **2026-10-22** 关闭。兼容中转仍可提供同名接口，但不等于官方 API 仍在服务。[O10][O11]

建议顺序：**即梦确定性错误与误导性默认值 → 方舟两种凭证/目录/入口 → 逐厂商完成创建、查询、结果映射 → 参考素材与高级参数 → 经用户另行授权的真实验收**。不另建任务引擎，不用真实付费探测推断协议，不增加一堆开关。

## 二、调查范围、证据与边界

- 工作树基线：`867339625e0b12f179300366178a28c4d09c0cfbf`。
- 补查远端项目只读克隆的 main 快照：`1bf517b93da7f5cddef9f4dc93d0a55d12c6176b`，提交时间 `2026-10-26T23:57:51+08:00`。对比本报告涉及的协议、生成、模型目录、插件目录及三个主要设置文件，已有文件内容无差异；不声称覆盖此后并行提交。
- 真实客户端：本机 **BeefTV v2.0.3**。不能假定运行二进制和上述源码完全一致，也未做全新安装默认插件验收。
- 客户端只经 cua-driver 查看；网页经 ego-browser 阅读。未填写密钥，未点击生成、发送、读取模型或生成测试，未发起供应商生成请求。没有安装依赖、构建插件、升级浏览器或修改业务代码。
- 测试通过 Go overlay 在临时目录注入，直接加载仓库 `manifest.json`，无供应商网络请求。**没有做本地 HTTP mock 全链路，也没有真实供应商验收**。

下文证据分为四层，不能互相代替：

| 层次 | 本次能证明什么 | 不能证明什么 |
| --- | --- | --- |
| 源码 | 协议和模板存在、字段怎么映射 | 客户安装了它、上游接受请求 |
| 客户端观察 | 此运行版本的入口、提示、未保存表单 | 干净安装默认状态、付费生成成功 |
| 离线固定样例 | 指定 manifest 的请求/响应行为 | 鉴权、云权限、素材下载与完整生命周期 |
| 供应商验收 | 本次未进行 | 不应出现“已打通/全部通过”的结论 |

## 三、真实客户端里会卡在哪里

### 3.1 实际看到的入口

“连接你的模型服务”只有四种预设：**第三方模型服务、OpenAI、Google Gemini、火山方舟**。方舟预填 `https://ark.cn-beijing.volces.com/api/v3`。Agent Plan、即梦视频以及其他视频厂商没有独立服务预设。

查看路线为：添加模型服务 → 火山方舟 → 不填 Key、手动添加一个视频模型草稿 → 高级模型设置与测试 → 配置使用 → 编辑模型使用配置。调用协议藏在模型级配置，而不是连接服务时的主要选择。

重要修正：**不能写成“没有地方填 SK”。** 源码 `web/src/pages/settings/model-service-editor.tsx:193–198` 已有高级设置内的 `Secret Key（按需填写）`，`apiKey` 也能承载 AK/SecretId。问题是主表单仍统一叫 API Key，未按所选签名协议明确解释 AK、SK、region、service；本轮只在主连接页直接看到 API Key，并未独立完成该运行版本高级凭证区域的复核。

草稿只用于观察，未点“保存并使用”。后续关闭和切换时，AX 返回与可见内容没有可靠同步，**未取得已退出草稿的明确证据**，因此不写“已清理所有客户端配置”。源码显示该流程是服务草稿，模型配置到最终保存前只回写草稿；也未通过本地数据读回验证持久化状态。停留页面及显示异常不直接归因于产品缺陷或客户原问题。

### 3.2 分层判断

| 可能卡点 | 本次结论 | 证据位置 |
| --- | --- | --- |
| 根本没有三种协议 | 不成立；三者都有独立 provider ID | `backend/internal/protocol/builtin.go`；对应插件 manifest |
| 默认没有安装/启用 | 不能据源码或本机安装状态下结论；需要干净发行包核查 | `backend/internal/plugins/bootstrap.go`、`runtime.go` |
| 协议一定能在所有客户端直接选 | 未完成逐项客户端复核；列表依赖运行时可用协议和作用域 | `web/src/components/model-protocol-picker.tsx`、`model-protocol-browser.tsx` |
| 方舟普通 Key 当 Agent Plan Key | 真实风险；协议路径及凭证必须成对 | [O1][O2] |
| 即梦 AK/SK 当 Bearer Key | 主表单容易误导；签名能力已存在，但必须选中正确协议并填 SK | 即梦 manifest；`generation/protocol.go:733` |
| 模型列表拉不到 | 不等于不能生成；当前目录主要按 OpenAI/Gemini schema 读取 | `modelcatalog/catalog_fetch.go`；`model-service-presets.ts` |
| 提交前能力校验拦截 | 有可能；能力配置按模型/协议决定，本轮无真实任务可归因 | `modelcatalog/capability.go`；`ProtocolRequest` |
| 已到官方请求但字段错误 | 即梦已离线复现；其他厂商见矩阵 | 第四至六节 |

`types.go:260` 的 manifest 默认启用为 true，不代表安装包一定包含它；bootstrap 也会保留用户之前的启用状态。**“源码存在”“默认启用”“发行包带有”“客户端可选”应分别验收。**

## 四、火山三条链路逐字段核查

### 4.1 先分清接口和凭证

| 链路 | 官方主机/路径 | 官方鉴权 | BeefTV 现状与边界 |
| --- | --- | --- | --- |
| 方舟原生视频 | `ark.cn-beijing.volces.com/api/v3/contents/generations/tasks` | 方舟 API Key，Bearer | `volcengine-ark-video`；创建/GET 查询/DELETE 取消已存在 |
| Agent Plan 视频 | 同主机，`/api/plan/v3/contents/generations/tasks` | **Agent Plan 专属 API Key**；不可混用普通方舟或 Coding Plan Key | `volcengine-ark-agent-plan-video`；三种操作都有 plan 路径 |
| 即梦开放平台视频 | `visual.volcengineapi.com/`，Action/Version query | AK/SK，Volcengine V4；service=`cv`，region=`cn-north-1` | `volcengine-jimeng-video`；签名已有，业务映射不完整 |

来源：[O1][O2][O3]。Agent Plan 文档还明确提示，混用接口可能调用失败或产生额外费用。因此不能只改 Base URL 后保留错误协议，也不能把目录操作使用的 AK/SK 与推理 Key 混为一谈。

URL 拼接不是本轮已证实的方舟错误：`generation/url.go` 能识别 `/api/v3`、`/api/plan/v3` 等版本前缀；选择 plan 协议时不应简单推断会拼出 `/api/v3/api/plan/v3`。本地 URL 归一化测试通过。

### 4.2 方舟原生与 Agent Plan 的实际字段

对应源码：`plugin-packages/volcengine-ark-seedance/manifest.json`、`volcengine-ark-agent-plan-seedance/manifest.json`。两者 providerOptions 命名空间分别是 **`volcengine-ark-video`**、**`volcengine-ark-agent-plan-video`**，不是插件目录名。[O1][O2]

| 官方字段/结果 | 当前映射 | 判断 |
| --- | --- | --- |
| `model` | `request.model` | 有；必须是实际模型/endpoint ID，手输一个看起来合理的名称不能证明上游存在 |
| `content[].type="text"`、`text` | 来自 prompt | 有 |
| `image_url/video_url/audio_url`，以及 `role` | 显式 role，按 order 排序；URL/data URL/asset 输入由已有素材流程处理 | 有基础映射；没有真实素材验收 |
| `ratio`、`resolution` | 来自统一请求；无值有默认 | 有 |
| `duration` | 正整数和 `-1`；无值默认 5 | 有；是否允许 `-1` 还受模型能力限制 |
| `frames` | 无模板字段 | 缺；不能自动与 duration 同时乱传 |
| `generate_audio`、`watermark` | 统一布尔值 | 有 |
| `seed`、`camera_fixed` | 从各自 provider 命名空间读取 | 有声明；零值/false 的省略语义仍应补样例 |
| `omni_reference_task_type` | 无模板字段；operation 也未映射成该字段 | 缺；不能声称编辑/延长模式已经完整 |
| `output_format`、`return_last_frame` | 无模板字段 | 缺；结果只取视频，未形成尾帧产物合同 |
| `draft`、`service_tier`、`callback_url`、`execution_expires_after`、`priority`、`safety_identifier`、`tools` | 无模板字段 | 缺；不等于全部应该增加 UI 控件，先按模型/业务选必要子集 |
| 创建 `id`，查询 `status/content.video_url/usage` | 有对应响应映射，视频 URL 标临时 | 基础成功样例解析正常 |
| `error.code/message` | 业务错误映射 | 有基础处理，未覆盖全部云端错误样例 |

**扩展透传不是万能兜底。** 这两个模板没有 `$merge` `body/extra_body`；虽然内嵌说明出现“完整对象不会裁剪”的泛化文案，执行模板并不读取这些对象。离线测试以正确命名空间传入 seed=17，同时传入上述三个高级字段和 body/extra_body：seed 能出现在请求中，高级字段仍全部消失。因此不能建议用户“放进 extra_body 就好”。

模型能力也不能只按 Seedance 品牌推断。当前 HEAD 对不同命名、2.0/2.5 有专门分支；运行客户端手工草稿展示的时长下限为 1 秒，而当前后端默认逻辑对已识别 Seedance 家族会提升到 4 秒。**这是运行版本/命名识别/持久化能力合同的待核差异，不应直接覆盖用户配置。**

### 4.3 模型目录为什么可能失败

当前连接页目录 URL 主要生成 OpenAI `/models` 或 Gemini `/models`，解析器期待 `data[]` 或 `models[]`。协议目录和视频生成协议不是一回事。

Agent Plan 官方另有管控 API：`POST https://ark.cn-beijing.volcengineapi.com/?Action=ListArkAgentPlanModel&Version=2024-01-01`，使用 **AK/SK**，模型位于 `Result.Datas[].ModelID`。这不是把 Agent Plan 推理 Key 填进 `/models` 即可获得的目录。[O4]

建议在现有连接流程中明确“目录读取失败仍可手填模型”，并使用官方支持模型清单或另行适配目录；不要为一个 Bearer 推理连接强迫用户额外准备管控 AK/SK。Agent Plan 视觉页本身列出了 `doubao-seedance-2.5/2.0/2.0-fast/2.0-mini`，但账号实际权限与可用性仍需确认。[O2]

### 4.4 即梦：已有签名，仍有三处确定性问题

核查的是官方 **即梦视频生成 3.0 720P 文生视频**文档；页面已标“下线中”。它不是方舟 Seedance 新模型的同义入口，也不能承诺该旧接口还能为所有账号开通。[O3]

| 项目 | 官方文档 | 当前源码插件 | 结论 |
| --- | --- | --- | --- |
| submit | `Action=CVSync2AsyncSubmitTask`，`Version=2022-08-31` | 相符；根路径请求启用 `originPath` | 入口基本有 |
| poll | `Action=CVSync2AsyncGetResult`，同 Version | 相符 | 入口基本有 |
| 凭证/区域 | AK/SK，`cv`，`cn-north-1` | 对应签名驱动和固定区域已声明 | 不是缺签名算法；UI 字段提示仍需清晰 |
| `req_key` | 示例 `jimeng_t2v_v30` | `request.model` | 可映射，但模型目录与 req_key 不是同一概念 |
| 时长 | `frames=121/241`，对应 5/10 秒，公式 24*n+1 | 发 `duration=10`，没有 frames | **不匹配** |
| 比例 | `aspect_ratio` | 发 `ratio` | **不匹配** |
| 分辨率 | 该 req_key 对应 720P，不是任意 resolution 档位 | 仍发通用 `resolution` | 与所选官方 API 合同不一致 |
| 图片 | 其他即梦图生视频 req_key 需各自的 `image_urls/binary_data_base64` 等 | 当前统一 images 模板不能代表所有图生接口 | 不能标完整覆盖 |
| `req_json` | 该文档查询请求中的配置字符串 | 接到创建 body；poll 只有 req_key/task_id | **查询侧未传**；不要宣称它普遍属于 submit 字段 |
| 成功业务码 | `code=10000` | 列入 errorPaths；`manifestError` 只有数字 0 等视作成功 | **已复现成功被判失败** |
| 完成结果 | `data.status=done/data.video_url` | 能取到 URL，但 code 先造成失败状态 | `status=failed videos=1` |

根因位置：`backend/internal/protocol/manifest.go:1387`。应为该协议明确声明成功码或做局部正规化，而不是让所有厂商非零码一律通过。

`backend/internal/generation/jimeng.go`、历史手写驱动，以及 `provider_jimeng_test.go` 中的即梦图片测试，**不能替代当前视频插件验收**。实际视频调度优先走注册的声明式协议，必须测试运行时加载的那个 manifest。

## 五、国内视频模型：可选性、参数与素材盘点

这是按需求整理的接入清单，**不是市场份额排名**。表中“无专用预设”表示不能在第一屏直接选该厂商的专用连接；不表示源码没有协议。除方舟入口外，本机没有逐个保存各厂商连接验证；发行包默认安装/启用仍待干净安装确认。所有厂商本轮真实验收均为“未做”。

| 厂商/链路 | 官方接口与 BeefTV 是否对上 | 默认选择 | 参数、参考素材与结果缺口 | 本地证据 |
| --- | --- | --- | --- | --- |
| Seedance / 方舟原生 | 专用 `/api/v3/contents/generations/tasks` 基础相符 | 有火山方舟服务预设；模型级协议 | 文、图、首尾帧、参考视频/音频已有显式 role；高级字段见第四节 | 两种 Ark 成功视频响应离线正常；源码有角色与约束测试 |
| Seedance / Agent Plan | 专用 `/api/plan/v3/...` 基础相符；Key 独立 | 无独立预设，须明确选 plan 协议 | 与原生共享基础内容；目录、凭证提示、扩展字段有缺口 | plan 路径及响应离线检查；现有安装包测试缺产物 |
| 即梦官方 | V4 签名及 Action 存在，业务合同不完整 | 无独立预设；SK 在高级设置，不应叫普通 Bearer Key | frames/比例/req_json/10000 错误；旧 3.0 接口下线风险；不能代表全部 Seedance | 两个成功响应被判失败；创建和查询 body 已离线复现 |
| 可灵 | `kling-video` 发 `/v1/videos/generations`；当前官方 3.0 文档为区域主机 `/text-to-video/kling-3.0`，查询 `/tasks`，legacy 又是另一套 | 无专用预设；本机逐项选择未验 | 官方 `settings/options`、`data.outputs[]` 未映射；现模板平铺 model/images/videos/audios 不能覆盖图生、Omni、元素、音色、运镜；凭证须按所选新旧 API 核实，不能一概说只缺 JWT | 静态模板与 [O5] 对照；未加本轮可灵执行样例 |
| 海螺 / MiniMax | `minimax-video` 已走 H3 的 `/v2/video_generation` 与 `/v2/query/video_generation/{id}`，不是旧 Hailuo V1 | 无专用预设；须模型级协议 | 多模态 content、首尾帧和参考角色已有；H3 各变体分辨率不同，当前通用能力默认 `768P/2K` 不能适用于所有变体；仅 URL 成功不等于完整能力验收 | H3 成功样例能解析 task.content.url；角色测试依赖包未运行 [O6] |
| Vidu | 官方 `/ent/v2/text2video`、`/ent/v2/tasks/{id}/creations`，鉴权 `Authorization: Token ...`；插件为 `/v1/videos`、`/v1/tasks/{id}`、Bearer | 无专用预设 | 路径/鉴权均需修；`creations[].url` 未映射；文生、图生、参考生分别路由，不能只改 model | 静态与官方 Q1 文档对照；不声称覆盖最新所有 Vidu 模型 [O7] |
| 万相 / 百炼 | 路径、Bearer、`X-DashScope-Async: enable`、output.task_id/task_status 基础已有 | 无专用预设；须选 `dashscope-wan-video` | 现模板把 request.resolution 放 `parameters.size`，未映射比例；**当前 2.7 文生文档使用 parameters.resolution + ratio**。旧版本 size 也可能是像素尺寸，不能把 720p 直接当 size；参考、首尾帧、音频已有独立字段但路由/模型支持需逐模式核对 | 源码有互斥参考字段测试，缺包未执行；与当前 2.7 官方对照 [O8] |
| 混元 / 腾讯云 | 已有 TC3，但插件默认 `hunyuan.tencentcloudapi.com/service=hunyuan`，通用小写 body，查询 GET；官方所核混元接口是 `vclm.tencentcloudapi.com`、POST Submit/DescribeHunyuanToVideoJob、Version=2024-05-23 | 无专用预设；SecretId/SecretKey 需明确 | 缺 `Prompt/Image/Resolution/LogoAdd`、`Response.JobId/Status/ResultVideoUrl`；查询缺 JobId 和独立 Action；不能把腾讯托管 Kling 的 SubmitTextToVideoJob 误当混元 | 静态对照官方 Submit/Describe；签名存在不是业务已通 [O9] |
| PixVerse | 创建路径已有，但官方要求 `API-KEY`、每请求 `Ai-trace-id`；插件是 Bearer | 无专用预设 | 官方 `quality`，插件通用 resolution；`Resp.video_id`、`ErrCode/ErrMsg`、结果状态没有专用映射；图生要上传/素材 ID，首尾帧、Fusion、扩展各有接口 | 静态与当前官方 v6-max 文生样例对照；未做供应商/本地 HTTP mock [O12] |

### 国内素材覆盖的共同边界

- 方舟/H3 的多模态 content 与通用平铺 `images/videos/audios` 是不同的线协议；“参数表声明支持三种媒体”不代表请求真的满足官方格式。
- 首帧、尾帧、人物参考、风格参考、参考视频、参考音频应保留显式角色，不能按图片数量猜模式。
- 公开视频 URL、data URL、本地上传、素材 ID 的支持必须逐厂商核对。内网 URL 或客户端本地文件不等于供应商可拉取的公网 URL。
- 当前能力默认值部分跨厂商通用，不能用它们替代每个模型的分辨率、时长、提示词、文件大小、互斥输入和合计时长规则。

## 六、海外视频模型

| 厂商 | 官方 API/源码现状 | 默认选择 | 参数、素材和结果缺口 | 本地证据 |
| --- | --- | --- | --- | --- |
| Runway | `runway-video` 有 `/v1/image_to_video` 和 `/v1/tasks/{id}`；官方还区分 text_to_video/video_to_video | 无专用预设 | 缺 `X-Runway-Version`；现发 prompt/images/aspect_ratio，官方用 promptText/promptImage/ratio；首尾帧和模型相关像素比例需专门映射；`output[]` 未取到 | 官方成功样例解析 `status=succeeded videos=0` [O13] |
| Luma Dream Machine | 插件创建 `/dream-machine/v1/generations`；当前所核参考页示 `/generations/video`，旧路径是否继续兼容未实测 | 无专用预设 | keyframes/帧角色未映射；duration 官方为如 `5s` 字符串而非统一整数；`assets.video` 未取到。旧文档引导至 Luma Agents API，后者本轮未完整展开，不能宣称覆盖最新平台 | 成功样例 `state=completed` 解析成成功但视频数 0 [O14] |
| Veo / Gemini API | `gemini-veo` 有 predictLongRunning/operation 映射，但 **Veo 3.1 preview 已于 2026-10-22 关闭** | Gemini 预设仍写“Veo 视频”，存在过时引导 | 当前插件只明确取首帧，未完整表达尾帧、参考图、续接视频；不能把过往 fixture 通过解释为当前官方可用。官方建议迁移 Gemini Omni Flash 或正式版模型，不能仅替换模型名套旧协议 | 旧格式内置解析测试通过；不是服务可用性验收 [O10] |
| Veo / Vertex 相关 | `vertex-veo` 的路径有 project/location，但 body 仍是通用模板，查询 GET `/v1/{taskId}` | 无独立预设；project/location 无现成通用连接语义 | 官方类接口需 instances/parameters、长操作及 fetchPredictOperation；云 OAuth、区域、存储/产物处理与 Gemini API Key 不同。当前正式平台具体模型/区域要再验，不以 Gemini preview 关闭推导全线关闭 | 静态审查；LiteLLM 有对应实现，可参考而非证明本地已通 |
| Sora / OpenAI | 共享 OpenAI `/videos` 类插件及下载合同存在，但 **官方 Sora 2 / Videos API 已于 2026-09-24 关闭** | OpenAI 预设仍写“视频”，会导向 shared newapi 协议 | 只能将仍提供该合同的第三方中转作为另一种服务；不能承诺普通 OpenAI Key 直接生成。历史模型/input_reference/seconds/size 规则不再代表当前可调用能力 | 现有声明式结果下载测试需插件产物；本轮未生成 [O11] |
| Grok / xAI | `xai-video` 创建/查询 URL 基础相符，但官方创建返回 `request_id`；模板 taskId 候选没有它 | 无专用预设；须选 xai-video | 创建回执、`video.url` 均缺映射；首帧 image/reference_images 有区分，但视频编辑、续接、语音参考及最新模型差异不能由现模板宣称覆盖 | 官方成功结果样例 `status=done`，解析成功但视频数 0 [O15] |

补充：仓库还包含 fal queue、Replicate、Pika via fal、Novita、百度、智谱等视频插件。它们应标明**直连还是托管转售**；本轮不逐家宣称官方验收完成。模型品牌相同，不代表 fal、Replicate、原厂与 OpenAI 兼容中转可互换请求。

## 七、本地测试实际结果

工具版本：Go `go1.26.3 darwin/arm64`，Bun `1.4.2`。未因测试失败执行安装/构建去污染工作树。

### 7.1 直接加载源码 manifest 的离线观察

临时文件位于 `/tmp/beeftv-video-byok-20261026/`：`audit_overlay_test.go`、`overlay.json`、`offline-test.log`。测试调用 `LoadInstalledPlugin(manifestBytes, nil)`，因此测的是**声明式源码模板**，不是内置历史 adapter，也不是安装包是否正确交付。

| 输入样例 | 实际输出 | 含义 |
| --- | --- | --- |
| 即梦 `code:10000` 创建回执 | failed，0 视频 | 复现成功码误判 |
| 即梦 `code:10000/data.status:done/data.video_url` | failed，1 视频 | URL 存在仍失败 |
| 方舟原生/Agent Plan succeeded + content.video_url | succeeded，1 视频 | 基础结果映射正常 |
| H3 task.status + task.content.url | succeeded，1 视频 | 指定 V2 样例正常 |
| Runway SUCCEEDED + output[] | succeeded，0 视频 | 缺结果路径 |
| Luma completed + assets.video | succeeded，0 视频 | 缺结果路径 |
| xAI done + video.url | succeeded，0 视频 | 缺结果路径 |

请求观察：即梦 10 秒发出 `duration:10/ratio:9:16/resolution:720p`，没有 `frames/aspect_ratio`；req_json 只在创建。方舟两个命名空间下 seed=17 能发出，`omni_reference_task_type/output_format/return_last_frame` 和 body/extra_body 不能发出。

**这里的测试 PASS 表示“成功复现记录中的现状”，不是“适配验收通过”。** 将这些观察测试变成修复回归测试时，必须改成期望正确成功码、正确字段和非空结果。

### 7.2 已有测试

| 命令/范围 | 结果 | 解读 |
| --- | --- | --- |
| `go test ./internal/protocol -run '^Test(DeclarativeManifestMapsFieldsAndResponses\|DeclarativeManifestSupportsMediaPathsTransformsAndErrors\|DeclarativeManifestKeepsLegacyVideoResolutionTransformCompatible\|ArkVideoAdapterMapsFullModalReferences\|GeminiVeoParsesLongRunningOperation)$' -v -count=1` | 5 项通过 | 通用解释器与部分内置映射；不是发行插件全覆盖 |
| `go test ./internal/generation -run '^TestChannelAPIURL' -v -count=1` | 通过 | URL 版本前缀归一化，不是供应商联调 |
| `go test ./internal/protocol -run 'Test(OfficialArkAgentPlanPluginsUsePlanPaths\|OfficialVideoProfilesPreserveExplicitMediaRoles\|OfficialWanProfilesUseMutuallyExclusiveReferenceFields\|Manifest\|Seedance)' -count=1` | 失败 | 缺少 `plugin-packages/*.beeftv-plugin`；未执行到对应映射断言，不能计为业务回归或测试通过 |
| `bun test test/model-service-presets.test.ts test/channel-model-catalog.test.ts` | 0 pass，2 fail / 2 errors | 缺少 localforage 依赖，属于测试前置环境缺失；未补装 |

现有 `official_catalog_test.go` 有部分角色、路径、结果下载测试；未发现能替代逐厂商官方 fixture 的完整覆盖。`generation/protocol.go:947` 起的结果收尾在无媒体时会报“声明式协议已完成但没有返回媒体地址”，所以“上游成功、前端失败”并不一定是视频生成失败。

### 7.3 可复制的最小复现（无付费）

以下代码是本轮自写的精简复现，不是复制上游实现。将其放在**仓库外临时文件**，通过 Go overlay 映射到 `backend/internal/protocol/audit_repro_test.go`。示例地址保留 `example.invalid`，只解析字符串，不下载。

```go
package protocol

import (
    "context"
    "os"
    "testing"
)

func TestAuditRepro(t *testing.T) {
    cases := []struct{ plugin, body string; status Status; videos int }{
        {"volcengine-jimeng-video", `{"code":10000,"data":{"status":"done","video_url":"https://example.invalid/a.mp4"}}`, StatusFailed, 1},
        {"runway-video", `{"id":"audit","status":"SUCCEEDED","output":["https://example.invalid/a.mp4"]}`, StatusSucceeded, 0},
        {"luma-dream-machine", `{"id":"audit","state":"completed","assets":{"video":"https://example.invalid/a.mp4"}}`, StatusSucceeded, 0},
        {"xai-video", `{"status":"done","video":{"url":"https://example.invalid/a.mp4"}}`, StatusSucceeded, 0},
    }
    for _, c := range cases {
        t.Run(c.plugin, func(t *testing.T) {
            b, err := os.ReadFile("../../../plugin-packages/" + c.plugin + "/manifest.json")
            if err != nil { t.Fatal(err) }
            adapter, err := LoadInstalledPlugin(b, nil)
            if err != nil { t.Fatal(err) }
            got, err := adapter.ParsePoll(context.Background(), PollContext{TaskID:"audit"}, []byte(c.body))
            if err != nil { t.Fatal(err) }
            n := 0
            if got.Result != nil { n = len(got.Result.Videos) }
            t.Logf("status=%s videos=%d", got.Status, n)
            if got.Status != c.status || n != c.videos { t.Fatalf("observation changed: %+v", got) }
        })
    }
}
```

overlay 文件格式：`{"Replace":{"<仓库绝对路径>/backend/internal/protocol/audit_repro_test.go":"<临时文件绝对路径>"}}`。从 backend 执行 `go test -overlay <overlay文件绝对路径> ./internal/protocol -run '^TestAuditRepro$' -v -count=1`。不需要构建 `.beeftv-plugin`，也不验证 HTTP 鉴权或下载。

## 八、开源复用：先 Infinite Canvas，再按许可证选择

### 8.1 Infinite Canvas：已优先看，但没有现成官方全家桶

仓库：[basketikun/infinite-canvas](https://github.com/basketikun/infinite-canvas)，核查提交 `9cd3deacbcc598361807afc16c059a80dd18b6f9`，MIT。

- [`web/src/services/api/video.ts`](https://github.com/basketikun/infinite-canvas/blob/9cd3deacbcc598361807afc16c059a80dd18b6f9/web/src/services/api/video.ts)：主要是 OpenAI 兼容 multipart `/videos`、Gemini 旧长操作、脚本插件。可参考生命周期、取消、Blob 结果及内容下载；**没有即梦官方 V4、方舟原生、可灵、Vidu 等完整专用映射可直接拿来填空**。
- [`web/src/stores/use-config-store.ts`](https://github.com/basketikun/infinite-canvas/blob/9cd3deacbcc598361807afc16c059a80dd18b6f9/web/src/stores/use-config-store.ts)：可比较模型配置和 URL 归一化，但 BeefTV 已有更深的后端协议层，不宜倒退成每个前端调用者自己轮询。
- 上游的凭证处理、下载失败退回 URL 等逻辑也不是自动适合当前宿主的安全边界。只复用必要映射/测试，不整段覆盖 BeefTV 的持久化、下载和任务恢复。

### 8.2 可复用文件清单

| 项目/许可证/固定提交 | 可参考或移植的文件 | 对 BeefTV 的具体价值与限制 |
| --- | --- | --- |
| [LiteLLM](https://github.com/BerriAI/litellm)，`dddbaa803d6e9fcc862ea7a5412f771cb1ae040e`；根 LICENSE 规定 enterprise 目录外 MIT | `litellm/llms/volcengine/videos/transformation.py`；`tests/unit/llms/volcengine/test_volcengine_video_transformation.py` | content/role、ratio/size、frames/duration、透传键、状态/错误、任务结果样例；Python 逻辑转为现有声明式模板与 Go 测试，不新增 Python 运行时。注意其拒绝视频输入的部分原因是计费策略，不是方舟不支持视频，不能照搬成 BeefTV 限制 |
| 同上 | `litellm/llms/minimax/videos/transformation.py` 与对应 `tests/unit/llms/minimax/videos/test_minimax_video_transformation.py` | H3 content、模型变体和查询结果；与当前官方 V2 对齐后移植，不混入旧 V1 |
| 同上 | `litellm/llms/runwayml/videos/transformation.py`；`tests/unit/llms/runwayml/videos/test_runway_video_transformation.py` | promptText/promptImage/ratio、版本头、任务结果 output；优先补当前确定性缺口 |
| 同上 | `litellm/llms/dashscope/videos/transformation.py` | input/parameters、异步头和 task_status；按 Wan 2.7 官方 resolution/ratio 再核对，不能原样沿用旧模型 size 规则 |
| 同上 | `litellm/llms/gemini/videos/transformation.py`、`litellm/llms/vertex_ai/videos/transformation.py` 及两个目录的单测 | instances/parameters、操作名、fetchPredictOperation、产物；只复用仍适用的正式接口结构，先排除已关闭 preview |
| [new-api](https://github.com/QuantumNous/new-api)，`34003e9c2eed2c20e617f583fdfe54bf1bf42237`，AGPL-3.0 | `plugins/tasks/jimeng/plugin.js`、`relay/channel/jimeng/sign.go`、`plugins/jimeng_responses_test.go` | req_key、aspect_ratio、121/241 帧、10000 成功码、submit/query 分离；签名宿主已有，无须复制一套。**代码移植需先确认与目标仓库/分发方式的许可证兼容性；本报告不作法律许可结论** |
| 同上 | `plugins/tasks/{kling,hailuo,vidu,alibaba,doubao,google,vertex-ai,xai,sora}/plugin.js` | 厂商状态/路径及响应样例；new-api 自己的网关路由不能当原厂路径，旧可灵插件不自动覆盖官方新 3.0 settings API；Sora 代码存在不代表官方服务仍在 |
| [one-api](https://github.com/songquanpeng/one-api)，`8df4a2670b98266bd287c698243fff327d9748cf`，MIT | 检查 tree、渠道目录及许可 | 本次未找到与需求相当的这组视频专用适配，不把“one-api 支持很多渠道”当可照搬证据 |

LiteLLM 的 [LICENSE](https://github.com/BerriAI/litellm/blob/dddbaa803d6e9fcc862ea7a5412f771cb1ae040e/LICENSE) 明确区分 enterprise；GitHub metadata 把它显示为 Other，不能仅凭 SPDX 自动判断整个仓库可复制。MIT 范围移植仍应保留适用版权和许可声明。

补查“其他创作工具”候选 `huobao-film/huobao-drama` 与 `Ceeon/Toonflow`：公开 GitHub metadata 查询均返回 404，**本次未核实实际仓库地址、代码与许可证，不列入可直接复制清单**。404 不能证明项目不存在，也可能是迁移、改名或权限问题；这里宁缺毋滥。

### 8.3 推荐的复用粒度

保留 BeefTV 的 `GenerationRequest → manifest → RequestSpec → 签名/安全传输 → 统一结果` 边界。复用“**官方字段映射 + 真实形状的固定样例 + 模型能力约束**”，不把 new-api 的路由、任务存储、计费、重试引擎整体再引入。

## 九、修补分块与优先级（建议，不是本次已批准实施范围）

| 优先级/工作块 | 建议范围 | 为什么排这里/证据 | 完成后仍不能宣称什么 |
| --- | --- | --- | --- |
| P0-A 即梦确定性错误 | 协议局部成功码；5/10秒到frames；aspect_ratio；查询侧req_json；按仍提供的 req_key 限定模式；删除误导文案 | 已有离线反例；直接解释“接口返回成功但产品失败”的一种情况 | 未经账号权限和真实素材测试不能称旧即梦仍可开通 |
| P0-B 入口与费用语义 | 在现有服务/模型配置里清晰区分普通方舟、Agent Plan、即梦签名；复用现有 Secret Key、协议选择和帮助文案；目录失败可手输 | 普通 Key/专属 Key/AKSK 及三种目录被混为一谈，存在费用风险 | 不能凭选择了协议就标“连接测试通过” |
| P0-C 过时默认与结果丢失 | 更新 Sora/Veo preview 提示；修 xAI request_id/video.url、Runway output[]、Luma assets.video；保留“生成已成功但结果未取到”的区分 | 当前官方生命周期公告与三组离线反例 | 无密钥/无付费情况下只能说合同测试通过 |
| P1-A 国内官方合同 | 可灵新旧路由、Vidu Token/路径/creations、PixVerse headers/ID/业务码、混元 vclm Action/Version/响应；Wan 按模型版映射 resolution/ratio 或 size | 通用模板不符合官方合同；先把一个明确版本的文生链路做实 | 不能把文生通了外推为图生/全模态全通 |
| P1-B 方舟/H3 素材与必要高级项 | 正确 operation、时长/帧数互斥；output_format/尾帧产物；按模型变体能力；本地文件/asset/data URL 等已有流程的贯通 | 当前 template/UI/能力合同未完全闭合 | 不需要把官方每个字段都做成新设置项 |
| P1-C 发布与自动化 | 从源码构建插件并验证发行包清单；同一套官方 fixture 跑到实际发布插件；创建/查询/取消/下载的本地 HTTP mock | 本次已有测试被缺产物挡住，且内置适配与插件不是同一层 | 不等于供应商线上验收 |
| P2 正式平台与扩展模型 | Vertex/正式 Veo 或官方替代平台、Luma Agents，其他托管视频；按真实需求与账号授权推进 | 比先加更多空壳插件更有价值 | 不能用旧文档和同名模型保证新 API 兼容 |

Basis：上述优先级为本次调查的工程判断；先处理已复现的正确性/费用误导问题，再补明确官方合同和交付证据。不是用户已经批准的功能要求。

后续每条适配至少分别记录：源码字段、发行插件可选、官方成功/失败/处理中样例、本地 mock 的 HTTP 方法/鉴权/查询/下载，以及**另获用户授权后**的小额真实验收。真实测试必须说明厂商、模型、输入、预计费用和次数；本报告不构成任何付费授权。

## 十、证据索引与未解决项

### 官方文档（均在调查窗口阅读；按具体版本理解）

- [O1] 方舟[创建视频生成任务](https://www.volcengine.com/docs/82379/1520757)，包含 Seedance 2.5 的 content、omni_reference_task_type、frames、output_format、尾帧及任务控制字段。
- [O2] Agent Plan [接入视觉模型](https://docs.volcengine.com/docs/ark/agent-plan-personal-visual-models?lang=zh)，专属 Key、plan URL 和支持模型。
- [O3] [即梦3.0 720P文生视频](https://docs.volcengine.com/docs/JimengAI/JimengAI-VideoGeneration30720P-Text-to-Video-InterfaceDocumentation?lang=zh)；[通用错误码](https://www.volcengine.com/docs/6444/69728)。页面标“下线中”。
- [O4] [查询 Agent Plan 支持的模型列表](https://www.volcengine.com/docs/ark/list-ark-agent-plan-model-api)：`ListArkAgentPlanModel`，仅 Access Key 鉴权，响应 `Result.Datas[].ModelID`；可按 Edition 区分套餐版本，与 [O2] 推理方式分开。
- [O5] [Kling 3.0 文生视频](https://kling.ai/document-api/api/video/3-0-omni/text-to-video)，当前新 API 与 legacy 入口分列。
- [O6] MiniMax H3 [创建](https://platform.minimax.io/docs/api-reference/video-generation-v2-create)、[查询](https://platform.minimax.io/docs/api-reference/video-generation-v2-query)。
- [O7] Vidu Q1 [文生视频及任务查询](https://platform.vidu.com/docs/api-reference/video-models/vidu-q1/text-to-video)。
- [O8] 百炼[万相2.7文生视频](https://help.aliyun.com/zh/model-studio/text-to-video-api-reference)，本轮页面更新时间 2026-10-10；地域、Key、Endpoint 必须对应。
- [O9] 腾讯云[提交混元任务](https://cloud.tencent.com/document/api/1616/126160)、[查询混元任务](https://cloud.tencent.com/document/api/1616/126162)、[API 概览](https://cloud.tencent.com/document/api/1616/107795)。
- [O10] Google [Gemini API 视频生成](https://ai.google.dev/gemini-api/docs/video?hl=zh-cn)，2026-10-22 的 Veo preview 关闭说明；不外推到所有正式平台模型。
- [O11] OpenAI [弃用公告](https://developers.openai.com/api/docs/deprecations)，2026-03-24 公告中的 Videos API/Sora 2，关闭日 2026-09-24；历史 guide 仍存在不代表服务可用。
- [O12] PixVerse [Text-to-Video](https://docs.platform.pixverse.ai/text-to-video-13016634e0)、[Quick Start](https://docs.platform.pixverse.ai/quick-start-2394985m0)。Ai-trace-id 是追踪 ID，不应当成幂等键。
- [O13] Runway [API Reference](https://docs.dev.runwayml.com/api/)，image/text/video 路由、版本头、字段及 task output。
- [O14] Luma [Dream Machine Create](https://docs.lumalabs.ai/reference/creategeneration)；页面引导的[新 Agents 文档](https://docs.agents.lumalabs.ai/)仅作后续调查入口。
- [O15] xAI [Video Generation](https://docs.x.ai/developers/model-capabilities/video/generation)，本轮核查 request_id、查询和 video.url。

### 仍需客户/后续验收补的事实

1. 客户的确切客户端版本、已启用协议、Key 类型、模型 ID、失败阶段与脱敏错误/RequestId。不要要求在聊天里提供 Key。
2. 客户说“即梦”具体指旧 visual 开放平台、方舟 Seedance、Agent Plan，还是第三方同名中转；这决定应该修哪份合同。
3. 干净安装 v2.0.3/后续发行版本的插件安装与默认选择；本机观察不能代替发行包证明。
4. 每种模式的真实素材、云权限、区域和产物下载；本轮没有此类验收，不以静态分析或离线 PASS 冒充。

原始临时缓存保留在 `/tmp/beeftv-video-byok-20261026/`，包含固定提交的上游源码、官方正文片段与测试日志；这是调查机临时证据，**不是永久交付依赖**。本报告已记录固定 SHA、官方链接、关键输入输出和最小复现，以便缓存消失后重新核查。
