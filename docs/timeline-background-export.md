# 时间线后台导出

状态：已完成独立设计审查并收敛修订，按下述合同实现。

## 现状与目标

变更前，画布剪辑窗口调用 `exportTimelineToMp4`，浏览器 Worker 持有执行；关闭窗口中止该执行。后端已有 `POST /timeline/renders`、持久化任务、FFmpeg 渲染与资源结果，`local-executor-session.ts` 已定义提交幂等键、观察取消与画布归属。此次将窗口接入该已有任务入口，不增加数据库/API，也不修改助手、浏览器信任或权限。

目标是后端拥有渲染任务，窗口只拥有进度观察和用户请求的结果交付。关闭后已接收任务继续，任务中心能查询和下载；关闭整个后端进程不等于只关闭窗口，不承诺进程退出后继续计算。独立 PR 以 main 为基线，纳入 Docker 最小依赖 `ffmpeg fontconfig font-noto-cjk`，不依赖其他待合并 PR；Node/助手宿主仍由专门的 Docker PR 提供。

提交沿用主线可信桌面 UI 的写入授权。镜像具有渲染工具不代表普通浏览器已获创建任务的权限；浏览器部署的信任策略不在本次范围内，HTTP 生命周期测试中的可信身份边界不能作为真实浏览器授权验收。

## 输入与资源合同

`prepareTimelineRenderSnapshot(draft, nodes)` 创建独立的规范化时间线快照，保留输出规格、轨道可见性/静音、剪辑位置、裁剪、淡入淡出、音量及字幕。可见媒体优先使用 `clip.directMedia`，其次取节点引用；转换成 `resource:<id>`，不读取 Blob、不上传副本、不改草稿。没有资源标识时明确要求先保存素材；资源存在性、归属、就绪与媒体合法性由已有后端验证。不添加尺寸或模型预检规则。

提交幂等键以画布 ID、时间线节点 ID、交付方式及冻结快照为输入身份。同一窗口中提交结果未知、输入未改的重试复用 key；明确拒绝、已知任务后的新点击按新意图处理。关闭窗口不自动重试；提交中的断线可能已创建任务，应到任务中心确认。再次打开窗口不自动下载或添加节点，重新点击是明确的新导出意图。

窗口新增必填 `canvasId`，由页面现有 `projectId`（画布 ID）传入；提交后端字段仍为既有 `projectId: canvasId`。`linkedProjectId` 是业务项目，仅用于已有资产关联，不可拿来代替画布归属。

## 窗口与任务生命周期

`useCanvasTimelineExport` 管理本窗口的 `idle -> submitting -> observing -> delivering -> idle` 状态，内部 Run 对象持有 AbortController、冻结标题/输入、task ID 和取消标记。UI 只收到状态及命令，不暴露可写 ref/controller。

- 双击启动：Run 在第一次 await 前登记，同一窗口只允许一个观察/交付操作。
- 关闭、卸载、切换画布或切换时间线节点：使 Run 失效并 abort 观察，绝不调用后台 cancel；旧异步回调须同时核对 Run 身份、当前画布/节点、open 和 signal，不能清除新 Run 状态或向新目标写入。
- 已收到任务 ID 后的“取消导出”：先停用结果交付，再只对捕获的 task ID 调用 `cancelGenerationTask`。取消失败明确提示后台可能仍运行，不伪报取消成功。提交尚无 ID 时不能声称取消后台，关闭仅停止等待。
- 仅当取消响应任务 `status === "cancelled"` 才提示已取消。HTTP 400 等失败或 2xx/succeeded（可能表示暂停结果交付）均不得称已取消；本窗口仍抑制自动交付并提示任务中心确认/下载。不改变公共取消 API，不把本地 abort 或广播事件当作后端取消凭据。
- 正在交付：普通关闭/取消按钮禁用。路由卸载仍使观察失效；已经交给系统的保存对话框不承诺撤销，不触发后续节点写入或旧窗口提示。
- 关闭再打开：新窗口可提交新意图，旧窗口只通过任务中心继续。没有浏览器级持久观察器或隐藏自动交付。
- 观察/交付失败：真实错误提示和任务中心取回路径；不自动重新生成、不把失败变成成功。

