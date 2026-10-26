# 参考素材上限核对：火山方舟 / 腾讯 WAND / MiniMax 官方文档 vs BeefTV 代码

核对日期：2026-10-26（v2）。基线：`main` 4e832b7。

**v2 修订（按用户 2026-10-26 补充）**：第一版腾讯那一栏用的是腾讯云官网公开页面（云点播 AIGC 生视频 / 生图接口文档）。用户指出「腾讯的文档别瞒看，之前文档都拉下来」——供应商发在企业微信群里的是**另一份指南**（WAND-Vega Pro / Lite 接入指南），和公开页面可能不是一回事。所以本版：

- 腾讯侧**不再引用任何腾讯云官网页面**，只读本机已保存的文件和 nmem 记忆；凡是本机没有原文的数字，一律写「本地没有留存原文，待用户从企业微信群里的指南确认」。
- 对照表加一列**证据类型**：官方原文 / 本地留存原文 / 二手总结 / 没有读到。
- 第一版里那些公开页面的观察降级到附录 A，只作「不要再重复去搜」的记录，不作为结论依据。

全程只读：没有改代码、没有开 PR、没有调用任何生成接口。网页只用 ego-browser 打开，没有用 Playwright / Safari。

## 0. 证据类型怎么算

| 证据类型 | 含义 | 本报告里谁属于这类 |
|---|---|---|
| 官方原文 | 我这次用 ego-browser 打开厂商官方文档页，正文原句抄下来 | 火山方舟（docs.volcengine.com / platform.minimaxi.com 的 API 参考与教程页） |
| 本地留存原文 | 本机磁盘上已有的厂商文档正文（网页另存或抓取的 txt） | 只有腾讯 WAND **多模态理解**（Vega-VL）那几份；它们讲的是「读视频/音频」，不是生成视频，**不能用来回答参考素材上限** |
| 二手总结 | 别人读过原指南后写的转述：本机 spec 文件、nmem 记忆条目 | 腾讯 WAND **Pro / Lite 生视频接入指南**在本机属于这一类 |
| 没有读到 | 本机没有、我也没有去网上找替代 | 腾讯 WAND 三个映射各自的参考图 / 视频 / 音频数量上限、单段时长、文件大小 |

## 1. 一句话结论

1. **数量上限（图 / 视频 / 音频）和火山方舟、MiniMax 官方对得上**：Seedance 2.0 是 9/3/3，2.5 是 30/10/10，Seedream 图片 pro/flash 10 张、lite/4.5/4.0 14 张，MiniMax H3 是 9/3/3（证据类型：官方原文）。
2. **和火山方舟官方对不上的有三处**：①走 BeefAPI 主线路时，Seedance 参考音频最短接受 1.8 秒，官方都是 2 秒；②Seedance 输出时长下限代码是 1 秒，官方是 4 秒；③火山通用视频协议给所有模型都放开 9 图 + 3 视频 + 3 音频，而 Seedance 1.0 pro 官方只有文生 / 单帧 / 首尾帧。
3. **腾讯那三个映射（seedance-2.0 → 1.0-pro、seedance-2.5 → 1.5-pro、minimax-h3 → 1.0-lite）的参考素材上限，本机没有原文**，只有二手转述：能确认的只有「Lite 指南里有 3 图 + 1 视频的示例」「Pro 指南 4.1 节写了真人素材免活体的口径」，**没有任何一个上限数字**。这三栏一律待用户从群里的指南确认。
4. **「三类合计 12 个」官方（火山方舟）没有**；它只出现在 fal 的接口说明和即梦产品界面。腾讯那边本机没有原文，无法判断有没有。

## 2. BeefTV 代码里现在写的数字

（这一节的证据是代码本身；行号对应当前工作区 `main` 4e832b7。）

### 2.1 视频模型

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

### 2.2 图片模型（参考图张数）

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

### 2.3 前端同一套默认值

`web/src/lib/model-capabilities.ts` 里有一份和后端平行的默认值，Seedance 覆盖函数在 `model-capabilities.ts:746`，数值与后端一致；唯一不同是 `full-video` 自定义协议把视频、音频上限写成 100MB（`model-capabilities.ts:547-548`）。

