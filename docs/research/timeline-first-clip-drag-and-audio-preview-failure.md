# 剪辑（多轨时间线）：首个素材不能播放、不能拖拽 —— 根因与修复

报障来源：2026-10-27 大圆日报，客户「小马哥 @交流群」10-26 16:57 反馈剪辑模块首个素材不能播放、素材位置不能拖拽，界面提示「音频预览未能播放，请重新打开剪辑后重试」。需求表行 `reczz28SFuiwD5Z7`（附件为客户截图：标题「多轨时间线」，视频轨两个片段首尾紧贴，音频轨 `音色1.0.m4a`，播放头 00:01.3）。

涉及模块：画布节点工具栏「进入剪辑」打开的弹窗，即 `web/src/components/canvas/canvas-timeline-dialog.tsx`（标题「多轨时间线」）；预览播放由 `web/src/hooks/use-timeline-preview-playback.ts` 驱动；落位算法在 `web/src/lib/timeline/timeline-placement.ts`。与插件式「剪辑工作台」（`web/src/lib/plugins/builtin/editor/`）不是同一套时钟，已排除。

## 一、结论

1. **两个问题是两个独立原因，不是同源。**
   - 「不能拖拽」是拖拽落位算法的问题：同轨碰撞即静默丢弃，而首个片段的右侧紧贴第二段，任何向右的位移都判定为重叠，于是它完全动不了（同轨任何被两侧夹住的片段都一样）。
   - 「不能播放」是错误处理粒度的问题：任意一条音轨的素材载入失败都会走 `fail()`，暂停全部媒体并提示「请重新打开剪辑后重试」。用户看到的是整条时间线一个素材都播不了，而重开剪辑并不能修复素材本身。
2. **「照搬上游 Infinite Canvas」在本模块不适用。** 上游 `basketikun/infinite-canvas` 没有多轨时间线模块（`web/src` 内没有时间线相关文件）；本模块的 `timeline-placement.ts` / `timeline-snap.ts` 注释写明移植自 `lingji-cut`，该代码库不在本仓库。
3. **修复不加任何新按钮或设置项**：拖拽改为「同轨被压到的片段沿拖动方向让位」，播放改为「素材载入失败的片段被跳过，其余轨道继续播放，并在预览区点名失败片段」。

## 二、复现与验证环境

- 隔离后端：`backend/cmd/server` 编译后以 `CANVAS_OFFICIAL_PLUGIN_DIR=<repo>/plugin-packages CANVAS_BACKEND_DATA_DIR=/tmp/ws-repro/data CANVAS_BACKEND_ADDR=127.0.0.1:18099` 启动（缺 `CANVAS_OFFICIAL_PLUGIN_DIR` 会因找不到官方插件目录退出）。
- 前端：`VITE_CANVAS_BACKEND_URL=http://127.0.0.1:18099/api VITE_CANVAS_LOCAL_MODE=true bun run dev`（端口 3000）。
- 合成素材：ffmpeg 生成 `clip1.mp4`(4040ms)、`clip2.mp4`(4000ms)、`voice.m4a`、`voice2.m4a`，经 `PUT /api/assets/<id>` + `PUT /api/canvas-projects/<id>` 建两个画布工程：
  - `repro-timeline`：视频轨两段首尾紧贴（0~4.04s、4.04~8.04s）+ 音频轨一段。
  - `repro-broken`：同上，但音频资源文件被移走，`GET /api/resources/<id>/file` 返回 500。
- 实机操作走 ego-browser（真实浏览器，非 Playwright）；项目自带回归用例走 `web/test/` 下的 Playwright 夹具。

## 三、问题一：首个素材不能拖拽

### 根因

`canvas-timeline-dialog.tsx` 的 `moveClip()` 先用 `canPlaceAt()` 做同轨碰撞检测，`ok === false` 时**直接 return，不提示也不落位**。`canPlaceAt()` 的判定是任何同轨重叠即失败，于是：