沿用 `runOwnedTimelineRender` 的既有提交、观察、成功结果解析和画布校验。Run 身份另外防止同画布换节点/关窗重开时旧 finally 覆盖新状态。单窗口尚未收到创建回执时因 abort 结束，不将其当成确定的服务端拒绝。

## 结果交付

下载调用已有 `downloadOwnedOrBrowserMedia({resourceId, browserUrl, fileName})`，桌面与浏览器沿用各自保存入口。

“生成新片段”只用 `getResource(result.resourceId, {signal})` 读取资源描述，要求 ready video；回调改为 `onCreateAssembledNode(resource: RemoteResource, title: string, signal: AbortSignal)`。新的 `useCanvasAssembledNode` 承担尺寸/位置和节点构造，复用画布既有 owner guard、选择及 `persistMediaNode`。从 `use-canvas-upload.ts` 移走旧 Blob 合成上传职责，并移除唯一调用面的 Blob 合同。

节点直接保存后端资源的 storageKey、内容 URL、尺寸、时长和类型，不通过 `uploadMediaFile` 重传。插入前核对画布/挂载及调用方 signal，项目资产持久化沿用现有可观察的失败/待重试语义；提示只说明已添加节点，不冒充已完成服务端画布保存。

具体映射：描述 `id` 必须等于结果 `resourceId`，且 `status=ready / kind=video`；`metadata.storageKey=resourceStorageKey(resource.id)`、`content=resourceFileUrl(resource.id)`、`bytes=resource.size`、`naturalWidth/Height=resource.width/height`，保留 `durationMs/mimeType`。显示宽高使用既有 fitNodeSize；不把 objectKey 当 storageKey，不依赖 publicUrl 非空，不伪造 hasAudio。下载同样传 `resourceFileUrl(result.resourceId)` 作为 browserUrl。插入已发生后卸载不回滚节点或删除后台资源，但不得把晚到的回执写入新目标。

## 任务中心取回入口

主线通用结果预览递归收集 URL，不能直接识别时间线 `resourceId`，也没有显式下载按钮。因此必须把 `TaskResultMedia` 从任务页移到页面私有 `task-result-media.tsx`，为 `timeline_render` 增加明确的 ready 结果分支：仅成功任务按规范的顶层 `resourceId` 生成 `resourceFileUrl` 视频预览，并通过已有 `downloadOwnedOrBrowserMedia` 提供“下载成片”。不递归猜测时间线 `fileName` 为 URL，也不调用模型生成/重试入口。其他任务的既有预览算法原样保留。

`timeline-tasks.ts` 提供结果解码函数，供既有 owned render 和任务中心共用，验证 JSON 及非空字符串 resourceId；不引入兼容结果协议。HTTP 资源接口继续验证归属，前端不存额外资源副本。测试应直接打开任务中心结果组件并验证标准结果预览/下载、文件名不当 URL、损坏结果无伪下载入口。

## 验收与取舍

- 冻结快照行为：裁剪/音频/字幕/输出不丢失，directMedia 优先，隐藏轨道不要求有效资源，源节点之后变化不修改提交。
- 浏览器真实入口 + HTTP 边界：只提交一次；关闭不发 cancel；显式取消命中原 ID；取消与成功竞态不得交付；取消失败提示；切换目标/快速重开不能污染新 Run；结果生成节点只 GET 描述不上传字节。
- 保留现有 Worker 引擎与独立引擎测试，改造画布窗口测试为后台入口。补真实后端任务/原生 FFmpeg 验证，覆盖持久结果、声音和中文字幕；区分 HTTP 假上游的 UI 生命周期验证与原生渲染验证。
- 前端 typecheck、相关行为测试、structure-budget、deadcode-budget；不调高结构预算。无付费模型调用、生产部署或权限修改。

后台执行要求素材已保存为后端资源，因此纯浏览器未同步素材会明确失败。这是资源传输合同，不回退到另一套浏览器渲染。后台受理后无法仅靠关闭窗口取消，是本次有意改变的资源所有权，故实现前做独立设计审查。

## 审查记录

审查发现并已收敛：任务中心缺少标准资源结果下载入口；画布 ID 与业务项目 ID 必须分开；镜像需要随本改动提供最小渲染依赖；取消须检查返回任务状态；RemoteResource 到节点须显式字段映射。独立审查属于方案审查，运行验证另记在 PR。
