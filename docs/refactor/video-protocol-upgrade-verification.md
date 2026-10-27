# 旧视频任务协议升级修复与免费验收

对应 #80。产品改动基线：`c99cba49b6518673b078991cf9d995ba14be2921`。本轮通过平台 git 重新 fetch `main`，读回仍为该提交；工作树同基线。研究输入：#78 分支 `tds/conv-01a17dee-c1f7-79ae-9121-8d75d66a6267`，提交 `961424b9` 的 `docs/research/video-protocol-upgrade.md`。

本报告只记录后台修复及本地免费验证，不是正式发布收据。#79 的助手、冷启动和图片界面验收未重复、未修改。

交付时关键生产文件的 SHA-256（用于核对本轮内容，平台提交号尚待回合结束生成）：

```text
e1cc6e3bf33948fe9c2f94ad15e12b5916aefa57ad0cfdaeb1d2e2522d8c6faa  backend/internal/plugins/retention.go
314f65e82ae29edb3ec00f05b013220035564dea0a7a0f4970a721b3068b328e  backend/internal/plugins/bootstrap.go
95d21788e248159e9ac21c87a89038153fc38901444efada4ca22bd3238b631e  plugin-packages/luma-dream-machine/manifest.json
6aa6d7e57d55e8b6b500192946f874238865cde6dc366b40c24ae91ad1f9d87d  plugin-packages/runway-video/manifest.json
```

## 原因与修改

旧逻辑发现任意待取回任务就推迟整包更新，旧解析器无法读取新回执，任务因此一直未完成，再次启动又继续冻结。引用盘点本身没有错，删掉 failed 任务的引用会破坏撤下保护。

本次仅收缩 `plugins/retention.go` 的更新推迟条件：比较新旧包实际可解析的 ID / 别名；只有新版删除了仍被配置或任务引用的 ID 才保留旧包。引用盘点失败且新版删除 ID 时继续保留；原 ID 全保留时正常更新。整包撤下逻辑、引用读取、包缓存、提交和启停状态保持原有实现。

两个插件的相邻兼容修复：

- Luma 补回旧错误字段 `fail_reason`，保留官方 `failure_reason` 等已有优先级。
- Runway 优先读取原有明确 URL 字段，再读官方 `output[]`，避免非空但仅含状态信息的 `output` 对象遮挡 `video_url`。原 `output.url` 对象本来就能被通用媒体解析器读取，未增加新的通用解析分支。
- 两包清单版本从 `2.0.0` 调整为 `2.0.1`，接口文档和内嵌文档同步生成。版本号只帮助识别，不作为运行时兼容性证明。

没有新增 UI、开关、厂商白名单、依赖、任务字段、版本仓库或另一份运行注册表；没有删除任务、清空上游 ID、换渠道或换凭据。

## 修复前证据

1. 原样提取 #78 附录，通过 Go overlay 在本机重跑：四例均复现冻结，旧解析报“声明式协议已完成但没有返回结果”；诊断对照组装入新版后恢复。包耗时 `1.751s`，每例 `0 POST / 2 查询 GET / 1 下载 GET`。这是故障复现，不算修复验收。
2. 新增旧回执测试在修复前出现两个真实失败：Luma `fail_reason` 为空；Runway `output={status:done}` 加 `video_url` 得到成功但无媒体。普通 `output.url` 通过。
3. 将最终升级测试仅通过 overlay 换回基线的 `retention.go`：Luma/Runway × 任务行/日志 ID × 根地址/子路径共 8 例全部在“正常启动应装入修复”断言处失败（包耗时 `1.086s`）。没有替换产品启动入口。

首次旧回执测试因尚未生成插件包而不能执行，运行仓库打包脚本后才取得第 2 项有效失败证据。新增测试调试时也修正了两处测试假设：`READY` 从任务读取接口投影获得；`openai-video` 别名须使用真实 `openai-videos` 包。最终结果不把这些测试搭建失败算作产品故障。

## 验收方法与结果

环境：macOS arm64，Go `go1.26.3`，`CGO_ENABLED=1`，真实 SQLite，独立 `t.TempDir()` 数据目录，`httptest` 回环假上游。没有启动桌面客户端、开发服务器或常驻 worker；测试同步调用生产 worker 处理一步。新建请求也只发往假上游，不产生费用。

旧清单保存于 `backend/internal/app/testdata/video-protocol-v2.0.4/`，已与 `542124ba` 两份源文件逐字核对一致。升级测试先用旧包走 `NewLocal` 安装、写入合成任务和保存配置，关库后换当前包，再两次正常启动。整个成功路径没有无盘点构造器或直接替换运行时的诊断旁路。

