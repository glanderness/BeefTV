# 剪辑导出：当前调用方与规划分叉

本页记录 2026-10 剪辑/导出切片之后的**实际调用关系**。前端已经抽出 `TimelineRenderPlan` 执行层，这不等于生产 native 与 wasm 已统一执行。

## 生产调用方

| 路径 | 规划 | 执行 | 说明 |
| --- | --- | --- | --- |
| 编辑器远程导出 `web/src/lib/plugins/builtin/editor/editor-export.tsx` → `renderRemote` | Go `backend/internal/app/timeline_render_plan.go` `buildRenderPlan` | Go `backend/internal/app/task_render.go` `processTimelineRender`（本机 ffmpeg 二进制，一条 `filter_complex`） | 生产主路径。前端只提交 `createTimelineRenderTask`，不跑 TS engine。 |
| 编辑器离线降级 `editor-export.tsx` → `exportLocalMp4` | TS `web/src/lib/timeline/timeline-to-ffmpeg.ts` `buildTimelineRenderPlan` | TS `timeline-export.ts` `exportTimelineToMp4`：每次导出 **new FFmpeg()** wasm worker，再交给 `executeTimelineRenderPlan` | 无后端/离线时用。取消 `terminate()` 自己的 worker，不经过画布 merge 租约。 |
| 画布时间线成片 `web/src/components/canvas/canvas-timeline-dialog.tsx` `runExport` | 同上 TS `buildTimelineRenderPlan` | 同上 wasm `exportTimelineToMp4` | 生成画布新片段。 |
| 画布合并/裁切/提音 `canvas-video-merge.ts`、`canvas-video-segment.ts` | 无 TimelineRenderPlan | `canvas-ffmpeg-session.ts` 串行租约 + ffmpeg.wasm | 与时间线导出走两套 wasm 生命周期。 |

生产前端**没有** native spawn engine。`warmFFmpeg` / `loadFFmpeg` 只给画布媒体工具预热 idle worker，不能当作执行入口。

## 仅测试存在的 native 执行

`web/test/timeline-ffmpeg-native.test.ts` 的 `createNativeEngine` 用 `spawnSync("ffmpeg")` 跑 `executeTimelineRenderPlan`。默认 `BEEFTV_NATIVE_FFMPEG_TEST!==1` 时 skip，避免无编码器假绿。

这是 fixture 对齐，不是生产集成：桌面/后端任务仍走 `task_render.go`，不会 import TS engine，也不会跑这个 native adapter。

浏览器真实 worker 夹具：`web/test/timeline-worker.browser.test.ts`（时间线 wasm，每导出独立 worker）、`web/test/canvas-ffmpeg-session.browser.test.ts`（画布 merge 租约）。均需 `BEEFTV_BROWSER_WORKER_TEST=1`。

## 下一阶段仍未收口的 Go / TS 规划分叉

两边都从 `TimelineProject` 快照出发，数据流口头一致（trim → 空隙黑场 → concat → 独立音轨 → 字幕），实现不是同一份计划：

1. **命令形态**：Go `buildRenderFFmpegArgs` 一次 `filter_complex`（每段视频/音频输入 `2i` / `2i+1`，空隙 lavfi，独立音轨 `amix`，`subtitles=filename=render-subtitles.srt`）。TS 逐步写中间文件：`trim` / `gap` / `concat` / `mix` / `burn`。
2. **Seek**：Go 视频段用输入 `-ss`（`-ss` 在 `-i` 前）。TS trim 把 `-ss` 放在 `-i` 之后做输出 seek 并重编码。
3. **字幕**：Go 烧 SRT + libass。TS 生产 wasm 路径先 `rasterizeTimelineSubtitle` 成 PNG 再 overlay；无 `subtitleImages` 时才走 `subtitles=` + libass。`isSubtitleFontFailure` 与 Go `renderSubtitleFontFailure` 对齐的是失败语义，不是同一条滤镜。
4. **图片片段**：Go 支持 `image`（`-loop 1`）。TS `buildTimelineRenderPlan` 只接受 video/audio/subtitle，其它 kind 直接抛错。
5. **执行面**：生产 backend = Go 计划 + 本机 ffmpeg。生产 frontend = TS 计划 + wasm。Native TS engine 只出现在测试。

下一阶段若要统一执行，需要单独的集成切片：让 backend 消费同一份计划（或明确适配层），并规定以哪一侧的 seek/字幕/图片语义为准。在那之前不要把 fixture 通过写成生产 native/wasm 已合流。

## 画布 FFmpeg 租约（本切片）

`mergeVideos` / `trimVideoSegment` / `cropVideo` / `extractVideoAudio` / `removeAudioFromVideo` 全部经过 `withFFmpegLease`。队列串行，同一时刻只有一个执行中的 MEMFS。取消排队中的任务立即拒绝，不 `terminate` 正在跑的 worker；取消执行中的租约只终止该 worker，不回收进 idle。`warmFFmpeg` 可以预热 1 个 idle；执行中再 warm 会另起 idle，不会把正在跑的文件系统借给第二个 owner。

时间线 `exportTimelineToMp4` 仍各自 `new FFmpeg()`，不进入该租约。
