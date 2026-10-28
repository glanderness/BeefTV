# 飞书项目跟进表同步记录：v2.0.5 正式发布结果（2026-10-28）

本记录说明 2026-10-28 把 BeefTV **v2.0.5 正式发布**的结果写进飞书多维表格「BeefTV 项目跟进」，并在第九节记录按既有发版通知约定向飞书「Beefteam 沟通」群**补发的发布通知**。除表格与这一条群通知外，没有改产品代码或发布配置，没有触发发布或付费测试，也没有另派子任务。

- 入口：`https://scnitw8fqog4.feishu.cn/wiki/Gs60whKvFi0YifkPOfbcD8wfnMc`
- base_token：`OcHnbZCXjaMwwrsx4laciEvRnHo`
- PR 表「PR记录和跟进」：`tblE0HzQBz0cYgby`
- 需求表「需求的记录和跟进」：`tblvTTmtzdPF6qxx`
- 身份：`lark-cli base ... --as user`

## 一、依据来源与读取范围

| 来源 | 位置 | 说明 |
| --- | --- | --- |
| v2.0.5 最终发布报告 | 分支 `tds/conv-01a17e7e-d4cd-775b-9a14-12c597c70ee0`，固定提交 `edcc71d3`，文件 `docs/release-evidence/v2.0.5-release.md` | 完整最终报告；同目录体系内的 `v2.0.5-final-checks/final-release-result.json`、`final-delivery-checksums.json` |
| 上一轮表格同步记录 | 分支 `tds/conv-01a17de6-e583-70a4-91db-5cefae670fce`，固定提交 `3f15fbe4`，文件 `docs/research/feishu-table-sync-2026-10-27-v205.md` | 2026-10-27 那一轮已写 5 条 PR 状态、补 2 条 PR、更新 6 行需求并补 8 张截图 |
| 表格实时记录 | 本次 `+record-list` ndjson 落盘 | PR 表 70 条、需求表 149 条 |

两份来源的落地位置并不相同：

- main（`6a155448`）上**已经有** `docs/release-evidence/v2.0.5-release.md`，但那是**旧版**（发布前状态，写着「v2.0.5 正式发布尚未启动」）；本轮的**最终发布修订**仍在发布任务分支 `tds/conv-01a17e7e-d4cd-775b-9a14-12c597c70ee0` 的固定提交 `edcc71d3`，尚未合入 main。
- 上一轮的表格同步报告 `docs/research/feishu-table-sync-2026-10-27-v205.md` 只在分支 `tds/conv-01a17de6-e583-70a4-91db-5cefae670fce` 的固定提交 `3f15fbe4` 上，尚未合入 main。

本轮按分支 + 固定提交读取这两份来源，不改写、不复制它们的结论，也不重复上一轮已完成的插入。本轮不重做上一轮的工作，只在其结果上把状态推进到「已发布」。

## 二、写入前的实时核对

- PR 表 70 条（上一轮写入后为 66 条）。多出的 4 条由其他会话写入，均与本版无关，本轮未动：`reczz28SXf02n1BF`（BeefTV #287）、`reczz28SXpq9RM18`（BeefTV-website #33）、`reczz28SYK30hPUS`（BeefAPI #674）、`reczz28SYK30incg`（BeefTV-website #34），状态均为「review中」。
- 需求表 149 条（上一轮写入后为 146 条）。多出的 3 条同属其他会话的品牌/官网/账号页整理，本轮未动：`reczz28SXf2daRxM`、`reczz28SXqBQFDL4`、`reczz28SYK58hGoK`。
- 上一轮写入的原文与本次读取一致：需要改的条目仍写着「尚未随正式版发布 / 未随正式版发布」。没有发现其他会话后来覆盖这些条目的独立进度。
- 核对 `glanderness/BeefTV` 的合并事实：本版涉及的 14 个 PR 的 merge commit 全部是发布提交 `6a155448` 的祖先（`git merge-base --is-ancestor` 逐一确认），即确实都在 v2.0.5 里。`#263` 仍未合并（GitHub open），不在本版。

## 三、v2.0.5 发布事实（写进表格的依据）