- 首个片段 `[0, 4040)`，第二段 `[4040, 8040)`，首尾紧贴；
- 向右拖动 `d > 0` 时 `candidate = [d, d+4040)` 与第二段重叠（`other.startMs(4040) < d + 4040` 对任意 `d > 0` 成立）→ 每次 `pointermove` 都被丢弃；
- 向左被 `Math.max(0, …)` 钳在 0。

结果就是「第一个素材完全拖不动」，而第二个片段（右侧无邻居）能正常拖动——与客户描述完全一致。

实机复现（修复前，`repro-timeline`，从片段中心水平拖 160px）：`clip-vidA` left `0px → 0px`（不动），`clip-vidB` left `388px → 548px`（正常）。

### 修复

新增纯函数 `planClipMove()`（`timeline-placement.ts`）：拖动时把被压到的同轨片段沿拖动方向顺次推开，返回需要改动的片段起点映射；向左让位会越过 0 时返回 `null`，由调用方丢弃本次位移。`moveClip()` 改为调用它，并像裁剪那样**基于拖动起点快照**计算（快照同时用于吸附），保证整次拖动结果确定、不随帧叠加漂移。

`planClipMove()` 的调用约定（已写进函数注释）：返回值只描述「以快照为基准」的这一次拖动，调用方必须按快照重建整条轨道——未出现在返回值里的同轨片段要回到快照位置。只更新返回值涉及的片段会留下上一帧被推开的片段（见第七节）。

保持的不变量：同轨永不重叠（导出与预览的顺序假设不被破坏）。让位是单向的，不自动回填空白——时间线允许留白，自动回填会抹掉用户刻意留的间隙。

### 验证

- 单测 `web/test/timeline-placement.test.ts`（6 项）：首尾紧贴时向右让位、级联让位后逐段不重叠、向左空间不足返回 `null`、向左有空隙照常让位、不跨越轨道、零位移只返回自身。
- 浏览器用例 `web/test/timeline-ui.browser.test.ts` 新增 `canvas-drag` 夹具：首段右拖 120px → 首段 120px、次段 384→504px；拖回 0 → 首段 0px（次段留在新位置）；再向左拖次段无空间时两者保持原位；同一手势内连续拖动两条（见第七节）。
- 实机复核（修复后，同样拖 160px）：`clip-vidA` `0px → 160px`，`clip-vidB` `388px → 548px`。

## 四、问题二：音频预览未能播放

### 根因

`use-timeline-preview-playback.ts` 里，单条音轨的失败是**全局致命**的：

- `reconcileAudio()` 的 `failed()`：`record.error = true` 后若该片段处于播放头位置且未静音，调用 `fail("音轨预览未能播放，请重新打开剪辑后重试。")`；
- `apply()` 每次同步都会对 `record.error` 再判一次并 `fail()`；
- `fail()` 会 `pause()` **全部**音频元素与视频元素、`onRequestPause()` 停止播放，并只留一条提示。

`fail()` 的原始目的是让时钟跳出「素材永远不就绪」的缓冲死锁（`ready()` 要求活跃片段 `readyState >= 2`，坏素材永远不满足）。但它把「一个素材坏了」升级成「整条时间线不能播放」，而且提示是「重新打开剪辑后重试」——素材地址本身的问题重开也不会好。

触发路径（代码层面）：音轨元素的 `src` 由 `sourceUrl()` 解析，先走 `cacheResourceObjectUrl()`（带鉴权的 blob 下载），失败后 `resolveMediaUrl()` 再回退到**裸** `/api/resources/<id>/file`；原生媒体元素无法附带桌面启动令牌，一旦回退发生，元素就会以 `MEDIA_ERR_SRC_NOT_SUPPORTED (4)` 失败。素材只存在于本机（`pendingRemoteUpload` 的页面级 objectURL 在重启后失效）或资源缓存下载失败时，都会落到这条路径。

