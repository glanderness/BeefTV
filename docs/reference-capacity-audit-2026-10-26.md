# 参考素材上限核对：火山方舟 / 腾讯云 / MiniMax 官方文档 vs BeefTV 代码

核对日期：2026-10-26。基线：`main` 4e832b7。

方法：用 ego-browser 逐个打开官方文档页面，读页面正文后原文摘录（下面每条都带网址和原句）；代码侧读 `backend/internal/modelcatalog/`、`backend/internal/providerpreset/`、`web/src/lib/model-capabilities.ts`，并用 `bun` 直接跑前端 `defaultModelCapabilityConfig()` 取实际生效值。全程只读：没有改代码、没有开 PR、没有调用任何生成接口。

## 一句话结论

1. 数量上限（图 / 视频 / 音频）和官方文档对得上：Seedance 2.0 是 9/3/3，2.5 是 30/10/10，Seedream 图片 pro/flash 10 张、lite/4.5/4.0 14 张，MiniMax H3 是 9/3/3。这几组不是我们自己编的。
2. 对不上的有三处：①走 BeefAPI 线路时，Seedance 参考音频最短接受 1.8 秒，官方两份文档都写 2 秒；②Seedance 输出时长下限代码给的是 1 秒，官方是 4 秒；③火山方舟通用视频协议给所有模型都放出「9 图 + 3 视频 + 3 音频」，而 Seedance 1.0 pro 官方只支持文生视频和单图/首尾帧图生视频，没有参考视频和参考音频。
3. 腾讯云的接口文档里没有 Seedance 条目；有海螺 H3 / H3-Max，但逐模型的参考素材数量官方页面明确不给，让去原厂文档看。腾讯生图接口倒是写了逐模型参考图数量。
4. 「三类合计不超过 12 个」在字节官方和腾讯云文档里都没有。它分别出现在 fal 的接口说明（"Total files across all modalities must not exceed 12"）和即梦的产品界面（「上传最多12个参考素材」）。

## 1. BeefTV 代码里现在写的数字

### 1.1 视频模型

| 模型 / 线路 | 图 | 视频 | 音频 | 单段时长 / 总时长 | 单文件大小 | 代码位置 |
|---|---|---|---|---|---|---|
| Seedance 2.0（含 fast / mini、dreamina 原生） | 9 | 3 | 3 | 视频 2–15s / 总 15s；音频 1.8–15s / 总 15s | 图 30MB、视频 200MB、音频 15MB | `backend/internal/modelcatalog/seedance.go:89` `overlayOfficialSeedance2References` |
| Seedance 2.5 | 30 | 10 | 10 | 视频 2–30s / 总 30s；音频 1.8–30s / 总 30s | 同上 | 同上 |
| 火山方舟视频协议（`volcengine-ark-video` / `-agent-plan-video`）通用值 | 9 | 3 | 3 | 视频 15s、音频 15s、最短各 2s | 视频 200MB、音频 15MB | `capability.go:199-206` |
| `newapi-channel-1/2`、`video-generations-json` 通用值 | 9 | 3 | 3 | 视频 15s、音频 15s、**没有最短时长** | 视频 200MB、音频 15MB | `capability.go:213-219` |
| 视频通用默认（没被上面覆盖时） | 9 | 0 | 0 | — | 图 30MB | `capability.go:179` |
| MiniMax（`minimax-video` 协议） | 9 | 3 | 3 | 视频 15s、音频 15s，输出时长枚举 4–15 秒 | 图 30MB、视频 50MB、音频 15MB | `capability.go:228-243` |
| Agnes 视频 2.5 / 2.5-flash | 9 / 5 | 3 / 0 | 3 / 3 | 视频 15s、音频 15s | 视频 200MB、音频 15MB | `capability.go:377-386` |
| Novita | 1 | 0 | 0 | — | 图 10MB | `capability.go:222-227` |
| BeefAPI 渠道预设里的 minimax-h3 家族 | `minimax-h3`、`minimax-h3-max`、`minimax-h3-max-turbo` 为 9/3/3；`minimax-h3-max-style-*` 为 1/0/0 | | | | | `backend/internal/providerpreset/video_contracts.json` |
| BeefAPI 渠道预设里的 kling / grok / wan | 1 | 0 | 0 | — | — | 同上 |