- 正式公开时间：**北京时间 2026-10-28 03:33:55**；发布提交 `6a155448096d2425aa07e81cc6016410091ad0be`；源码 fingerprint `7145758f40c31439a24486f4addac63f1f7455cc3b970f20e46f71bb815cdb70`。
- 发布流水线：`release-desktop.yml` 运行 [40559746752](https://github.com/glanderness/BeefTV/actions/runs/40559746752) **attempt 2** 七个作业全部 success（attempt 1 仅 Apple 芯片 Mac 的 DMG 制作因 `Resource busy` 失败，同源码单作业重试通过；占用根因仍未确定）。
- 已核对：四平台 ZIP 与原生安装器从公开 R2 完整下载，8/8 大小与 SHA-256 与 GitHub Release 资产一致；五份更新清单验签通过（R2 最新/版本、旧 COS、GitHub latest/版本）；CNB 国内镜像四平台名称、大小与完整 SHA-256 与正式资产一致，核验作业 04:09:40 成功；官网 `releases.json` 最新版为 v2.0.5。
- 正式下载：`https://github.com/glanderness/BeefTV/releases/tag/v2.0.5`。
- **保留的真实限制**（写入时一并保留，不写成全部场景通过）：Mac 两个包均为 ad hoc 签名、Gatekeeper `rejected`；Windows EXE 与安装器无内嵌 Authenticode 签名；干净 Mac「下载 → 解压 → Finder 首次打开」、单独的 v2.0.4 → v2.0.5 升级专项、Mac/Linux 正式旧包失败回滚均未测（正式旧包回滚矩阵只覆盖 Windows 三组基线）；完整付费生成矩阵与整套助手验收按本版授权未重跑，新增付费调用为 0；#88 生成任务第 3 步重构、品牌整理与费用功能等其他并行工作**不在本版**；官网价格页属 BeefAPI 仓库，不随本次客户端发布变化。

## 四、PR 表「PR记录和跟进」的改动

只对 14 条记录的 `核心内容` 字段**追加**一段发布状态，其余字段（PR编号、提出者、负责review、PR 链接、目前状态、UI变化截图）一字未动。追加文本统一为：

> 状态：已随正式版 v2.0.5 打包公开发布（2026-10-28 03:33:55 +08，发布提交 6a155448；https://github.com/glanderness/BeefTV/releases/tag/v2.0.5）。本版四平台正式包、随包 CLI/MCP、更新清单验签与国内镜像均已核对；完整付费生成矩阵与整套助手验收按本版授权未重跑。

| record_id | PR | 备注 |
| --- | --- | --- |
| `reczz28S7b0L21F7` | BeefTV #267 | 即梦官方视频成功码与字段 |
| `reczz28S9ZruOB0e` | BeefTV #268 | 设置页按接入方式分清三种 Key |
| `reczz28S8rVBfbK9` | BeefTV #269 | 生成任务重构第 1、2 步（后台取回） |
| `reczz28SF2g5YBYA` | BeefTV #270 | Runway / Luma / Grok 成片取回 |
| `reczz28SGvyBw4Pn` | BeefTV #273 | Seedream 尺寸按型号校验 |
| `reczz28SGDFAdq9s` | BeefTV #274 | beeftv 命令行基础手册 |
| `reczz28SHejKJkoo` | BeefTV #275 | 剪辑首个素材拖动与单素材失败提示 |
| `reczz28SHskJbleh` | BeefTV #276 | 内置助手默认模型改 DeepSeek V4.1 Flash |
| `reczz28SKvxMEjHh` | BeefTV #277 | 撤下/升级协议插件时保留仍被引用的定义 |
| `reczz28SNXXyXN72` | BeefTV #280 | 超分费用文案 |
| `reczz28STw2d4eRD` | BeefTV #281 | 助手回复分段显示回归与链路实测 |
| `reczz28SOAAtokoC` | BeefTV #282 | 手动添加模型类型不再默认「文本」 |
| `reczz28STw2d8WDy` | BeefTV #283 | 助手思考展示（默认折叠） |
| `reczz28SOzea12BX` | BeefTV #284 | Mac 画布平移/缩放优化 |

其中 `#283` 额外补一句纠正上一轮留下的待查项：

> 发布前检查中「助手思考展示」的界面断言失败已查明为测试时序竞争，已修测试、产品代码未改，预发布复测通过。

未改动的 PR 行：

- `#263`（`reczz28RwpT0rlz1`）保持「暂不合并」，本版未包含，原有说明已准确。
- `#285`（`reczz28SRHRpizSH`，文档站）、`#287`（`reczz28SXf02n1BF`）、`#279`（`reczz28SNDttuOVl`）保持「review中」。
- `#267`、`#268`、`#269`、`#270`、`#273`、`#274`、`#275`、`#276` 上一轮没有写入（当时无状态变化），本轮是首次为它们补上发布状态。

## 五、需求表「需求的记录和跟进」的改动

只对 8 行追加 `进度说明`；其中 `reczz28SP3Vr0Lin` 一行按其原文「发版后改为已解决」把 `目前状况` 由「正在处理」改为「已解决」。需求内容、报错日志、负责人和已有截图全部原样保留。

| record_id | 需求 | 追加要点 |
| --- | --- | --- |
| `reczz28PgeY940aA` | 优化 Agent 的 UI 交互和逻辑 | #281/#283 已随 v2.0.5 发布；思考展示断言失败已查明为测试时序竞争、已修测试；本条整体仍未完成（两分钟目标、完整影音审片、#234 冲突继续待办），不改判为已解决 |
| `reczz28PgeY92VuB` | 超分辩率功能 | #280 已发布；只改文案，扣费/结算逻辑未动；beeftv.app 价格页属 BeefAPI，不随之变化；生产 7 单仍按先扣 ¥27.13 结算 |
| `reczz28Qtop6iOwJ` | 画布多节点卡顿、移动更丝滑 | #284 已发布；保留原限制（Windows 未测、刚打开时第一下最慢一帧仍偏长）；更低规模门槛与 #279 仍跟进 |
| `reczz28RZUXaynMg` | submission_uncertain 锁死节点 / 取回 | #269 第 1、2 步已发布；「免费假上游实测显示成片」已补验（组件级 #79 + 完整桌面客户端级 #87）；未单独构建 v2.0.4 旧前端页面复验；视频/超分自动恢复不在本版 |
| `reczz28SFuiwD5Z7` | 剪辑首个素材不能播放、不能拖拽 | #275 已发布；客户机上音轨失败原因与包内素材地址仍待复验 |
| `reczz28SGehLZhl4` | 三个协议插件字段与官方不一致 | #270（含 Luma）已发布；评审发现的旧插件冻结问题由**平台任务 #80**（「协议更新与旧任务取回」）修复，并经发布 PR #286 合入本版——**不是 #277**；#277 是原先的「撤下/升级官方协议插件时保留仍被引用的定义」工作。修复做法：更新推迟改为只比较新旧包实际可解析的 ID/别名。启动升级矩阵 **12 例**子例全部通过（**8 例旧失败任务取回 + 4 例运行中任务续查**），来源 `docs/refactor/video-protocol-upgrade-verification.md`（`6a155448`）。minimax-hailuo-video-v2 仍不在改动内 |
| `reczz28SP3T95sSZ` | 完善 CLI 使用文档 | #274 已发布；文档站 #285 仍未合并、未部署、未绑定域名，不在本版 |
| `reczz28SP3Vr0Lin` | 内置助手默认改用 DeepSeek V4.1 Flash | #276 已发布，诉求达成，`目前状况` 改为「已解决」 |

## 六、未匹配、未猜测与遗留

- 本版有改动但需求表没有对应行的：手动添加模型类型不再默认「文本」（#282）、设置页分清三种 Key（#268）、Seedream 尺寸按型号族校验（#273）、即梦官方视频成功码（#267）、撤下/升级插件保留被引用定义（#277）。这些仍然**没有新建行**，与上一轮口径一致：不确定是同一诉求就不强行并入。需要的话可按现有格式补成新行。
- 表内其它陈旧项不在本次窗口内，本轮未动（例如 `reczz28RFnMq64j0`、`reczz28PgeY940aA` 中把 PR #261 写成「待 Lucas review」，而 #261 已于 2026-10-26 合并）。
- 用户口中的「59 / 56 / 57」是 **Todos 平台任务编号**，不是 GitHub PR 号，也不是需求表任一视图的行号：平台 #59（`9ymf-ZciIKSdoMiCUJZGk`）对应 GitHub **PR #282**、平台 #56（`XvMjQ2lBakvdt73rdjc2H`）对应 **PR #280**、平台 #57（`i3hBaQDun8WY3bGmrIbF3`）对应 **PR #281**。这三条已分别按上表第四节记录，不再记为「无法与任何可查来源对应」。

## 七、执行与读回

- 写入命令：`lark-cli base +record-batch-update`（PR 表 14 条、需求表 8 条），全部 `--as user`；写前先 `--dry-run` 核对请求体。只提交目标字段，未写任何 attachment 字段。
- 写入后重新拉取两表 ndjson 并逐条比对：
  - PR 表 70 → 70 条，无新增/删除行，**恰好 14 条**记录的 `核心内容` 变化，其余字段与附件数量不变。
  - 需求表 149 → 149 条，无新增/删除行，**恰好 8 行**的 `进度说明` 变化，其中 1 行的 `目前状况` 同步改为「已解决」，其余字段与截图不变。
- 读回确认 14/14 条 PR 记录含发布状态行、8/8 行需求记录含「2026-10-28 发布」段；`reczz28SP3Vr0Lin` 状态为「已解决」。
- 本记录不包含任何真实凭据、客户隐私或本机敏感路径。

## 八、本轮修订（评审反馈后）

Chief 核对本报告与表格后指出三处来源表述不准，本轮只修正这三处，未重新同步其余已正确的记录，未改任何状态、截图或来源报告。

1. **编号归属**：59 / 56 / 57 是 **Todos 平台任务编号**（分别对应 PR #282 / #280 / #281），已按实修正第六节，删除「无法与任何可查来源对应」的旧说法。
2. **来源落地位置**：main（`6a155448`）上**已有旧版** `docs/release-evidence/v2.0.5-release.md`（发布前状态）；最终发布修订仍在发布任务分支 `edcc71d3`，尚未合入 main；上一轮同步报告也尚未合入 main。已按实修正第一节，不再写成两个路径都不在 main。
3. **协议冻结修复的归属**：修复方是**平台任务 #80**（「协议更新与旧任务取回」，经发布 PR #286 合入本版），**不是 #277**——#277 是原先的「撤下/升级官方协议插件时保留仍被引用的定义」工作。启动升级矩阵应为 **12 例**（8 例旧失败任务取回 + 4 例运行中任务续查），来源 `docs/refactor/video-protocol-upgrade-verification.md`（`6a155448`）。已修正第五节表格行，并同步修正需求表 `reczz28SGehLZhl4` 的 `进度说明`：写入前重读该行，只替换本轮追加的那一段，其余原文与其他字段未动。

修订后读回：需求表仍为 149 条，只有 `reczz28SGehLZhl4` 一行的 `进度说明` 变化；该行 `目前状况`、`负责人`、截图均未改。

## 九、发版通知群消息（2026-10-28 补发）

**背景**：用户 2026-10-28 10:02 追问「发版了怎么没有飞书通知？」。按 2026-10-23 的持续授权（每次 BeefTV 正式发布后在飞书群通知 Lucas 并总结本版改动），本轮补执行这一约定——属既有授权的补执行，不需要用户重新批准，也不必等文档合入确认。

### 发送前核对

- **目标群**：`+chat-search --query Beefteam` 命中「Beefteam 沟通」`oc_39374a8935053e4bc5180877b8b693ba`（群主 `ou_cf2fb5d242fcca8a8a3083821851ffde`）。
- **成员**：`+chat-members-list` 返回 2 名用户 + 1 个机器人——郑晨曦 `ou_69a7314103712cdba313a4a237e0e89a`、**Lucas** `ou_cf2fb5d242fcca8a8a3083821851ffde`，机器人 Beefman。@ 对象确认为 Lucas 的 open_id。
- **最近消息**：`+chat-messages-list --order desc` 读到 2026-10-27 22:53 至 2026-10-28 09:57 的 30 条，覆盖发布时刻（03:33:55）前后；窗口内只有 02:59、03:09、03:38 三条 PR 交接消息，**没有任何 v2.0.5 发布通知**。
- **关键词检索**：`+messages-search --query "v2.0.5"` 在本群只命中 2 条（10-28 09:57 日报更正、02:59 PR #287 通知），均非发布通知；`--query "v2.0.4"` 为 0 命中（**v2.0.4 当时也未发过同类通知**，本轮不在补发范围内，仅作记录）。
- **另一个 Beefteam 群**：「Beefteam · 通知群」`oc_ad4387260f9f8506031e60bb183dbca9` 只有 Uptime/告警机器人消息，无发布通知。

结论：同版完整通知确实缺失，按约定以用户身份补发一次。

### 消息内容

来源为固定报告 `edcc71d3` 的 `docs/release-evidence/v2.0.5-release.md`、正式 Release 页与 `6a155448` 的 `CHANGELOG.md`；只写用户可感知的改动、真实限制与未纳入项，不把后台测试说成所有场景通过。

```text
BeefTV v2.0.5 已发布

@Lucas 本版已正式发布（北京时间 2026-10-28 03:33），四平台安装包、随包 CLI/MCP 与新旧更新入口均已核验。

[BeefTV v2.0.5 发布页](https://github.com/glanderness/BeefTV/releases/tag/v2.0.5) ｜ [正式发布记录](https://github.com/glanderness/BeefTV/actions/runs/40559746752)

本版改动：

• 内置助手可查看模型返回的思考过程，默认折叠，与工具进度和回复正文分开；回复正文继续随模型返回逐段显示，复制回复仍只复制正文。
• 新用户首次连接后，内置助手默认使用 DeepSeek V4.1 Flash；已经自己选过模型的用户保持原选择，刷新目录、重新授权和换账号都不会改掉。
• Mac 画布平移、缩放更流畅：手势期间减少毛玻璃、连线装饰、整页重绘和节点反复挂载；并修复恢复保存视角后平移时部分节点漏画。
• 剪辑时间线首个片段可以拖动、同轨片段自动让位；单个素材载入失败只跳过该片段并点名提示，其余片段继续预览。
• 视频与图片取回修复：即梦官方视频的成功判断与请求参数改对；Runway、Luma、Grok 恢复取回成片；有待取回视频时也能正常安装兼容的协议修复，旧任务继续用原任务编号取回结果，无需重新生成。
• Seedream 图片尺寸改按具体型号校验，修正国内 Pro / Flash 型号识别；不支持的尺寸在生成前给出可操作的提示。
• 手动添加模型时必须先选类型，不再默认「文本」；模型服务设置按协议写清所需凭证，读不到模型列表时可以手填模型 ID。
• 部分失败的图片任务可在后台自动取回已有结果并写回画布，不扣费、不用手动点（本版只覆盖图片，视频与超分的自动恢复不在其中）。
• Topaz 超分说明改为「先扣费用上限、账单核对完成后按实际用量结算」，不再把预扣总额显示成单价。

验收：四平台正式包从公开 R2 完整下载，8/8 文件大小与 SHA-256 与 Release 资产一致；5 份更新清单验签通过；CNB 国内镜像四平台与正式资产一致；四平台安装生命周期、随包 CLI/MCP、Windows 三个旧版升级与失败回滚均通过。

注意：Mac 包是 ad hoc 签名，Gatekeeper 会拒绝，首次打开可能需要在系统设置里手动放行；Windows 包没有内嵌签名。干净 Mac 的「下载→解压→Finder 首次打开」、单独的 v2.0.4 → v2.0.5 升级专项、Mac/Linux 正式旧包失败回滚都还没测。按本版授权，完整付费生成矩阵和整套助手验收未重跑，没有新增付费生成。

未纳入本版：#88 生成任务第 3 步重构、品牌与费用相关的并行工作；官网价格页属另一仓库，不随本次客户端发布变化。
```

### 发送与读回

- 命令：`lark-cli im +messages-send --chat-id oc_39374a8935053e4bc5180877b8b693ba --as user --markdown "$(cat msg.md)" --idempotency-key beeftv-v205-release-notice-20261028`；发送前先用 `--dry-run` 校验请求体（`msg_type=post`、`receive_id=oc_39374a8935053e4bc5180877b8b693ba`、`uuid` 一致）。
- 原始回执：`{"chat_id":"oc_39374a8935053e4bc5180877b8b693ba","create_time":"2026-10-28 10:12:08","message_id":"om_x100b6121d14590a0c0b1880c17b78d8"}`。
- 读回（`+messages-mget`，`--no-reactions`）：`msg_type=post`；sender 为 `郑晨曦 / Sunny`（`ou_69a7314103712cdba313a4a237e0e89a`，`sender_type=user`，即用户本人身份）；`mentions` 含 `Lucas`（`ou_cf2fb5d242fcca8a8a3083821851ffde`）；正文与发送内容逐字一致。
- 可点击消息链接（CLI 返回的 `message_app_link`）：https://applink.feishu.cn/client/chat/open?openChatId=oc_39374a8935053e4bc5180877b8b693ba&position=11651

本轮只补这一条群通知：**未重复写表**（14 条 PR / 8 行需求保持原成果），未改状态、截图，未重跑任何产品检查，未改产品与发布配置。
