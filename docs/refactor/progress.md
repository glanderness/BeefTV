# 完整重构实施记录

本文件记录开发候选的真实状态；不是发布证明。范围与验收以 [实施合同](./implementation-contract.md) 为准。

## 已核实基线

- 15266ba 合并正式 v1.6.21 与 Agent 候选；035bb49 固定完整重构范围。
- 独立验证：`cd backend && go test ./internal/database ./internal/generation ./internal/beefapi ./internal/handler`。新工作树先运行 `./plugin-packages/build-packages.sh`，否则官方协议包缺失会导致 registry 测试失败。构建协议包后 generation 通过。
- 独立验证：`cd backend && go test ./internal/generation ./internal/app` 通过，app 用时 168.348 秒。
- 独立验证：`cd web && bun install --frozen-lockfile && bun run typecheck` 通过。
- 以上仅证明合并基线；不代表下列工作已完成，也不替代真实客户端、模型和发布包验收。

## 第一批并行实现

所有工作树固定于 15266ba，只有 Lead 向集成分支合入。Grok 不执行发布、真实数据写入或付费模型调用。

| 责任 | Grok job | 写入范围 | 集成前核查 |
| --- | --- | --- | --- |
| 迁移身份与实际结构 | 20261002-005355-delegate-035f0aa6 | database | 历史编号碰撞、结构缺失、未知列保留、失败重试 |
| Agent 宿主运行时 | 20261002-005355-delegate-4c14270a | 宿主 lifecycle、新 runtime、必要 bootstrap 接线 | 进程唯一 Wait、配置与凭据隔离、停止/恢复 |
| 公共业务操作 | 20261002-005355-delegate-53bc028d | operations、agentops 适配、canvas 合同 | 授权先于重放、事务与回执、无 app 反向依赖 |
| 生成结果可靠交付 | 20261002-005638-delegate-f5527881 | app/task、结果交付、task repository | 界面关闭仍可落地、故障重试不重复付费/节点 |
| 剪辑与导出完整性 | 20261002-005638-delegate-2ab89e9b | timeline、merge、export-integrity、zip | 实际音轨/字幕、执行器语义一致、备份引用 |
| 官方 pi 会话与事件 | 20261002-005825-continue-4b74edc3 | agent-host、助手事件投影 | dispose、官方持久化、隔离加载、取消/压缩/重试 |
| 画布页面职责 | 20261002-010449-delegate-75be177f | project 页面、新私有 controller | 不以巨型 hook 搬家代替解耦、保留交互 |
| 协议插件领域 | 20261002-010449-delegate-0a5e6e6c | plugins、app 插件适配 | 单一注册表/变更所有者、实际实现退出 app |

## 基线回归排查

直接 `cd web && bun test`：2311 pass / 10 skip / 37 fail。该命令绕过仓库隔离入口，`mock.module` 污染后续文件。逐文件复核后，除浏览器运行时未指定路径外全部通过。

已修复一处实际合并回归：明确 `local_storage_failed` 的准入失败保留“尚未提交生成”；普通数据库错误仍不推断上游是否接单。`bun test test/generation-error.test.ts`：64 pass / 0 fail。

正确全量入口：`cd web && CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' bun run test`。结果 2389 pass / 0 fail / 10 skip，退出 0。使用仓库 `scripts/run-test-suite.mjs` 的既有隔离规则，没有删测试。

## 独立审查与合入

| 切片提交 | 独立验证 | 决定 |
| --- | --- | --- |
| database 2d8b3ce | 完整生产 diff 与历史 DDL 夹具审查；`go test ./internal/database -count=1` 通过，2.426s | 合入为 331857a；公开文档跟进 |
| runtime 17f5f35 | runtime/handler/bootstrap 测试通过 | 暂不合入；新领域反向依赖 app、请求级临时 Host 必须修正；继续 job 20261002-011135-continue-c3772d17 |
| editing b9fb278 | 实际 native FFmpeg + 执行/计划/完整性测试，29 pass / 0 fail | 暂不合入；共享 worker 取消所有权、空备份限制、实际 native 调用边界需修正；继续 job 20261002-011554-continue-f082d24e |

第二批项目领域：job 20261002-011319-delegate-63acf902，工作树固定 0d29c11，负责项目实际规则退出 app、消除 project/localapp 反向依赖。仅允许项目相关接线，不能改生成、素材、宿主或插件核心。

## 后续必须继续的范围

1. 人工 UI 接入公共操作；删除按时间戳竞争数据库事实的正常路径。当前 `local-workspace-repository` 仍有此路径。
2. 配合后端结果交付切换前端 materializer/consumer，避免两个执行者同时交付。
3. Agent 业务轮次、确认与撤销的持久化边界；当前 app 内 JSON 文件记录不能被误报为已完成统一事务。
4. 模型目录、Provider/Protocol/Transport 的实际实现归属；插件提取只覆盖其中一个领域。
5. 工作区、项目、素材、配置与生命周期接线。目前 `project`、`localapp` 仍直接引用 app 类型，LocalKernel/task facade 仍转发大 Service。
6. 清理已退出运行面的旧 Agent 代码调用关系，保留历史数据；不能恢复旧 cloud_agent 调度。
7. 真实媒体输出、备份还原、平台升级、性能基线、完整回归、独立复审和新候选付费验收。

不得将第一批 worker 完成、目录分包或旧版验收报告写作“完整重构完成”。后续变更需按实际依赖顺序实现与验证。