实际生效值（`bun` 跑 `defaultModelCapabilityConfig`）：

```
volcengine-ark-video / seedance-2.0  → 图9 视频3 音频3，视频15s/15s，音频1.8s起，输出1–15s
newapi-channel-2      / seedance-2.0 → 图9 视频3 音频3，视频15s/15s，音频1.8s起，输出1–15s
newapi-channel-2      / seedance-2.5 → 图30 视频10 音频10，视频30s/30s，音频1.8s起，输出1–30s
newapi-channel-2      / minimax-h3   → 图9 视频3 音频3，视频15s/15s，音频无最短
volcengine-ark-video  / seedance-1.0-pro → 图9 视频3 音频3（该模型官方不支持后两项）
full-video            / seedance-2.5 → 图30 视频10 音频10，但视频/音频单文件上限写成 100MB
```

## 3. 厂商侧证据

### 3.1 火山方舟（证据类型：官方原文）

《创建视频生成任务》 https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh

> Doubao Seedance 2.5 new（有声视频 / 无声视频）
> 全模态参考生视频：输入参考图片（0-30 张）+ 参考视频（0-10 个）+ 参考音频（0-10 个）+ 文本提示词（可选）生成 1 个目标视频。支持仅传入音频。支持生成全新视频、编辑视频、延长视频，支持 30 秒视频连贯直出。

> Doubao Seedance 2.0 系列（有声视频 / 无声视频）
> 全模态参考生视频：输入参考图片（0-9 张）+ 参考视频（0-3 个）+ 参考音频（0-3 个）+ 文本提示词（可选）生成 1 个目标视频。注意不可单独输入音频，应至少包含 1 个参考视频或图片。

> Doubao Seedance 1.0 pro 支持【图生视频-首尾帧】【图生视频-首帧】【文生视频】。

参考视频：

> Seedance 2.5：非视频编辑任务：单个视频时长 [2, 30] s。视频编辑任务：单个视频时长 [4, 30] s。最多传入 10 个参考视频，所有视频总时长不超过 30 s。
> Seedance 2.0 系列：单个视频时长 [2, 15] s，最多传入 3 个参考视频，所有视频总时长不超过 15 s。
> 尺寸：宽高比（宽/高）：[0.4, 2.5]；宽高长度（px）：[300, 6000]；总像素数：[614×664=407696, 3326×2494=8295044]；大小：单个视频不超过 200 MB。帧率（FPS）：[24, 60]

参考音频：

> 时长：Seedance 2.5：单个音频时长 [2, 30] s，最多传入 10 段参考音频，所有音频总时长不超过 30 s。Seedance 2.0 系列：单个音频时长 [2, 15] s，最多传入 3 段参考音频，所有音频总时长不超过 15 s。大小：单个音频不超过 15 MB，请求体大小不超过 64 MB。

音频 role 说明：

> Seedance 2.5：可仅传入音频，无需搭配图片 / 视频；也可配合图片 / 视频一起传入
> Seedance 2.0 系列：不可单独输入音频，应至少包含 1 个参考视频或图片。

《Doubao Seedance 2.0 系列教程》 https://docs.volcengine.com/docs/ark/seedance-2-0?lang=zh （页面「最近更新时间：2026.09.29」）

> 您可任意组合以下模态内容，注意不支持“文本+音频”、“纯音频” 输入。
> 文本 图片：0~9 张 视频：0~3 个 音频：0~3 个

> 输出时长 "duration": 5 → 4~15 秒

《Doubao Seedance 2.5 教程》 https://docs.volcengine.com/docs/ark/seedance-2-5?lang=zh

> 参考素材数量增加：参考图数量上限由 9 张增至 30 张， 参考音/视频数量上限由 3 个增至 10 个 参考音/视频总时长由 15 秒增至 30 秒