Seedance 全系共用的几何限制（两端同一个来源）：图片与视频边长 300–6000px、宽高比 0.4–2.5、视频总像素 409600–8295044，火山直连与素材库线路把下限改成 407696 —— `seedance.go:31-34`、`seedance.go:113-126`、`capability.go:258`。

### 1.2 图片模型（参考图张数）

| 模型 / 线路 | 参考图 | 代码位置 |
|---|---|---|
| Seedream 5.0 pro / 5.0 flash（`dola-seedream-5-0-*`） | 10 | `capability.go:61-66` |
| Seedream 5.0 lite（`seedream-5-0-*`）、4.5、4.0 | 14 | 同上 |
| 即梦图片（`volcengine-jimeng-image`） | 14 | `capability.go:127` |
| 通用默认（OpenAI 兼容、Gemini 图片、火山方舟图片等没单独写的） | 16 | `capability.go:95` |
| Grok 图片（`grok-image`） | 1 | `capability.go:111` |
| `grok-imagine-image*` 走非 grok 协议 | 0 | `capability.go:143` |
| Agnes 图片 | 9 | `web/src/lib/model-capabilities.ts:471` |
| hy-image-v3 / midjourney-v8.2（BeefAPI 图片合同） | 3 / 1 | `backend/internal/providerpreset/image_contracts.json` |

### 1.3 前端同一套默认值

`web/src/lib/model-capabilities.ts` 里有一份和后端平行的默认值，Seedance 覆盖函数在 `model-capabilities.ts:746`（`overlayOfficialSeedance2References`），数值与后端一致，唯一不同是 `full-video` 自定义协议把视频、音频上限写成 100MB（`model-capabilities.ts:547-548`）。

实际生效值（`bun` 跑 `defaultModelCapabilityConfig`）：

```
volcengine-ark-video / seedance-2.0  → 图9 视频3 音频3，视频15s/15s，音频1.8s起，输出1–15s
newapi-channel-2      / seedance-2.0 → 图9 视频3 音频3，视频15s/15s，音频1.8s起，输出1–15s
newapi-channel-2      / seedance-2.5 → 图30 视频10 音频10，视频30s/30s，音频1.8s起，输出1–30s
newapi-channel-2      / minimax-h3   → 图9 视频3 音频3，视频15s/15s，音频无最短
volcengine-ark-video  / seedance-1.0-pro → 图9 视频3 音频3（该模型官方不支持后两项）
full-video            / seedance-2.5 → 图30 视频10 音频10，但视频/音频单文件上限写成 100MB
```

## 2. 官方原文

### 2.1 火山方舟《创建视频生成任务》API 参考

https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh

> Doubao Seedance 2.5 new（有声视频 / 无声视频）
> 全模态参考生视频：输入参考图片（0-30 张）+ 参考视频（0-10 个）+ 参考音频（0-10 个）+ 文本提示词（可选）生成 1 个目标视频。支持仅传入音频。支持生成全新视频、编辑视频、延长视频，支持 30 秒视频连贯直出。

> Doubao Seedance 2.0 系列（有声视频 / 无声视频）
> 全模态参考生视频：输入参考图片（0-9 张）+ 参考视频（0-3 个）+ 参考音频（0-3 个）+ 文本提示词（可选）生成 1 个目标视频。注意不可单独输入音频，应至少包含 1 个参考视频或图片。

参考视频：

> Seedance 2.5：非视频编辑任务：单个视频时长 [2, 30] s。视频编辑任务：单个视频时长 [4, 30] s。最多传入 10 个参考视频，所有视频总时长不超过 30 s。
> Seedance 2.0 系列：单个视频时长 [2, 15] s，最多传入 3 个参考视频，所有视频总时长不超过 15 s。
> 尺寸：宽高比（宽/高）：[0.4, 2.5]；宽高长度（px）：[300, 6000]；总像素数：[614×664=407696, 3326×2494=8295044]；大小：单个视频不超过 200 MB。帧率（FPS）：[24, 60]

参考音频：

> 时长：Seedance 2.5：单个音频时长 [2, 30] s，最多传入 10 段参考音频，所有音频总时长不超过 30 s。Seedance 2.0 系列：单个音频时长 [2, 15] s，最多传入 3 段参考音频，所有音频总时长不超过 15 s。大小：单个音频不超过 15 MB，请求体大小不超过 64 MB。

