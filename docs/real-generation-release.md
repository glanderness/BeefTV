# 每次桌面发版的真实生成验收

发布人必须在候选版本的真实客户端完成下表，连续两轮全部成功后才发布。CI、mock、HTTP 200、直接请求供应商以及旧版本结果不能代替客户端验收。失败先定位并修复；候选代码变化后重新核对受影响路径，再完成两轮最终验收。

| 固定路径 | 输入 | 默认模型与规格 |
| --- | --- | --- |
| text-image 文生图 | 只有提示词 | 当前目录的 Image 2.5，最低可选画质，1 张 |
| image-image 图生图 | 提示词、image-1.jpg | 同上 |
| image-video 图生视频 | 提示词、image-1.jpg | Seedance 2.0 Fast，480p，16:9，5 秒 |
| text-video 文生视频 | 只有提示词 | 同上 |
| video-video 视频生视频 | 提示词、reference.mp4 | 同上，参考生成模式 |
| multi-video 多素材生视频 | 提示词、2 张图、1 段视频 | 同上，参考生成模式 |

## 固定网络素材

使用 Blender Foundation 广泛传播的《Big Buck Bunny》，来源 [官方下载](https://peach.blender.org/download/)，许可 CC BY 3.0，署名 `(c) 2008 Blender Foundation / www.bigbuckbunny.org`。固定下载 `https://download.blender.org/peach/bigbuckbunny_movies/big_buck_bunny_720p_h264.mov.zip`，不跟随每次搜索换素材。

用 ffmpeg 从 60 秒和 63 秒各导出一张 JPEG，保留 1280×720；从 60 秒截取 3 秒视频，960×540、24 FPS、H.264、yuv420p、无音轨、MP4 faststart。保存源文件和三个素材的 SHA256、尺寸、时长、字节数，校验值变更需重新登记。发布证据使用同一组素材校验值。视频生成关闭音频，以固定图像/视频通路；音频功能有改动的版本另加音频专项真实测试。

2026-10-01 固定素材 SHA256：源 ZIP `b0c9ade80b086179feee41514929de583966eec87c703575d97f051f88b33b67`；image-1.jpg `93701f45cf50d48de5ba452cd26eeafeba40a2fceef2e50fb98940ccb919250f`；image-2.jpg `5946874132e3e82d7c1ed74db2a97e39b08f58ba7dc3fa9129adffcdd714af84`；reference.mp4 `282ef9563a8dbad86470368bef7afa9fcfd1df7791cf38f4f5e803c9d535da60`。

固定提示词：纯文字使用“清晨的森林里，一只白色兔子慢慢转头，柔和阳光，平稳镜头，无字幕”；有参考图使用“保持参考图的白色兔子外形与森林环境，兔子慢慢转头，柔和阳光，无字幕”；有参考视频使用“参考视频中的运动节奏，保持白色兔子与森林环境，平稳镜头，无字幕”。两轮保持相同参数，不使用第一轮产物替换输入。

## 执行和记录

v1.6.18 的发布人收到 Owner 于 2026-10-01 明确指示“没事 这轮就不用实测了”，因此仅该版本豁免剩余真实生成矩阵。记录已发生费用、Windows 原生断连回归及独立 review；不记为十二条实测通过，后续版本仍执行下列门禁。

v1.6.19 在发布人说明“允许前台完成验收”与“本版豁免付费生成矩阵”两种选择后，Owner 指示“发布吧”，按直接发布处理，仅该版本豁免剩余矩阵。保留已发生的文生图实测、结算、本地发布检查、错误回归和独立 review 记录，不记为十二条实测通过，也不延续到后续版本。

1. 检查当前模型目录、对应价格、测试账号余额和本次授权预算。预算只对本次有效；先计入本次已有诊断费用和全部未结算预扣。每次提交前保留预计最大费用余量；超预算或价格不确定时不提交。
2. 备份现有数据库，在旧数据副本或已备份的真实客户端验证升级。覆盖正式旧版 v2、预览版 v3/v6 编号占用、已有项目和任务保留，以及新任务确实可入库。
3. 冻结候选代码并构建；通过客户端画布导入固定素材、选择模型与参数，逐条点击生成。每次提交立即记录本地 task ID，避免盲重试产生重复扣款。
4. 同一任务追踪到供应商完成、客户端下载、画布落图/落视频。打开图片；播放视频并核对时长、解码和画面。保留任务详情、画布截图、产物 SHA256、实际模型与参数、请求 ID、执行诊断和时间。
5. 在生产只读账单核对每笔 task/request 的最终结算或退款。失败不计成功，超时先查询原任务；不得为凑成功率隐藏失败或不断重发。保存所有尝试及费用，两轮成功矩阵单独标明。
6. 将脱敏证据写入 `docs/release-evidence/<VERSION>.json`。`sourceDigest` 来自提交候选代码后运行 `node scripts/verify-real-generation-release.mjs --fingerprint`。证据文件不进入摘要，因此可在后续提交加入；任何打包源码变化都使旧证据失效。
7. 本地及发布 workflow 必须通过 `node scripts/verify-real-generation-release.mjs`，再合入 main 并触发发布。发布后核对三平台产物、签名更新源和真实安装/升级；不能用发布前构建冒充已发布二进制。

JSON 顶层字段为 `version, sourceDigest, budgetCNY, spentCNY, pendingCNY, upgrade, cases`。每个 case 保存 `round, path, taskId, providerRequestId, clientVersion, platform, fixtureDigest, model, status, clientSubmitted, canvasVerified, mediaDecoded, mediaOpened, billing, costCNY, artifactSHA256`。记录中禁止凭据、签名素材 URL 或私有提示词。证据真实性由发布人逐项核验；脚本负责完整性与版本绑定。
