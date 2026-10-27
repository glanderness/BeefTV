---
half_life: 7d
archive_at: event:implementation-start
artifact_mode: delivery-doc
scope_type: phase
scope_name: BeefTV 重构方案接续的事实与任务安排
coverage: 当前主线、历史输入、停止记录、实施依赖及证据来源
not_complete_for: 实际派工、合并、发布、恢复已停任务
verification_level: docs-only
real_smoke_status: not_run
review_status: skipped
reviewer: none
review_command: 用户要求当前会话自行完成，不再派评审
review_notes: 只读任务与仓库事实，保存固定证据来源
review_owner: 后续实施负责人
review_due: event:implementation-start
execution_backend: docs-only
lead_agent: current
peer_agents: none
builder_agent: none
verifier_agent: none
verification_independence: self_checked
cwf_decision: not_needed
cwf_trigger_boundary: none
goal_handoff: skipped
acceptance_contract_status: proposed
memory_required: false
memory_space: default
acceptance_memory_id: none
---

# BeefTV 重构统筹：保留已合入成果，接续第 3 步

本记录修订 #84 原稿，只记录本轮读到的事实和后续顺序，不执行派工、恢复任务或发布。2026-10-28 约 01:50–02:05（北京时间）读取任务及会话；任务会继续变化，实施前需重新读。重构步骤在[重构方案](refactor-plan-20261027.md)，生成任务行为合同在[状态方案](generation-task-state.md)。

## 一、固定输入与主线事实

本轮通过项目仓库工具重新 fetch `main`，得到 `6a155448`，与当前工作区起点相同。以下“已合入”指该源码基线，不指已发布给用户。没有用旧 `origin/main` 或看板阶段代替判断。

| 输入 | 固定版本 / 本轮读回 | 处理 |
| --- | --- | --- |
| #84 原方案 | 分支 `tds/conv-01a17e39-4566-7c5c-8e54-0b4f2000589a`，`05abab0ffdb77e32bb1faa9925af0b378d32fe94` | 原稿保留；本任务接续同名两篇架构文档 |
| #83 研究 | 分支 `tds/conv-01a17e25-5295-7e9f-b7e2-9bc1085bc813`，`4b84a40d52e7f7da97397349adbb11a1bf7ff42b` | 已读取 3.11、完整报告、实验 JSON、夹具与补丁；不再标“本机读不到” |
| #68 正式实现输入 | 重新 fetch 分支 `tds/conv-01a17d1f-1c47-7765-b433-c2afe8ff9358`，仍为 `e08b6bea5f35a4ebe48e942cd482805ccacce163` | 保留有效实现和反例，不整包合入，不续加旧会话补丁 |
| #16 旧补丁输入 | 重新 fetch 分支 `tds/conv-01a17704-2c62-7841-8a59-ace7b86df9cd`，`47e71f98` | 两个具名回归测试仍存在；保留失败分类输入，前端扫描方案不合并 |
| PR #269 / #25 | main 历史含 `d662ea9f`；任务投影、图片自动恢复与交付代码存在 | 第 1、2 步已有实现，不从零派工；完整扣费读取仍未完成，转第 3 步明确补齐 |
| PR #275 / #46 | main 历史含 `744f4fc3` | 剪辑修复已在源码；看板 review 不等于代码未合入 |
| PR #279 / #55 | GitHub 只读返回 OPEN、`mergedAt=null`；head `a9b1f7212d45b22078aa3ea73919d7e5b4440069` | 复查已通过但未合入；不当成已部署，也不重新设计 |
| #79 / #80 | main 的 `30cba74d` 整合，来源分别 `60f07ac2` / `f282d622` | 免费专项、协议兼容修复和原证据保留；不重新实施 |
| BeefAPI #30 | 重新 fetch 研究分支，`be1fa6695502d75ace38d3d8e505a65760448728` | 已读第 7 节接口事实；与 #83 一致，不是两端联测成功证明 |

GitHub PR #279 由 `gh pr view 279 --repo glanderness/BeefTV --json state,headRefOid,mergedAt,mergeCommit,url` 只读核实。#269/#275 用新读取的 main 历史和对应实现交叉核对。发布报告还记着它当时的 `main=c99cba49`，这是历史快照；本任务使用新读取的 `6a155448`，不改发布人的证据。