音频 role 说明：

> Seedance 2.5：可仅传入音频，无需搭配图片 / 视频；也可配合图片 / 视频一起传入
> Seedance 2.0 系列：不可单独输入音频，应至少包含 1 个参考视频或图片。

### 2.2 火山方舟 Seedance 2.0 / 2.5 教程

https://docs.volcengine.com/docs/ark/seedance-2-0?lang=zh （页面「最近更新时间：2026.09.29」）

> 您可任意组合以下模态内容，注意不支持“文本+音频”、“纯音频” 输入。
> 文本 图片：0~9 张 视频：0~3 个 音频：0~3 个

> 输出时长 "duration": 5 → 4~15 秒

https://docs.volcengine.com/docs/ark/seedance-2-5?lang=zh

> 参考素材数量增加：参考图数量上限由 9 张增至 30 张， 参考音/视频数量上限由 3 个增至 10 个 参考音/视频总时长由 15 秒增至 30 秒

> 50 个全模态参考素材输入：Seedance 2.5 单次输入素材上限提升至 50 个（30 张图片 + 10 段视频 + 10 段音频），可自由组合图片、视频、音频等多模态素材，实现更丰富的创意表达。同时，Seedance 2.5 新增支持纯音频参考生成视频，无需搭配图片或视频素材。

> 图片数量：图生视频-首帧：1 张；图生视频-首尾帧：2 张；全模态参考生视频：1~30 张

> 视频要求 … 时长：非视频编辑任务：单个视频时长 [2, 30] s；视频编辑任务：单个视频时长 [4, 30] s。最多传入 10 个参考视频，所有视频总时长不超过 30 s。大小：单个视频不超过 200 MB

> 音频要求 … 时长：单个音频时长 [2, 30] s，最多传入 10 段参考音频，所有音频总时长不超过 30 s。大小：单个音频不超过 15 MB

> 图片要求 … 宽高比（宽/高）：[0.4, 2.5]；宽高长度（px）：[300, 6000]；大小：单张图片小于 30 MB

> 输出时长：4~30 秒；-1（在有效时长内由模型自动选择最佳时长）

### 2.3 火山方舟《图片生成》API 参考（Seedream 系列）

https://docs.volcengine.com/docs/ark/image-generation-api?lang=zh

> 图片生成场景 可选
> Seedream 5.0 pro / Seedream 5.0 flash 最多支持传入 10 张参考图；Seedream 5.0 lite / 4.5 / 4.0 最多支持传入 14 张参考图。
> 单张图片传入要求：… 宽高比（宽 / 高）范围：[1/16, 16]；大小：不超过 30MB；总像素：[196, 6000×6000（3600万）]

### 2.4 MiniMax 开放平台《创建视频生成任务》

https://platform.minimaxi.com/docs/api-reference/video-generation-v2-create

> MiniMax-H3-Max：极速生成版本。支持文生视频、图生视频（首帧 / 尾帧）与多模态参考生视频（参考图 / 参考视频 / 参考音频）；分辨率 480P / 768P，不支持 2K；时长 5~15 秒。

> 图片 image_url：… 单文件大小 ≤ 30 MB；宽高范围 [256, 5760] px；长宽比（宽/高）[0.4, 2.5]；数量 首帧 ≤ 1、尾帧 ≤ 1、参考图 ≤ 9

> 视频 video_url（仅多模态参考场景）：… 单文件大小 ≤ 50 MB；个数 ≤ 3；单段时长 [2, 15] s；总时长 ≤ 15 s

> 音频 audio_url（仅多模态参考场景）：… 单文件大小 ≤ 15 MB；个数 ≤ 3；单段时长 [2, 15] s；总时长 ≤ 15 s

### 2.5 腾讯云点播

《创建 AIGC 生视频任务》 https://cloud.tencent.com/document/product/266/126239

> ModelName … 取值：Kling：可灵；Vidu；Hailuo：海螺；Hunyuan：混元；Mingmou：明眸；GV；OS；PixVerse；
> ModelVersion … 当 ModelName 是 Hailuo，可选值为 02、2.3、2.3-fast、H3、H3_regen、H3-Max；