> 50 个全模态参考素材输入：Seedance 2.5 单次输入素材上限提升至 50 个（30 张图片 + 10 段视频 + 10 段音频），可自由组合图片、视频、音频等多模态素材，实现更丰富的创意表达。同时，Seedance 2.5 新增支持纯音频参考生成视频，无需搭配图片或视频素材。

> 图片数量：图生视频-首帧：1 张；图生视频-首尾帧：2 张；全模态参考生视频：1~30 张

> 视频要求 … 时长：非视频编辑任务：单个视频时长 [2, 30] s；视频编辑任务：单个视频时长 [4, 30] s。最多传入 10 个参考视频，所有视频总时长不超过 30 s。大小：单个视频不超过 200 MB

> 音频要求 … 时长：单个音频时长 [2, 30] s，最多传入 10 段参考音频，所有音频总时长不超过 30 s。大小：单个音频不超过 15 MB

> 图片要求 … 宽高比（宽/高）：[0.4, 2.5]；宽高长度（px）：[300, 6000]；大小：单张图片小于 30 MB

> 输出时长：4~30 秒；-1（在有效时长内由模型自动选择最佳时长）

《图片生成》API 参考（Seedream 系列） https://docs.volcengine.com/docs/ark/image-generation-api?lang=zh

> 图片生成场景 可选
> Seedream 5.0 pro / Seedream 5.0 flash 最多支持传入 10 张参考图；Seedream 5.0 lite / 4.5 / 4.0 最多支持传入 14 张参考图。
> 单张图片传入要求：… 宽高比（宽 / 高）范围：[1/16, 16]；大小：不超过 30MB；总像素：[196, 6000×6000（3600万）]

### 3.2 MiniMax（证据类型：官方原文）

《创建视频生成任务》 https://platform.minimaxi.com/docs/api-reference/video-generation-v2-create

> MiniMax-H3-Max：极速生成版本。支持文生视频、图生视频（首帧 / 尾帧）与多模态参考生视频（参考图 / 参考视频 / 参考音频）；分辨率 480P / 768P，不支持 2K；时长 5~15 秒。

> 图片 image_url：… 单文件大小 ≤ 30 MB；宽高范围 [256, 5760] px；长宽比（宽/高）[0.4, 2.5]；数量 首帧 ≤ 1、尾帧 ≤ 1、参考图 ≤ 9

> 视频 video_url（仅多模态参考场景）：… 单文件大小 ≤ 50 MB；个数 ≤ 3；单段时长 [2, 15] s；总时长 ≤ 15 s

> 音频 audio_url（仅多模态参考场景）：… 单文件大小 ≤ 15 MB；个数 ≤ 3；单段时长 [2, 15] s；总时长 ≤ 15 s

### 3.3 腾讯 WAND（证据类型：以二手总结为主，无本地原文）

本机读过的文件（全部读完，不是摘要）：

1. `/Volumes/ExternalWork/todos/workspaces/01a1760a-82c4-7ca8-9f7c-c8e856bf2d42/docs/specs/tencent-wand-video-enterprise.md`（162 行，**二手总结**，是我们自己写的接入规格，引用了供应商 Pro 指南 4.1 节）。它给出的只有映射关系和一句对标：
   > | `seedance-2.0` | `vod/wand-vega-video/1.0-pro` | Pro guide explicitly compares to SD 2.0 |
   > | `seedance-2.5` | `vod/wand-vega-video/1.5-pro` | Pro guide explicitly compares to SD 2.5 |
   > | `minimax-h3` | `vod/wand-vega-video/1.0-lite` | Lite guide examples use Hailuo/H3; identical-model identity is unverified |
   >
   > Sources are Tencent's VOD WAND-Vega Pro/Lite guides shared in the owner-named WeCom group…

   全文没有任何参考图 / 视频 / 音频的数量、时长或大小数字；真人素材那段（4.1 节）讲的是 `IsRealPerson: "False"` 的免活体口径，不是数量。