实机复现（修复前，`repro-broken`）：音频元素 `error.code = 4`、`readyState 0`，点播放后弹出「音轨预览未能播放，请重新打开剪辑后重试。」，播放头停在 `00:00.0`、视频 `paused: true` —— 一条音轨失败拖死整段预览。

### 修复

把「素材载入失败」降级为**片段级**处理，保留跳出缓冲的能力：

- 失败片段记入 `failedVideoClips` / `AudioRecord.error`，并在 `ready()`、`prepared()` 的就绪门槛里跳过——时钟因此继续前进，不会卡在缓冲；
- `apply()` 遇到失败片段只 `pause()` 它自己，不再 `pause()` 全部媒体；视频素材失败同样只跳过画面（换到新地址后浏览器清空 `error`，就绪门槛自动恢复）；
- 新增 `reportClipFailure()`：仅当该片段处于播放头位置时，用一次内联提示点名失败片段（`音轨「<标题>」未能载入，已跳过该片段，其他轨道继续播放。`），不改变播放状态；静音抑制只对音频片段生效（视频轨静音只是关掉声音，画面被跳过仍要提示），并且每次起播都会重置已报告集合（见第七节）；
- `fail()` 保留给真正的全局失败（`play()` 被浏览器策略拒绝、片段音量 > 100%），这两类仍然暂停全部并提示重试。

### 验证

- 浏览器用例 `web/test/timeline-preview-playback.browser.test.ts`：`voice.wav` 404 时改为断言「提示点名 voice + `playing` 仍为 true + 失败音轨暂停 + 另一条音轨继续播 + 视频继续前进」；新增视频 404 用例（跳过画面、音轨与时钟继续、`video.error === 4`）；新增「静音视频轨失败仍有提示」与「再次播放重新提示」用例；保留 `play()` 被拒绝时暂停全部的原有用例。
- 实机复核（修复后，`repro-broken`）：播放头 `00:00.0 → 00:01.2`、视频 `currentTime 2.1` 且未暂停、按钮仍为「暂停预览」，内联提示为「音轨「音色2.0.m4a」未能载入，已跳过该片段，其他轨道继续播放。」

## 五、未确证部分（不要当成已确认）

1. **客户机上音频载入失败的**具体**原因未在客户环境验证**，本地是用「资源接口 500」等价复现的。上面第四节给出的触发路径是代码推断，不是现场证据。若客户再次反馈，建议收集：该音频素材在素材库中能否单独播放、是否重启过客户端、`资源接口返回码`。
2. **桌面（Wails 打包）环境下裸资源 URL 是否可用未验证**：`backend/cmd/desktop/app.go` 会给所有 `/api` 请求注入 `X-Desktop-Token`，因此经 Wails 资源服务器的原生媒体请求可能仍然可用；本次修复不依赖这一点（失败即降级），但「回退裸 URL」这条策略本身是否还有必要收紧，需要在打包后的应用里单独确认。

## 六、验证命令与结果

```bash
cd web && bun run typecheck                 # 通过
cd web && bun test test/timeline-placement.test.ts                    # 6 pass
cd web && bun test test/timeline-ui.browser.test.ts                   # 6 pass
cd web && bun test test/timeline-preview-playback.browser.test.ts     # 12 pass
```

另外跑了 20 个 timeline/editor 相关既有用例文件（`canvas-timeline-*`、`editor-*`、`timeline-*`、`director-placement`、`director-timeline-visibility`），结果 `164 pass / 3 skip / 0 fail`。行为口径变更的两条既有用例（原「音轨加载失败暂停所有播放器」及其静音变体）已按新行为改写，改写原因见第四节。

## 七、独立检查（Codex）反馈与修复

独立检查给出三条 blocking，均已修复并补上可失败的回归用例（每条都在修复前的代码上跑过，确认会失败）。