> 图片大小不超过10M。支持的图片格式：jpeg、jpg、png。
> 关于模型某个版本是否支持参考图片/视频/声音、首尾帧、视频编辑等功能，可向我们索取文档或者参考原厂文档信息。

（即：这一页没有写任何模型的参考图 / 视频 / 音频数量上限，也没写单段时长和总时长限制。）

《创建 AIGC 生图任务》 https://cloud.tencent.com/document/product/266/126240

> AIGC 生图任务的输入图片的文件信息。各模型支持最大参考图数量：
> GG 2.5： 3张；GG 3.0：14张；GG 3.1：14张；Kling 2.1：4张；Kling 3.0：1张；Kling 3.0-Omni：10张；Kling O1：10张；Vidu q2：7张；Hunyuan 3.0：3张；

《云点播 AI 生视频》（产品功能页） https://cloud.tencent.com/document/product/266/124474

> AI 生视频是基于多模态大模型的智能创作工具，支持通过文本、图像、脚本等输入快速生成动态视频内容。核心功能包括：文生视频、图生视频。
> 文生视频｜输入文本描述…自动生成5秒-10秒短视频。

（产品功能页只讲文生 / 图生和 5–10 秒，没有逐模型素材数量。营销页 https://cloud.tencent.com/product/voda 写「接入混元、即梦、可灵、谷歌等头部厂商前沿模型」，但对应的两页服务端 API 文档里都没有即梦 / Seedance 的 ModelName 取值。）

### 2.6 只用来解释「12 个」的第三方页面

https://fal.ai/models/bytedance/seedance-2.0/reference-to-video/api

> Max 30 MB per image. Up to 9 images. Total files across all modalities must not exceed 12.

https://jimeng.jianying.com/ai-tool/home?type=video （即梦产品界面，需登录）

> 参考内容 上传最多12个参考素材、输入文字或参考内容，自由组合图、文、音、视频多元素。

## 3. 逐项对照

### 3.1 数量上限

| 项 | BeefTV | 官方 | 结论 |
|---|---|---|---|
| Seedance 2.0 参考图 / 视频 / 音频 | 9 / 3 / 3 | 火山方舟 API：0-9 / 0-3 / 0-3 | 一致 |
| Seedance 2.0 只放音频 | 拒绝（提示需加图或视频） | 「不可单独输入音频，应至少包含 1 个参考视频或图片」 | 一致 |
| Seedance 2.5 参考图 / 视频 / 音频 | 30 / 10 / 10 | 火山方舟 API：0-30 / 0-10 / 0-10；教程写「单次输入素材上限提升至 50 个（30+10+10）」 | 一致（50 是三项相加，没有额外的一层合计上限） |
| Seedance 2.5 只放音频 | 允许（能力里加了 `audio_to_video`） | 「支持仅传入音频」 | 一致 |
| Seedream 5.0 pro / flash 参考图 | 10 | 10 | 一致 |
| Seedream 5.0 lite / 4.5 / 4.0 参考图 | 14 | 14 | 一致 |
| MiniMax H3 家族 参考图 / 视频 / 音频 | 9 / 3 / 3 | MiniMax 官方：≤9 / ≤3 / ≤3 | 数量一致（但见 3.3 第 3 条：线路差异） |
| 火山方舟通用视频协议给所有模型 9/3/3 | Seedance 1.0 pro 也是 9 / 3 / 3 | Seedance 1.0 pro 官方能力只有「图生视频-首尾帧 / 图生视频-首帧 / 文生视频」，没有参考视频、参考音频 | **不一致**：会给上游不支持的能力开口子 |

### 3.2 时长与文件大小

