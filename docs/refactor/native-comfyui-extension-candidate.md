# 原生 ComfyUI 扩展适配候选

本变更关联 #19，并遵循 #39 中「通过扩展机制接入，不作为主程序内置渠道」的方向。贡献内容是可单独验证的协议执行代码；扩展宿主契约仍需讨论。它不注册渠道、插件、HTTP 路由、MCP 工具或设置入口，不代表用户安装主程序后已经能选择 ComfyUI。

另有 #173 提供完整模型服务接入。本候选与其部分协议逻辑重叠，重点提供扩展边界、精确取消及恢复测试供择取复用，不建议并行合入两套原生执行器。最终应按维护者确认的宿主合同收敛。

## 执行边界

```text
未来扩展宿主：校验授权、资源归属、配置、任务与回执
  -> workflow.Client.RunNativeComfy
     -> 读取目标 /object_info，校验节点与枚举
     -> 已归属素材字节 -> /upload/image -> 绑定 API JSON
     -> /prompt -> 持久化 prompt_id -> /history/{prompt_id}
     -> 同源 /view -> 现有媒体结果形状
  -> 宿主登记资源、资产、任务与画布结果
```

`Client` 复用现有 `RequestExecutor`、`MediaLoader`、`Receipt`、`VideoPoller` 端口。运行时不会自行创建 HTTP 客户端、读取任意宿主文件或写数据库。`Request.NoRedirect` 经现有受保护的请求适配器执行；没有设置该标志的既有工作流保持原来的行为。

适配器自身要求 `LocalWorkspace=true`。这只是宿主已校验本地工作区的显式输入，不是完整的扩展授权系统。真正启用执行前，宿主必须校验用户、扩展启用状态、目标服务权限、素材归属和凭据来源。候选代码没有绕开这些要求注册一个可调用入口。

## 配置与能力

候选配置使用 `workflow.Config.ComfyUI`，包含 API JSON `graph`、`fields`、`outputNodeId` 和 `outputField`。`comfyui-image`、`comfyui-video`、`comfyui-audio` 目前只是候选适配器内部的模式值，不加入主程序模型枚举或渠道准入。

图最多 500 个节点。只覆盖显式映射的标量输入，保留原图和连线。支持提示词、负向提示词、seed、图片、视频、音频及独立 mask 映射；保存节点可以从 `images`、`gifs`、`videos`、`audio` 返回文件。实际媒体类型按下载内容与 MIME 判断，以支持 SaveVideo 将 MP4 放入 `images` 的响应。

`InspectNativeComfy` 只读查询 `/system_stats` 与 `/object_info`。`QueryNativeComfy` 只查询原 prompt 和取回结果，不重新提交。`RunNativeComfy` 带已知 `ResumedRequestID` 时跳过 schema 发现、素材上传和 `/prompt`。

## 请求、资源与取消

- 服务地址沿用 `outbound` 的私网策略，不修改全局 SSRF 设置。要求完整 HTTP(S) origin，拒绝用户信息、查询参数、路径和重定向；鉴权支持无鉴权、Bearer 和自定义头。
- 素材来自宿主已校验的字节，不能把本机路径、资源 ID 或公网链接直接塞进 loader。ComfyUI 的通用 `/upload/image` 接收实际 multipart 文件，返回的文件名再绑定到图。
- 每个上传输入最多 128 MiB；协议 JSON 最多 64 MiB、单个输出最多 256 MiB。当前结果沿用内联字节路径，大视频需要后续流式资源合同；这不是内存峰值保证。请求执行器仍须在读取响应时执行自己的大小上限。
- 轮询间隔为 2 秒，沿用宿主截止时间和重试策略。已受理任务先保存 `prompt_id` 再轮询；提交响应不明时报告不确定，不自动重新生成。调用会使用用户配置的 ComfyUI 算力和队列，适配器不增加云端计费接口。
- 取消优先使用目标版本支持的 `/api/jobs/{prompt_id}/cancel`。旧版本只精确删除一个待执行 ID，并核对队列和历史；执行中缺少精确取消接口时明确失败。不会调用全局 `/interrupt`，也不会用历史消失推断任务已取消。
- 输出必须为安全文件名、相对子目录及 `output/temp` 类型，只经原目标的 `/view` 下载。缺文件、遍历路径、下载失败和不支持的媒体不能报成功。

## 待确认的宿主接口

1. 扩展应如何声明原生二进制素材上传、schema 发现、原任务恢复和精确取消能力？现有声明式云 API 插件清单不能完整表达这条链路。
2. 扩展执行器如何复用持久任务回执、凭据解析、资源归属和输出入库？这里保留现有窄端口，最终位置和命名可随宿主合同调整。
3. 工作流导入、字段映射和选择界面应挂在哪个扩展 surface？本 PR 不改变现有官方渠道和模型设置。

## 验证范围

当前贡献分支的协议测试覆盖图片、视频、WAV/Opus、类型与动态枚举、上传与 mask、受理回执、重连不重投、失败语义、精确取消、输出路径和重定向凭据隔离，并用回归测试确保候选没有进入内置渠道准入。

```sh
cd backend
go test ./internal/provider/workflow ./internal/provider/comfyui -count=1
go test ./internal/app -run 'TestNativeComfyNeverRedirectsCredentials|TestWorkflow' -count=1
```

上述测试通过。按 CI 的 `sh plugin-packages/build-packages.sh` 构建官方插件后，另跑 `go test ./internal/generation -count=1`，仍有一项 `TestBeefAPIHyImageUsesGenerationJSONForReferences` 因读取 `https://beeftv.app/v1/models` 超时失败；在干净上游基线 `88de993` 上单独运行该测试可复现同样超时。因此不报告生成包全绿，也不为本贡献修改这项网络依赖。

来源 fork 的完整接入已用 ComfyUI 0.33/0.37、特定 Qwen 图片、H3 视频和 Music3 音乐工作流真实验证，结果能入库、回填并导出；另有普通新 MCP 客户端完成上传、生图、恢复和 MP4 导出的验收。那些证据说明协议来源具有实机基础，不能替代本候选分支的最终扩展集成验收。该分支未注册扩展，因此不宣称主线桌面、所有自定义节点、带鉴权实机部署或所有操作系统均已端到端验证。

部分协议和 API 图绑定代码选择性改编自 Seal，来源提交与 MIT 归属保留在 NOTICE。MCP 接入指南、媒体导出格式、业务协作定位和本机运行配置均不在本次范围内。