2. nmem 记忆（**二手总结**）：
   - `ce5221a2-cecc-4afe-bce3-afe3793765a3`：「1.0-pro对标Seedance2.0，1.5-pro对标Seedance2.5，1.0-lite的Hailuo/H3示例支持H3映射；对标不证明底层同款或完全等效。」
   - `13430b6d-de23-43d8-a011-634a53af8263`：「腾讯WAND各版本与Seedance 2.0／2.5、H3的对应关系及计费用量尚未完全核实，不能仅凭“对标”认定为同款。」
   - `ba315222-99cc-40a5-925a-f0fa0de62940`：「腾讯Lite接入文档明确支持视频参考并有“3图＋1视频”示例，属于我方H3适配未补完整。」——这是**示例**，不是上限；同一条还记录该 H3 请求（3 图 + 1 视频、14 秒、768p）因适配器排除参考视频而走了 fal，共扣费 ¥8.54。

3. `/Volumes/ExternalWork/beeftv/artifacts/assistant-production-flow-20261018/reference-source/` 下的 `vod-wand-vl-live-20261019.txt`、`vod-wand-vl-intro-live-20261019.txt`、`vod-wand-changelog-live-20261019.txt`、`wand-general-guide-live-20261019.txt`：**本地留存原文，但属于 WAND 多模态理解（Vega-VL）**，页首写的就是「WAND 多模态理解接入指引」「Vega-VL - 多模态理解模型（已上线）」。它们的「媒体限制」是理解的限制（单个 < 100 MB、单次请求视频最多 10 个），和生成视频的参考素材上限无关，**不填进对照表**。
   - 补充一条可核对的事实：这几份文件的目录里列着「1. Vega-Video - 生视频模型」，但正文没有这一节的内容，说明本机留存的是**理解那几节**，生视频那节当时没存下来。

4. 我又在磁盘上按 `wand-vega-video` / `WAND-Vega Pro` / `IsRealPerson` 搜了 `beeftv/artifacts`、`beeftv/docs`、`todos/workspaces` 两处工作区，**没有找到 Pro / Lite 生视频接入指南的正文留存**。

结论（腾讯侧）：

| 需要的数字 | 本机现状 | 证据类型 |
|---|---|---|
| 1.0-pro 参考图 / 视频 / 音频数量上限 | 本地没有留存原文，待用户从企业微信群里的指南确认 | 没有读到 |
| 1.5-pro 同上 | 同上 | 没有读到 |
| 1.0-lite 同上（只知有「3 图 + 1 视频」示例） | 本地没有留存原文（示例不等于上限），待确认 | 二手总结 |
| 三个版本的单段 / 总时长、文件大小 | 本地没有留存原文，待确认 | 没有读到 |
| 是否有「三类合计 12 个」这类合计限制 | 本地没有留存原文，无法判断 | 没有读到 |

### 3.4 fal 与即梦（只用来解释「12 个」从哪来）

https://fal.ai/models/bytedance/seedance-2.0/reference-to-video/api （证据类型：官方原文，但是 fal 这家转售方的接口页）

> Max 30 MB per image. Up to 9 images. Total files across all modalities must not exceed 12.

https://jimeng.jianying.com/ai-tool/home?type=video （证据类型：产品界面原文，需登录）

> 参考内容 上传最多12个参考素材、输入文字或参考内容，自由组合图、文、音、视频多元素。

## 4. 逐项对照

### 4.1 数量上限