| 场景 | 实际断言 |
| --- | --- |
| 原四例扩展为 8 例：Luma/Runway × 行 ID/日志 ID × 根地址/`/proxy/v1` | 正常启动安装 `2.0.1`，无推迟标记；原任务变成 `READY`，仍是原上游 ID，资源和素材已登记，保存字节等于 MP4 夹具；取回新增 `0 POST / 1 查询 GET / 1 下载 GET` |
| 4 例运行中任务续查 | 同样正常升级，worker 仅查询原 ID，保存原结果，零 POST |
| 8 例同包新任务 | 在旧失败任务尚未取回时，通过生产创建与 worker 流程完成；每例仅假上游 `1 POST / 1 查询 GET / 1 下载 GET`，使用新版字段 |
| Luma 地址 | 根地址及带 `/proxy/v1` 的地址最终均请求 `/dream-machine/v1/generations/:id`；创建同样使用根路径，不补错误的 `/v1/dream-machine` |
| Runway 地址和请求头 | 根地址为 `/v1/tasks/:id`；子路径为 `/proxy/v1/tasks/:id`；创建、查询均带 `X-Runway-Version: 2024-11-06` |
| 原配置与原输入 | 重启不改保存配置字节、任务输入或上游 ID；日志 ID 只在实际恢复时补回；鉴权来自原任务的合成凭据。成功后产品精简 `InputJSON`，原输入保留在已有加密配方中，测试解密核对相等 |
| 只有任务引用被删除 ID：行 ID、日志 ID、运行中、取消未确认 | 4 例真实 SQLite/`NewLocal` 均保留旧定义，原任务未被改写 |
| ID / 旧别名、多 provider、盘点失败、停用 | 更新仍可解析的 ID；删掉被引用的 ID / 别名则推迟；只看实际被删 ID 的引用；盘点失败时全保留 ID 的更新可安装，停用状态保留 |
| 整包撤下、缺包、用户包及重建 | 现有 `internal/plugins` 全套通过；引用、别名和配置只读行为由 repository/workspace 全套覆盖 |
| 两包旧回执 | 旧 URL 字段、`output.url`、有元数据的 `output` 加旧 URL、`fail_reason`/`message`/`error.message` 通过；没有媒体时不生成虚假结果；官方回执及创建字段原测试通过 |
| 重启和回退 | 升级持久化，重复启动不改 registry；两包回退会恢复旧请求及旧解析失败，重新升级后同一失败任务恢复，合计仍零 POST |

以下检查已全部完成。启动升级矩阵顶层耗时 `363.83s`，12 个子例全部通过；单例约 30 秒来自原生产轮询等待。

| 已执行范围 | 结果 |
| --- | --- |
| 原样 #78 故障诊断四例 | 通过（复现故障和对照），`1.751s` |
| `internal/plugins` 全套 | 通过，`52.370s`；其后加强持久化断言，单项再跑通过，`0.457s` |
| `internal/protocol` 全套 | 通过，`1.709s` |
| `internal/repository` 全套 | 通过，`3.812s` |
| `internal/workspace` 全套 | 通过，`2.794s` |
| 正常启动升级、原任务取回和同包新建，12 个子例 | 全部通过，包耗时 `364.704s` |
| 新增真实启动删 ID/回退，2 个顶层、6 个子例 | 通过，`2.670s` |
| app 相邻视频取回、重启、配置引用、图片身份恢复专项 | 通过，`65.378s` |
| generation 视频及图片回执/恢复专项 | 通过，`3.154s` |
| `git diff --check` | 通过 |

## 重跑命令

在仓库根目录生成本地插件包（产物被 Git 忽略）：

```sh
sh plugin-packages/build-packages.sh
```

在 `backend/` 运行：

```sh
go test ./internal/plugins ./internal/protocol ./internal/repository ./internal/workspace -count=1
go test ./internal/app -run '^TestVideoProtocol(Upgrade|Rollback)' -count=1 -v
go test ./internal/app -run 'Test(PluginReferences|VideoRecovery|VideoRequestReceipt|ProviderTaskRecovery|RetryableProtocolMedia|Failed.*VideoRecovery|DBRuntimeVideoRestartRecovery|CustomVideoProtocol|AutomaticImageRecovery|ImageReceiptRecovery)' -count=1
go test ./internal/generation -run 'Test(Video|RunVideo|Luma|ImageReplay|ImageResponse|ImageRecovery|DoBinaryRecoverable|BeefTVImageSubmission)' -count=1
```

需要 CGO/SQLite，不需要真实 API Key。第一次生成包后，若清单又改动，需重新运行打包脚本。升级矩阵刻意保留生产轮询等待，每个新建/运行中例约等待 30 秒，完整 12 例约 6 分钟。

## 限制与交接

- 本地免费回归证明此组旧数据和回执可以通过正常升级恢复，不代表已读取真实用户任务，也不代表供应商在线或任意中转地址兼容。
- Luma 子路径被替换为官方根路径是既有 `originPath` 合同；依赖旧错误拼接的中转未获兼容承诺。回退测试允许旧路径返回回执只是为了观察旧请求和解析，不能据此声称官方曾接受错误路径。
- 同一个协议 ID 不能证明任意升级兼容。真正不兼容时应继续提供旧 ID 的实现，新合同使用新 ID。
- 没有跑完整桌面升级、UI、付费生成或全仓测试；不代替 #79、独立审查和最终发布候选检查。
- 按 `structural-review` 对基线至本轮改动自查：无证据支持需要新增抽象或拆分。更新判断仍在 plugins；协议差异留在各包；恢复和 registry 的唯一执行入口未变。结论为自查通过，不算 Codex 独立复查。
- 交付候选为本任务分支 `tds/conv-01a17e02-d83e-77ea-b78c-ae1bdb54b3bf` 本轮平台生成的提交（提交号由回合结束时产生）。Chief 应在该提交上安排独立复查，通过后与 #79 已验证结果一并纳入发布候选；本任务没有合并或发版。
