# 剪辑导出：语义计划与执行器

本页记录 2026-10 语义计划切片之后的**实际调用关系**。`internal/editing` 编译版本化语义计划；native 与 wasm 只负责把同一份计划降成不同的 FFmpeg 步骤。测试里的 native spawn adapter 不是生产路径。

## 生产调用方

| 路径 | 语义计划 | 执行 | 说明 |
| --- | --- | --- | --- |
| 编辑器远程导出 `web/src/lib/plugins/builtin/editor/editor-export.tsx` → `renderRemote` | `CreateTimelineRenderTask` 入队后，`task_render.go` `processTimelineRender` 调用 `editing.Compile`（sources=nil，不透明 `resource:` id）→ 授权落盘 → ffprobe → `editing.ApplySourceFacts` | `buildRenderFFmpegArgs`：本机 ffmpeg 一条 `filter_complex` | 生产主路径。前端只提交时间线快照。 |
| 编辑器离线降级 `editor-export.tsx` → `exportLocalMp4`；预览面板 | `POST /api/timeline/render-plan` → `CompileTimelineRenderPlan` → `editing.Compile`（浏览器提交不透明 nodeId 元数据） | `lowerCanonicalPlan` → `exportTimelineToMp4` 每次 **new FFmpeg()** wasm worker → `executeTimelineRenderPlan` | 规划失败必须上抛，不得改走 TS 语义编译。取消 `terminate()` 自己的 worker。 |
| 画布时间线成片 `canvas-timeline-dialog.tsx` `runExport` | 同上 `POST /api/timeline/render-plan` | 同上 wasm | 收集可见视频/图片/音频（含静音音轨），字幕来自返回计划。 |
| 画布合并/裁切/提音 `canvas-video-merge.ts`、`canvas-video-segment.ts` | 无 TimelineRenderPlan | `canvas-ffmpeg-session.ts` 串行租约 + ffmpeg.wasm | 与时间线导出走两套 wasm 生命周期。 |

生产前端**没有** native spawn engine。`warmFFmpeg` / `loadFFmpeg` 只给画布媒体工具预热 idle worker。

`POST /timeline/render-plan` 只读：鉴权 + 限流，不排队、不落盘、不计费，不打开资源，不接受 ffmpeg 参数或本地路径。没有通用“跑一条命令”的接口。

## 语义层 vs 执行器

`editing.Compile` / `editing.Plan`（version=1）拥有：片段选择与顺序、空隙与片尾时长、裁剪起点、时长、静音、音量、淡入淡出、字幕文本/SRT、输出宽高帧率。执行器不得自行挑选或丢弃内容。

两端声明一致的行为：

- 隐藏轨道省略；静音独立音轨留在计划里 `muted=true`，混合时音量 0，源仍要提供。
- 片尾空隙取 `max(project.DurationMs, 所有计入片段的结束点)`，含音频和字幕。
- 无音轨视频在探测后 `hasAudio=false`，空隙/静音段用静音。
- 图片片段保留；重叠视频/图片编译失败。
- 用户输出选项（宽高/帧率/是否烧录字幕）留在计划 `output`。

仅执行器不同：

| | Native（`buildRenderFFmpegArgs`） | Browser wasm（`lowerCanonicalPlan`） |
| --- | --- | --- |
| 命令形态 | 一条 `filter_complex` | 逐步中间文件：trim / gap / concat / mix / burn |
| Seek | 视频段输入 `-ss`（`-ss` 在 `-i` 前） | trim 把 `-ss` 放在 `-i` 之后做输出 seek 并重编码 |
| 字幕 | SRT + libass `subtitles=filename=render-subtitles.srt` | 先按计划字幕栅格化 PNG 再 overlay；无图像时才走 `subtitles=` + libass |
| 源标识 | 授权后的 resource id | 浏览器 nodeId；永远不是本地路径 |

`web/test/timeline-ffmpeg-native.test.ts` 的 `createNativeEngine` 用 `spawnSync("ffmpeg")` 跑 wasm 风格步骤，验证与 Go native 共用 `fixtures/editing/*.plan.json`。默认 `BEEFTV_NATIVE_FFMPEG_TEST!==1` 时 skip。这不是生产集成：桌面任务仍走 `task_render.go`。

浏览器真实 worker 夹具：`web/test/timeline-worker.browser.test.ts`（mock `/api/timeline/render-plan` 返回同一份 six-second-mix 计划）。需 `BEEFTV_BROWSER_WORKER_TEST=1`。

## 画布 FFmpeg 租约

`mergeVideos` / `trimVideoSegment` / `cropVideo` / `extractVideoAudio` / `removeAudioFromVideo` 全部经过 `withFFmpegLease`。时间线 `exportTimelineToMp4` 仍各自 `new FFmpeg()`，不进入该租约。