| 项 | BeefTV | 厂商侧 | 证据类型 | 结论 |
|---|---|---|---|---|
| Seedance 2.0 参考图 / 视频 / 音频 | 9 / 3 / 3 | 火山方舟：0-9 / 0-3 / 0-3 | 官方原文 | 一致 |
| Seedance 2.0 只放音频 | 拒绝 | 火山方舟：「不可单独输入音频，应至少包含 1 个参考视频或图片」 | 官方原文 | 一致 |
| Seedance 2.5 参考图 / 视频 / 音频 | 30 / 10 / 10 | 火山方舟：0-30 / 0-10 / 0-10；教程写「单次输入素材上限提升至 50 个（30+10+10）」 | 官方原文 | 一致（50 是三项相加，没有额外一层合计上限） |
| Seedance 2.5 只放音频 | 允许 | 火山方舟：「支持仅传入音频」 | 官方原文 | 一致 |
| Seedream 5.0 pro / flash 参考图 | 10 | 10 | 官方原文 | 一致 |
| Seedream 5.0 lite / 4.5 / 4.0 参考图 | 14 | 14 | 官方原文 | 一致 |
| MiniMax H3 家族参考图 / 视频 / 音频 | 9 / 3 / 3 | MiniMax 官方：≤9 / ≤3 / ≤3 | 官方原文 | 数量一致（线路差异见 4.3 第 3 条） |
| 火山通用视频协议给所有模型 9/3/3 | Seedance 1.0 pro 也是 9 / 3 / 3 | 官方只列「图生视频-首尾帧 / 图生视频-首帧 / 文生视频」 | 官方原文 | **不一致**：会给上游不支持的能力开口子 |
| 腾讯 1.0-pro（= 我们的 seedance-2.0）参考素材上限 | 9 / 3 / 3 | 本地没有留存原文，待用户从企业微信群里的指南确认 | 没有读到 | **无法核对** |
| 腾讯 1.5-pro（= 我们的 seedance-2.5）参考素材上限 | 30 / 10 / 10 | 同上 | 没有读到 | **无法核对** |
| 腾讯 1.0-lite（= 我们的 minimax-h3）参考素材上限 | 9 / 3 / 3 | 二手总结只说 Lite 指南有「3 图 + 1 视频」示例 | 二手总结 | **无法核对上限**（示例不足以定上限） |

### 4.2 时长与文件大小

| 项 | BeefTV | 厂商侧 | 证据类型 | 结论 |
|---|---|---|---|---|
| Seedance 参考视频单段 | 2.0：2–15s；2.5：2–30s | 2.0：[2, 15]；2.5：[2, 30]（编辑任务 [4, 30]） | 官方原文 | 基本一致；2.5「编辑任务 4 秒起」只在 dreamina 原生 `inpaint` 分支生效（`seedance.go:132`），BeefAPI 线路仍按 2 秒起 |
| Seedance 参考视频总时长 | 2.0：15s；2.5：30s | 2.0：≤15s；2.5：≤30s | 官方原文 | 一致 |
| Seedance 参考音频单段 | 1.8s 起（火山直连线路改成 2s） | [2, 15]（2.0）、[2, 30]（2.5） | 官方原文 | **不一致**：BeefAPI / `openai-videos` 主线路最低 1.8 秒 |
| Seedance 参考音频总时长 | 2.0：15s；2.5：30s | 2.0：≤15s；2.5：≤30s | 官方原文 | 一致 |
| 单文件大小 | 图 30MB、视频 200MB、音频 15MB | 图 30MB、视频 200MB、音频 15MB | 官方原文 | 一致；`full-video` 协议例外：视频、音频都写成 100MB（`model-capabilities.ts:547-548`） |
| 图片边长 / 宽高比 | 300–6000px、0.4–2.5 | 300–6000px、0.4–2.5 | 官方原文 | 一致 |
| 视频总像素 | 409600–8295044（直连线路 407696 起） | [407696, 8295044] | 官方原文 | 数值来源正确；直连对齐，其它线路保留旧下限 409600 |
| Seedance 输出时长 | 1–15s（2.0）、1–30s（2.5） | 2.0：4~15 秒；2.5：4~30 秒（或 -1 自动） | 官方原文 | **不一致**：下限 1 秒，官方 4 秒起（`full-video` 与 dreamina 原生分支是 4 秒起） |
| MiniMax 参考视频 / 音频单段与总时长 | 15s / 15s，无最短 | [2, 15] s，总 ≤15 s | 官方原文 | 上限一致，**缺 2 秒下限** |
| 腾讯三个版本的时长 / 大小 | 见 2.1 | 本地没有留存原文，待确认 | 没有读到 | **无法核对** |

### 4.3 需要特别说明的三条