### 1. 同一手势内连续拖动会让同轨片段重叠

`moveClip()` 原来只更新 `planClipMove()` 返回值里出现的片段，上一帧被推开的片段会留在它当时的位置。示例：同一手势里先拖到 1000ms（第二段被推到 5250ms），再拖到 8000ms（最后一帧不再与快照里的第二段碰撞，于是它没进返回值）——第二段就停在 5250ms，与 `[8000, 12040)` 重叠。

修复：每帧都按拖动起点快照重建整条轨道（快照里没有的片段保持不动），并在 `planClipMove()` 的注释里写明这条调用约定。

回归用例（`web/test/timeline-ui.browser.test.ts`，同一手势多个落点）：

- 先拖到 1250ms 再拖回 0 → 第二段必须回到 4000ms。修复前实跑：第二段停在 `414px`（修复后为 `384px`）。
- 先拖到 1000ms 再拖到 8000ms（越过被推开的第二段）→ 第二段必须回到 4000ms。修复前实跑：第二段停在 `984px`（`10250ms`，与首段 `8000~12040` 重叠）；修复后为 `384px`，首段落在 `768px`，首尾紧贴无重叠。

夹具补充：`canvas-drag` 模式现在会随页面注入片段定位需要的几个工具类（`.absolute`/`.top-1`/`.h-[calc(100%-8px)]`/裁剪把手等）。夹具本身不加载 Tailwind，片段只是竖直堆叠，指针一旦离开片段盒或 DOM 顺序翻转就会落到别的片段上，无法稳定复现「同一手势多落点」的场景。

实机复核（修复后，ego-browser，`repro-timeline`，同一手势内先拖 96px 再拖 672px）：中途第二段被推到 `484px`，松手后回到快照位置 `388px`；首段落在 `772px`（`8040ms`，吸附到第二段末尾，首尾紧贴无重叠，面板显示「起点 8040 / 时长 4040」）。截图：`修复后-连续拖动首个片段相邻片段回到原位不重叠.png`。连续向左拖动且左侧没有空间时本次位移整体丢弃，两段都保持原位（截图：`修复后-连续向左拖动左侧无空间时保持原位.png`）。

### 2. 再次播放时不再提示被跳过的片段

`reportClipFailure()` 用 `reportedClips` 去重，但集合只在实例里累积：预览按钮会先清空界面提示，第二次播放时失败片段被静默跳过，用户看不到任何说明。

修复：`update()` 里每次（重新）起播都 `reportedClips.clear()`；素材地址变化（`reconcileAudio()` 重建音频元素、视频元素换源）时也清掉该片段的记录，新地址再失败仍会提示。

回归用例（`web/test/timeline-preview-playback.browser.test.ts`「a failed clip is reported again on the next play」）：播放 → 出现点名 `voice` 的提示 → 暂停（提示被清空）→ 再播放 → 提示必须再次出现。修复前实跑：第二次播放等到超时也没有提示（`waiting for getByRole('alert') to be visible`）；修复后通过。

### 3. 静音视频轨失败被无提示跳过

静音抑制原先写在各调用点，连视频轨一起抑制；视频轨静音只是关掉声音，画面被跳过仍然必须告知。

修复：静音抑制只留在 `reportClipFailure()` 内部、且只对音频片段生效（`clip.kind === "audio"`）；`apply()` 失败分支与 `syncVideoMetadata()` 改为无条件调用 `reportClipFailure()`。

回归用例（同文件「a muted video track failing still reports the skipped picture」）：`muteVideo(true)` 后播放、`video.mp4` 404 → 仍要出现含「视频」的提示，且 `playing` 为 true、另一条音轨继续播。修复前实跑：等不到提示（静音抑制把提示吃掉了）；修复后通过。静音音频的行为不变，仍由既有用例「a muted track failing after playback starts does not stop other media」覆盖（静音期间不提示，取消静音后提示）。
