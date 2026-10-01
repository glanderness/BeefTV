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

## 后续审查与并行接入

- runtime 修正 a7dd50b 独立测试通过：assistantruntime 1.663s、assistant 1.155s、handler 3.064s、bootstrap 14.861s；合入 ecda201 / 1218b3e。Lead 进一步移除独立路由注册的无 Close 所有者 Host 兜底，集成 handler/bootstrap 通过。
- pi 5541435：54 pass / 0 fail；额外确定性复现并发 replace 泄漏和 current.json 写失败后的状态分裂，未合入。继续 20261002-012611-continue-352b1416。
- generation fdf34aa：未合入；恢复仍依赖 GET、元数据覆盖与错误吞没待修。继续 20261002-012722-continue-ab34e728，实现后台恢复和实际 taskdelivery 领域。
- plugins e03031e：未合入；同包重装失败可能删除旧包、管理状态回滚存在并发窗口。继续 20261002-012809-continue-39115e00。
- operations 7000765：聚焦四包独立测试通过；修复调用身份 fail-closed 并接入人工画布保存，继续 20261002-012045-continue-a38f46d6。
- Agent 业务轮次：20261002-011801-continue-a7418435，固定 331857a，assistantturns + schema 10；官方 pi 保留会话事实，SQLite 负责业务轮次和撤销事务。
- 模型目录/能力/渠道：20261002-012935-continue-dead2721，固定 1218b3e；实际规则退出 app，保留上游参数合同。

以上都在独立工作树；尚未进入发布验收，没有新增真实模型费用。

## 第二轮审查

- editing 911bc1a / 708fc35 / 0c9d91b 已进入集成。Lead 复现取消当前工作时，后续租约拿到已终止预热 worker 的竞态，直接修正所有权转交与 dispose；36 项聚焦测试、2 项真实浏览器 worker 测试和 typecheck 通过。实际原生/浏览器共用内容计划继续由 20261002-014317-continue-8982ff92 实现。
- project fc96599 独立 project/localapp/handler/bootstrap 测试通过；仍有章节/关联分步写入、更新无 CAS 和父文件夹归属问题，继续 20261002-013550-continue-babf5c0c，尚未合入。
- assistantturns 408c16e 独立迁移/领域/应用聚焦测试通过；旧 JSON 双写、Begin 未优先迁移旧 ID、清理后可重导入、损坏 scope 静默降级必须修正。继续 20261002-014449-continue-1ca2e878，尚未合入 schema 10。
- 资源真实领域：20261002-013215-delegate-6c5c1bb2，固定 673e320；保持现有生成存储方法适配，不能与交付 worker 重复拥有任务逻辑。
- 旧 Agent 退场：20261002-013853-delegate-63e3a533，固定 673e320；只移除已验证无活跃入口的实现，保留历史数据及现有功能仍使用的公共规则。
- CPU 数据处理基线已记录于 [performance.md](./performance.md)，并非 UI 或数据库端到端性能结论。

## 后续必须继续的范围

1. 人工 UI 接入公共操作；删除按时间戳竞争数据库事实的正常路径。当前 `local-workspace-repository` 仍有此路径。
2. 配合后端结果交付切换前端 materializer/consumer，避免两个执行者同时交付。
3. Agent 业务轮次、确认与撤销的持久化边界；当前 app 内 JSON 文件记录不能被误报为已完成统一事务。
4. 模型目录、Provider/Protocol/Transport 的实际实现归属；插件提取只覆盖其中一个领域。
5. 工作区、项目、素材、配置与生命周期接线。目前 `project`、`localapp` 仍直接引用 app 类型，LocalKernel/task facade 仍转发大 Service。
6. 清理已退出运行面的旧 Agent 代码调用关系，保留历史数据；不能恢复旧 cloud_agent 调度。
7. 真实媒体输出、备份还原、平台升级、性能基线、完整回归、独立复审和新候选付费验收。

不得将第一批 worker 完成、目录分包或旧版验收报告写作“完整重构完成”。后续变更需按实际依赖顺序实现与验证。