## 二、任务实际状态和处理

| 任务 | 本轮实际记录 | 本方案如何使用 |
| --- | --- | --- |
| #68 | review；原实现保留；#84 已确认暂停追加 | 只作第 3 步输入，后续获授权时在当前 main 整合正确部分 |
| #16 | review；分支和历史根因保留 | 前端扫描方案不合并；回执有效性与失败分类反例可复用，不重复移入已在 main 的修复 |
| #55 | review；2026-10-27 08:42:55 UTC 复查明确“可以合并”；PR #279 OPEN | 独立绑定修复待原流程合入，与第 3 步共用绑定测试 |
| #52 | review；2026-10-27 17:32:02 UTC 明确 `stopped by 郑晨曦`，无完整交付结论 | 保留 BYOK 路径输入，不安排继续、不判废弃 |
| #75 | review；2026-10-27 17:31:32 UTC 明确用户停止 | 保留费用代码与四项待复查问题，尚无修正后通过记录；不恢复、不纳入本轮发布 |
| BeefAPI #31 | review；2026-10-27 17:31:43 UTC 明确用户停止 | 保留部分实施和测试陈述；完整交付、独立复查及两端验证未完成，不声称结算修复可用 |
| #81 | building；最近一次修订正在运行，之前主题截图/模拟 API 指向两项复查未通过 | 独立进行文字清理；不因此改状态/扣费实现，不替它宣布通过 |
| #82 | building；会话仍在运行，尚无完整回复 | 独立公开内容清理；不从标题推断无代码重叠或已完成 |
| #85 | review，发布工作有独立授权与记录 | 发布由它负责；本任务不扩大 v2.0.5 范围 |
| #87 | 本轮由 queued 变为 building | 专门补完整客户端免费恢复证据；本文不重复执行或抢占客户端 |

#75 最近独立检查的四项问题是：分辨率保存值和目录别名不匹配；批量未带每行尺寸/质量/参考图数量；Wan 参考视频时长漏计；单节点和批量显示丢单项费用/未知原因。停止前的部分修订未取得通过记录，本轮没有全面复审其代码，不能断言四项都未修改。状态保持“未通过复查”，不能引用旧“review 没问题就 PR”授权跳过检查，也不能因会话停止丢弃代码。

## 三、撤销原稿哪些安排，保留哪些授权

1. 撤销“第 1 步 Outcome 无依赖先做、第 2 步重新实现”的安排：已有 main 实现。保留它们，只把缺失的完整扣费观察明确纳入第 3 步。
2. 撤销“第 2 步依赖 BeefAPI #31 才能开始”：图片回执自动取回已合入，现有查询协议也已存在。#31 的结算修复影响后续真实两端验收，不是重做现有客户端能力的前提。
3. 撤销“B 组都继续、#52 和 BeefAPI #31 继续”的旧文字：以用户之后的停止记录为准。#75 同样不恢复。
4. 撤销“79 个状态文件全部迁移、约 20 个保存文件全部改造、未引用导出全部删除”的安排：统计没有证明职责重复；当前已读到共用保存入口和独立画板对象。
5. 保留 #84 已确认的三项：#68 不再追加补丁；v2.0.5 不带取回线第 3 步及以后；取回线原指定负责人为攻坚开发。此次 #86 由当前会话自行修文档，不重新分工、不启动下游任务。
6. 保留用户轻量方向和无多余护栏要求：只复用既有事务、租约、操作回执和交付器，不加新状态机、通用检查框架或内容过滤。

本轮新增顺序建议：保留已合入工作 → 第 3 步内部 3A/3B/3C → 按证据选择能力/旧代码/保存的小范围整理 → 稳定后缩小 handler 依赖。第 4–7 步仍受原观察期和收费迁移条件约束。完整验收与停止条件见重构方案第三节。

## 四、#83 证据到底证明了什么