| 项 | BeefTV | 官方 | 结论 |
|---|---|---|---|
| Seedance 参考视频单段 | 2.0：2–15s；2.5：2–30s | 2.0：[2, 15]；2.5：[2, 30]（编辑任务 [4, 30]） | 基本一致；2.5 的「编辑任务 4 秒起」只在 dreamina 原生 `inpaint` 分支生效（`seedance.go:132`），BeefAPI 线路仍按 2 秒起 |
| Seedance 参考视频总时长 | 2.0：15s；2.5：30s | 2.0：≤15s；2.5：≤30s | 一致 |
| Seedance 参考音频单段 | 1.8s 起（火山直连线路被改成 2s） | [2, 15]（2.0）、[2, 30]（2.5） | **不一致**：BeefAPI / `openai-videos` 线路（生产主线路）最低 1.8 秒，官方是 2 秒 |
| Seedance 参考音频总时长 | 2.0：15s；2.5：30s | 2.0：≤15s；2.5：≤30s | 一致 |
| 单文件大小 | 图 30MB、视频 200MB、音频 15MB | 一致（2.0 / 2.5 教程与 API 页都写 图 30MB、视频 200MB、音频 15MB） | 一致；`full-video` 自定义协议例外：视频、音频都写成 100MB（`model-capabilities.ts:547-548`） |
| 图片边长 / 宽高比 | 300–6000px、0.4–2.5 | 300–6000px、0.4–2.5 | 一致 |
| 视频总像素 | 409600–8295044（火山直连与素材库线路 407696 起） | [407696, 8295044] | 数值来源正确；直连线路对齐，其它线路保留旧下限 409600 |
| Seedance 输出时长 | 1–15s（2.0）、1–30s（2.5） | 2.0：4~15 秒；2.5：4~30 秒（或 -1 自动） | **不一致**：下限 1 秒，官方 4 秒起（`full-video` 协议和 dreamina 原生分支是 4 秒起） |
| MiniMax 参考视频 / 音频单段与总时长 | 15s / 15s，无最短 | [2, 15] s，总 ≤15 s | 上限一致，**缺 2 秒下限** |

### 3.3 需要特别说明的三条

1. **音频 1.8 秒的来源找不到官方出处。** `OfficialSeedanceMinAudioSeconds = 1.8`（`seedance.go:34`）引入于 2026-09-28 那次「对齐素材限制」的提交（e2fd1d3）。我按关键词在火山方舟 Seedance 2.0/2.5 教程、创建任务 API 页面里逐段搜索，都没有「1.8」，两份文档都写 `[2, 15]` / `[2, 30]`。火山直连线路代码里另外改成 2 秒（`capability.go:258-260`），只有 BeefAPI / `openai-videos` 线路保留 1.8 —— 也就是线上主线路放过 1.8–2 秒的音频，上游会拒。
2. **腾讯渠道的 Seedance，腾讯文档里读不到。** 腾讯云点播「创建 AIGC 生视频任务」的 ModelName 只有 Kling / Vidu / Hailuo / Hunyuan / Mingmou / GV / OS / PixVerse，没有 Seedance；同一页还写着「关于模型某个版本是否支持参考图片/视频/声音…可向我们索取文档或者参考原厂文档信息」。所以「走腾讯渠道的 Seedance 该按哪份」的答案是：腾讯没有自己的数字，只能按字节官方（火山方舟）那一份；海螺 H3 也一样，腾讯只给版本名（H3、H3_regen、H3-Max），数量按 MiniMax 官方 9/3/3。
3. **同名模型在不同上游的合同不一样。** BeefAPI 预设把 `minimax-h3-max-turbo` 记成 9/3/3（`video_contracts.json`），而仓库里 2026-10-13 的 fal 线路记录写的是「1–2 张关键帧图、无参考视频、1 段音频」（`docs/fal-h3-max-turbo.md`）。MiniMax 官方对 `MiniMax-H3-Max` 写的是支持多模态参考。三者不冲突，说明同一模型名在不同上游的合同不同，报错排查时要按实际渠道那份看。

### 3.4 「三类合计 12 个」

| 来源 | 有没有 | 原文 |
|---|---|---|
| 火山方舟 2.0 教程 / 创建任务 API | 没有 | 只有 0-9 / 0-3 / 0-3，没有合计上限 |
| 火山方舟 2.5 教程 | 没有 12；另有 50 | 「单次输入素材上限提升至 50 个（30 张图片 + 10 段视频 + 10 段音频）」——正好是三项相加 |
| 腾讯云点播生视频 API | 没有（连逐模型数量都不写） | 「可向我们索取文档或者参考原厂文档信息」 |
| fal | 有 | 「Total files across all modalities must not exceed 12」 |
| 即梦产品界面 | 有 | 「上传最多12个参考素材」 |

结论：12 是产品层（即梦交互）和第三方（fal）各自加的上限，不是字节模型的能力上限。BeefTV 现在没有实现 12 这条限制，也不需要补。

## 4. 待解决问题的回答