1. **音频 1.8 秒找不到官方出处。** `OfficialSeedanceMinAudioSeconds = 1.8`（`seedance.go:34`）引入于 2026-09-28 那次「对齐素材限制」的提交（e2fd1d3）。我在火山方舟 Seedance 2.0 / 2.5 教程和创建任务 API 页面逐段搜过，都没有「1.8」，两份都写 `[2, 15]` / `[2, 30]`。火山直连线路代码另外改成 2 秒（`capability.go:258-260`），只有 BeefAPI / `openai-videos` 主线路保留 1.8 —— 线上的主线路会放过 1.8–2 秒的音频，上游拒。
2. **腾讯渠道要按哪一份：现在答不了，因为缺原文。** 本机能确认的只有映射关系（1.0-pro↔2.0、1.5-pro↔2.5、1.0-lite↔H3）和「对标不证明同款」这条保留意见（二手总结）。三个版本的参考素材上限都**没有本地原文**，所以既不能说和字节一致，也不能说腾讯另有一套。这一栏等用户从企业微信群的 Pro / Lite 指南确认；拿到之后要按「腾讯版本号」而不是「我们的模型名」记数字，因为一旦上游是他们自己的模型，上限可能不同。
3. **同名模型在不同上游的合同本来就不一样。** BeefAPI 预设把 `minimax-h3-max-turbo` 记成 9/3/3，而 2026-10-13 的 fal 线路记录（`docs/fal-h3-max-turbo.md`）写的是「1–2 张关键帧图、无参考视频、1 段音频」；MiniMax 官方对 `MiniMax-H3-Max` 写的是支持多模态参考。三者不冲突——报错排查要按实际走的那家渠道的合同看。

### 4.4 「三类合计 12 个」

| 来源 | 有没有 | 证据类型 | 原文 |
|---|---|---|---|
| 火山方舟 2.0 教程 / 创建任务 API | 没有 | 官方原文 | 只有 0-9 / 0-3 / 0-3，无合计上限 |
| 火山方舟 2.5 教程 | 没有 12；另有 50 | 官方原文 | 「单次输入素材上限提升至 50 个（30 张图片 + 10 段视频 + 10 段音频）」 |
| 腾讯 WAND Pro / Lite 指南 | 不知道 | 没有读到 | 本地没有留存原文，待用户从企业微信群里的指南确认 |
| fal | 有 | 官方原文（转售方） | 「Total files across all modalities must not exceed 12」 |
| 即梦产品界面 | 有 | 界面原文 | 「上传最多12个参考素材」 |

结论：12 是即梦交互层和 fal 各自加的上限，不是字节模型的能力上限；BeefTV 现在没有这条限制，按现有证据不需要补。腾讯那边有没有同类合计限制，等原文。

## 5. 待解决问题的回答

**Q1：创作页和后端实际会用到哪些模型？哪些上限写死，哪些能改？**

- 生产清单不在这份仓库里：模型来自渠道目录，由 `capability_config_json` 持久化，前端只读它。代码能确认「会被识别并给默认值」的有：`seedance-2.0` / `-fast` / `-mini`、`seedance-2.5`、`dreamina-seedance-2-0/2-5`、`minimax-h3`、`minimax-h3-max`、`minimax-h3-max-turbo`、`minimax-h3-max-style-*`、`agnes-video-2.5(-flash)`、`grok-imagine-video`、`kling-video-v3`、`wan3.0-video`、novita 视频；图片是 `seedream-5-0-pro/flash`、`seedream-5-0-lite`、`4.5`、`4.0`、即梦图片、Gemini 图片、Grok 图片、`hy-image-v3`、`midjourney-v8.2`、`gpt-image` 系列。
- 写死的：Seedance 2.x 整套素材数字在「生成默认合同」时被强制覆盖（`seedance.go:89`，前端 `model-capabilities.ts:746` 有一份同样副本，两处必须同步改）。
- 能改的：其余模型的数字只是默认初值，渠道保存过的能力 JSON 优先，管理员能在模型能力设置里改。
- 腾讯那条映射在 BeefAPI 侧，BeefTV 这边看到的是同一个公开模型名，所以「按哪份合同校验」取决于 BeefAPI 适配器里的供应商合同 —— 那份合同里的上限数字这次没有本地原文可核。