报告原件：[第 3 步复核](https://github.com/glanderness/BeefTV/blob/4b84a40d52e7f7da97397349adbb11a1bf7ff42b/docs/research/generation-task-state-step-3-recheck.md)。实验原件：[step-3-recheck](https://github.com/glanderness/BeefTV/tree/4b84a40d52e7f7da97397349adbb11a1bf7ff42b/docs/research/step-3-recheck)。不复制实验代码到产品，也不把临时补丁升为正式实现。

| 证据 | 本轮复读结论 | 限制 |
| --- | --- | --- |
| `baseline.json` | `source_commit=e08b6bea`；最末级 16 项，5 pass / 11 fail，exit 1 | #83 当时执行的假上游/临时 SQLite，不是本轮重跑、不是 main 的全量测试 |
| `existing-controls.json` | 5 个旧测试全部 pass，exit 0 | 说明旧测试不足以覆盖完整合同，不能否定上述反例 |
| `billing-probe.json`、`billing-probe.patch` | 六种扣费投影 6/6 通过，对照基线同六项为 2/6 | 仅两个文件的 throwaway 实验；没验证原值持久化、操作回执、真实协议和并发整体方案 |
| `app_probe_test.go.txt`、`repository_probe_test.go.txt`、`run.py` | 使用生产 Service/repository、固定提交副本、本地 HTTP 与 SQLite | 未覆盖完整鉴权/客户端、免费接纳后强杀、自动人工竞争、迟到更新等；后续正式实现须补 |

已验证而需保留：付费并发只入队一轮，数据库重开后不再入队；两种暂停下载都能恢复到 ready。已发现而需修：免费回放报重试资格错、回执轮次 4→0、四种扣费映射错、旧轮退款污染新轮、错误查询路径、`result_url` 不识别、扫描过期无结论、临时下载失败被永久判不可取回。

“没有重复生成”与“回放成功”分开验收：免费重放反例没有新增上游生成；不能把它说成已复现重复扣费。数据库重开也不是强杀/断电证明。

## 五、与发布及费用工作的交点

生成任务第 1、2 步已有真实后台恢复、旧字段消费、CanvasNodeContent 明暗绘制证据，详见[免费验收](../release-evidence/v2.0.5-preflight.md)；它明确未覆盖完整画布同步调度、桌面 WebKit、重启和安装升级。#85 的[发布记录](../release-evidence/v2.0.5-release.md)保留候选 CI 与缺失附件说明，#87 负责补完整客户端。不能再写“从来没有验证”，也不能写“完整桌面路径已通过”。

#75 是简化费用展示，#64 复杂费用方案不实施；它与将来第 4–5 步交易报价不同。可以复用价格目录和计算规则，不能复制估算器或把展示结果当付款同意。第 3 步只处理已有结算事实，不增报价、费用快照、同意表或外部付费开关。

BeefAPI #30 第 7 节已核对：同步图片可只返回相对 `result_url`；原结果是 JSON，还需再读取；成功查询缺扣费字段不同于明确空值；结果请求失败不能抹掉已知结算。该合同原件位于 `be1fa669` 的 `docs/research/2026-10-27-image-recovery-billing.md`。旧报告称某任务 queued、未合入的地方不作现在状态使用。

## 六、本轮检查与后续可复查方法

本轮检查仅针对文档和来源：新读取 main 的历史/代码、指定分支固定提交、任务 spec 与停止记录、PR #279 只读返回；重算 #83 JSON 最末级计数。三篇文档的 delivery-planner 内容检查通过，相对文档链接无缺失，`git diff --check` 通过；自查了旧回执规则、实施步骤和发布范围的一致性。结束前再次 fetch main 仍为 `6a155448096d2425aa07e81cc6016410091ad0be`，PR #279 仍 OPEN。没有将旧测试算成本轮运行，也没有新增评审。

复查时先通过项目仓库工具 fetch 对应分支，再按表中提交读取，不必依赖长聊天。#83 的复现命令位于它的报告第 6 节，预期基线退出 1、临时映射实验退出 0；本任务不再运行研究实验。新正式实现需把有效夹具接入真实入口，并记录自己的提交和结果。

不需要用户为这次文档修订再作产品决定。尚未完成的是后续实施/运行验证，不是隐藏的本轮工作。恢复已停任务、改变用户结果、合并或发布都不由本稿代替授权。