**Q1：创作页和后端实际会用到哪些模型？哪些上限写死，哪些能改？**

- 生产清单不在这份仓库里：模型来自渠道目录（BeefAPI 目录和本地渠道配置），由 `capability_config_json` 持久化，前端只读它。代码能确认「会被识别并给默认值」的模型族有：`seedance-2.0` / `-fast` / `-mini`、`seedance-2.5`、`dreamina-seedance-2-0/2-5`、`minimax-h3`、`minimax-h3-max`、`minimax-h3-max-turbo`、`minimax-h3-max-style-*`、`agnes-video-2.5(-flash)`、`grok-imagine-video`、`kling-video-v3`、`wan3.0-video`、`novita` 视频；图片是 `seedream-5-0-pro/flash`、`seedream-5-0-lite`、`4.5`、`4.0`、即梦图片、Gemini 图片、Grok 图片、`hy-image-v3`、`midjourney-v8.2`、`gpt-image` 系列。
- 写死的地方：Seedance 2.x 的整套素材数字在「生成默认合同」时被强制覆盖（`seedance.go:89`，前端 `model-capabilities.ts:746` 还有一份同样的副本），代码里两套必须同步改。其余模型的数字只在默认合同里给初值，渠道保存过的能力 JSON 优先，管理员在模型能力设置里能改。
- 也就是：想改 Seedance 的数字，要么改这两处代码再让渠道重新生成默认值，要么单独改某个渠道模型的能力 JSON。

**Q2：腾讯云文档和火山方舟文档对同一个模型的数字一致吗？走腾讯渠道按哪一份？**

- 腾讯云点播生视频 API 根本不写逐模型数字，所以不存在「两份数字不一致」，只有「腾讯那份没有」。同一页明确让去看原厂文档，所以按字节官方那一份；海螺按 MiniMax 官方那一份（腾讯只给了版本名）。
- 腾讯唯一写了逐模型数量的是生图接口：GG 2.5 3 张、GG 3.0 / 3.1 各 14 张、Kling 2.1 4 张、Kling 3.0 1 张、Kling 3.0-Omni / O1 各 10 张、Vidu q2 7 张、Hunyuan 3.0 3 张。这些名字和 BeefTV 现在的图片模型名对不上（我们主用 Seedream / gpt-image），所以暂时不影响创作页。

**Q3：「三类合计 12 个」官方有没有？** 没有，见 3.4。

## 5. 没核到的（不猜）

- Gemini 图片（代码里通用默认 16 张）、Grok 图片、Agnes 图片与视频、hy-image-v3、midjourney：这些不在这两份文档范围内，本次没有读它们各自的官方文档。
- 火山方舟即梦图片（代码 14 张）、火山方舟「通用视频」里 Seedance 1.0 pro 以外的老模型：没有逐条读对应模型页。
- 火山方舟「使用限制」独立页：2.0 教程里只有一句「参见 使用限制」的跳转，页面内锚点没有展开正文，所以 2.0 的单段时长/大小是从「创建视频生成任务 API」页取的，两份数值一致但不是同一页。
- 腾讯云点播 AIGC 生视频的「模型能力明细」（腾讯说可以索取）没有拿到；腾讯控制台里实际开通的模型清单也没有核对（需要账号权限）。

## 6. 建议（本次不改代码）

1. 把 BeefAPI / `openai-videos` 线路的 Seedance 参考音频下限从 1.8 秒统一到 2 秒（两处：`seedance.go:34` 与 `model-capabilities.ts:758`），否则用户能提交 1.8–2 秒音频、上游报错。
2. 火山方舟通用视频协议不要无条件给 3 个参考视频 / 3 个参考音频：至少对 Seedance 1.0 系列退回「只有首帧/尾帧」，避免放出上游不支持的能力。
3. Seedance 输出时长下限和官方对齐到 4 秒（当前 1 秒），或者明确记录「接受 1 秒由上游归一」的理由。
4. `full-video` 自定义协议里视频 200MB / 音频 15MB 被写成 100MB，和官方不一致，建议核对这条协议的真实上游后改成一致。
5. 在 `docs/content/docs/backend/seedance-task-constraints.mdx` 的「文档核对」小节补上本次的音频 2 秒、输出 4 秒两条，避免以后再按 1.8 秒实现。