**Q2：腾讯和火山对同一个模型的数字一致吗？走腾讯按哪一份？**

- 现在只能回答一半：**本机没有腾讯指南的原文，三个版本的参考素材上限一个数字都没有**（证据类型：没有读到；唯一能读到的是二手总结里的「3 图 + 1 视频示例」和对标关系）。
- 所以按哪一份这个决定，等用户提供 Pro / Lite 指南后：以腾讯那三个**版本号**（1.0-pro / 1.5-pro / 1.0-lite）的实际数字为准；两边不一致时取更小的那个，避免客户端放过上游会拒的请求。

**Q3：「三类合计 12 个」官方有没有？** 火山方舟没有（官方原文）；腾讯不知道（本地无原文）；有这条的是 fal 和即梦。

## 6. 没核到的（不猜）

- 腾讯 WAND-Vega 1.0-pro / 1.5-pro / 1.0-lite 的参考图、参考视频、参考音频数量上限、单段与总时长、文件大小、有没有合计限制——**本地没有留存原文**，待用户从企业微信群的指南确认。这是本次最大的空缺。
- Gemini 图片（代码里通用默认 16 张）、Grok 图片、Agnes 图片与视频、hy-image-v3、midjourney：不在这次两份文档范围内，没有读各自的官方文档。
- 火山方舟即梦图片（代码 14 张）、火山方舟通用视频里 Seedance 1.0 pro 以外的老模型：没有逐条读对应模型页。
- 火山方舟「使用限制」独立页：2.0 教程里只有「参见 使用限制」的跳转，锚点没展开正文，所以 2.0 的单段时长 / 大小取自「创建视频生成任务 API」页（两页数值一致，但不是同一页）。

## 7. 建议（本次不改代码）

1. 把 BeefAPI / `openai-videos` 线路的 Seedance 参考音频下限从 1.8 秒统一到 2 秒（`seedance.go:34` 与 `model-capabilities.ts:758` 两处）。
2. 火山通用视频协议不要无条件给 3 视频 / 3 音频：至少对 Seedance 1.0 系列退回「只有首帧 / 尾帧」。
3. Seedance 输出时长下限和官方对齐到 4 秒，或明确记录「接受 1 秒由上游归一」的理由。
4. `full-video` 协议里视频 200MB / 音频 15MB 被写成 100MB，核对真实上游后改成一致。
5. 腾讯三个映射的上限，等拿到 Pro / Lite 指南原文后单独补一版；在补上之前，腾讯渠道的能力值按最小安全值配置，不要按字节的 9/3/3 或 30/10/10 假设上游接受。

## 附录 A：第一版曾读过的腾讯云公开页面（不作结论依据）

第一版为了回答「腾讯文档怎么写的」打开了腾讯云官网页面。用户已指出公开页面和供应商群里的指南可能不是一回事，所以这里只留一条备忘，避免以后重复搜；**这些内容不参与本报告任何结论**。

- https://cloud.tencent.com/document/product/266/126239 《创建 AIGC 生视频任务》：ModelName 取值里列的是 Kling / Vidu / Hailuo / Hunyuan / Mingmou / GV / OS / PixVerse，没有 Seedance；页面写「关于模型某个版本是否支持参考图片/视频/声音…可向我们索取文档或者参考原厂文档信息」。
- https://cloud.tencent.com/document/product/266/124474 《AI 生视频》产品功能页：只讲文生 / 图生和 5–10 秒，没有逐模型素材数量。
- https://cloud.tencent.com/document/product/266/126240 《创建 AIGC 生图任务》：写了逐模型参考图数量（GG 3.0 / 3.1 各 14 张、Hunyuan 3.0 3 张等），名字和我们现在主用的 Seedream / gpt-image 对不上。
- 这些页面对应的产品是 VOD AIGC 的公开接口，和我们企业站走的 `vod/wand-vega-video/*` 是不是同一套参数，公开页面上看不出来，所以不能拿来当腾讯指南的替代。