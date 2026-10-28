# GitHub Issue 同步进飞书需求表：每日同步规则与操作手册

把 `glanderness/BeefTV` 的新增 issue、以及有新评论的 issue 同步进飞书 Base「BeefTV 项目跟进」需求表 `tblvTTmtzdPF6qxx`（base `OcHnbZCXjaMwwrsx4laciEvRnHo`）。

- 定时：每天 **10:30（Asia/Shanghai）**，排在「每天 9:30 企微反馈收集」（todo #12）之后。规则挂在 todo #53 上（rule id `_qucbwjoyP57uH3pYy3ml`），由左侧边栏的**定时**页管理；每次到点触发一次全新构建，按本文件执行，不经规划直接进入执行中。
- 运行机器：规则已固定到 `sunnydeMac-mini-2.local`（machineId `HLEChuCr6TAOD_3IkAc8A`），Agent 跟随任务（主力）。这台机器是必须的——`gh`（账号 `enderzcx`）与 `lark-cli`（`--as user`）的用户授权只在这里，换机器会直接失败，改规则时不要把机器改回「自动」。
- 边界（用户口径，未变更前一直有效）：**只写需求表**——不在 GitHub 上评论、打标签或关闭 issue；不发群；issue 关闭不自动跟改表内状态。

首轮只读盘点、试跑与 2026-10-27 的 16 条正式写入记录在 todo #43 的分支 `tds/conv-01a17aee-cb0a-7266-b1d9-17d7053345c7` 的 `docs/research/github-issue-sync-to-requirement-table.md`；本文件是落进 `main` 的操作手册版本（分支合并后即为权威版），字段映射、去重规则与 issue → record_id 对照表都在这里。

## 一、每天怎么做

```bash
# 1. 只读：拉 GitHub issue 与需求表，输出「新建 / 并入 / 跳过」计划
python3 scripts/sync-github-issues-to-feishu.py --plan-out /tmp/plan.json

# 2. 按计划核对措辞（尤其「进度说明」的结论、「需求内容」的一句话），改完再写
python3 scripts/sync-github-issues-to-feishu.py --apply-plan /tmp/plan.json --apply

# 或者计划没问题时直接写：脚本会自己算计划、写表、逐条读回核对
python3 scripts/sync-github-issues-to-feishu.py --apply
```

- 不传 `--since` 时，同步游标取 `~/.local/state/beeftv/github-issue-sync.json` 的 `lastSyncAt`（上一次成功同步的时间）；文件不存在就回看 48 小时，并在输出里提示。跳过了一天以上的周期时，显式传 `--since <上次同步时间>` 补看。
- 脚本写表顺序是「先 create 再 update」，随后重新拉表逐条核对：新建行按 `来源：GitHub Issue #N（` 标记找回，并入行按追加段落的原文比对。核对不通过会打印问题并返回退出码 1。
- 飞书 Base 写入后短时间内可能仍返回旧快照，脚本核对失败会重试 3 次（每次间隔 3 秒）。仍失败时人工再拉一次表确认，不要重复写。
- 没有新 issue 也没有新评论时，脚本输出「新建 0 行、并入 0 行」，当天回复只写一句「今天没有新 issue」。

当天回复要给用户：新建 / 并入的 issue 与 record_id、一共几条；`--plan-out` 里 `near_duplicates`（疑似与表内已有行重复）的条目列出来让用户定，**不自动并入也不自动新建**。

## 二、issue → 表字段映射

字段 id 用 `lark-cli base +field-list --base-token OcHnbZCXjaMwwrsx4laciEvRnHo --table-id tblvTTmtzdPF6qxx` 核对。

| 表字段 | field_id | 写法 |
| --- | --- | --- |
| 需求内容 | `fldsisKbk9` | issue 标题去掉 `[Bug]`/`[Feature]` 前缀；标题只有标签（#118、#235）时取正文首句；一句话、≤ 40 字 |
| 报错日志 | `fldijvUPne` | 首行固定 `来源：GitHub Issue #N（url，@作者，创建日期，版本/平台）：` 后接正文摘要与维护者回复；并入已有行时按 `1. 2. 3.` 追加，不覆盖原文 |
| 进度说明 | `fld75zOrkE` | `YYYY-MM-DD 登记（来源：GitHub Issue #N）：…`；后续追加带日期的段落 |
| 目前状况 | `fldGSVHgeh` | 新行一律 `正在处理`；并入的行不改 |
| 负责人 | `fldSIkfdZE` | 留空（人工分派） |
| 对应截图 | `fldzeoKcZ8` | issue 正文里的 `user-attachments` 图片，用 `gh` 下载后 `lark-cli base +record-upload-attachment --field-id fldzeoKcZ8 --file <相对路径>` 追加 |

## 三、去重规则（三层，按优先级）

- **L1 机器标记（权威）**：同步前扫全表 `报错日志` + `进度说明`，正则 `GitHub Issue #(\d+)` 命中即并入该行。所以**每次写入都必须留标记**——这是整套流程自洽的唯一硬约束。
- **L2 等价表（覆盖存量）**：标记是 2026-10-27 才开始写的，第四节列了当时 16 条 issue 的落点；此后 L1 已能独立命中。
- **L3 语义近似（只提示）**：脚本对新建 issue 与全表 `需求内容` 做字符 bigram 相似度，把 ≥ 0.25 的候选写进计划的 `near_duplicates`，**只提示、不自动动作**。

判定原则：**同一诉求并入，同一错误信号但根因候选不同就新建并交叉引用**；与企微反馈（todo #12）是同一诉求时并入同一行（先例：issue #180 并入企微日报建的「Windows 安装包被杀软报毒」行 `reczz28SFuiwEzSD`）。

issue 关闭不跟改表内状态：表里 `已解决` 的实际口径是「已核对并已发布」，GitHub 的 close 可能是 duplicate / not planned / 报告人自关。需要时只在 `进度说明` 追加一行事实。

## 四、issue → record_id 对照（2026-10-27 首轮写入，2026-10-28 复核）

| issue | 动作 | record_id | 目前状况 |
| --- | --- | --- | --- |
| 19 ComfyUI | 并入 | reczz28RaeeLOBPt | 正在处理 |
| 21 缩放卡帧 | 并入 | reczz28Qtop6iOwJ | 正在处理 |
| 98 删除助手聊天记录 | 新建 | reczz28SGehLWtFO | 正在处理 |
| 103 图片二次处理 Panic | 新建 | reczz28SGehLZJMH | 正在处理 |
| 112 技能正文 413 | 新建 | reczz28SGehLYZwz | 正在处理 |
| 118 批量丢图 | 新建 | reczz28SGehLZ2AF | 正在处理（附件 2 张） |
| 122 模型渠道删除/默认模型 | 并入 | reczz28PgeY94YkK | 已解决 |
| 148 中文界面 Agent 失败 | 新建 | reczz28SGehLa942 | 正在处理 |
| 152 本地/内网模型 | 新建 | reczz28SGehLZvqk | 已解决 |
| 180 杀软报毒 | 并入 | reczz28SFuiwEzSD | 正在处理 |
| 181 Agnes 公网 URL | 新建 | reczz28SGehLYSUM | 正在处理 |
| 210 三个协议插件字段 | 新建 | reczz28SGehLZhl4 | 正在处理 |
| 213 Ubuntu 黑屏卡死 | 新建 | reczz28SGehLaBO8 | 正在处理 |
| 235 失败后不能重新生图 | 并入 | reczz28QXamcO9oW | 已解决（附件增至 4） |
| 244 局部重绘报错 | 并入 | reczz28RvpAjRHSO | 正在处理 |
| 248 400 被误判 submission_uncertain | 并入 | reczz28RZUXaynMg | 正在处理 |

5 条已关闭且表内没有对应行的 issue（#65 / #68 / #109 / #113 / #201）按第七节口径不自动补登，脚本会在计划里列为「跳过」。

## 五、脚本

`scripts/sync-github-issues-to-feishu.py`（标准库，无第三方依赖；单元测试 `scripts/test_sync_github_issues_to_feishu.py`，`python3 -m unittest test_sync_github_issues_to_feishu`）。

- `gh issue list --state all --json number,title,state,url,createdAt,updatedAt,author,labels,body,comments` 一次拿全；评论的 `authorAssociation` 用来挑维护者回复，邮件回复里的引用块和页脚会被剥掉。
- 表数据用 `lark-cli base +record-list --format ndjson` 落到临时目录（临时目录在仓库外，不会污染工作树）。
- 写表用 `+record-batch-create` / `+record-batch-update`（字段用 field_id）；写入值是**整段文本的绝对值**，因此重复应用同一份计划不会产生重复段落。
- 已知缺口：issue 正文里的截图仍要人工下载上传（`gh` + `curl` 取 `user-attachments` 链接，再 `+record-upload-attachment`），脚本不处理；新行首次写入时如果 issue 有图，按第二节补上。
- 游标文件 `~/.local/state/beeftv/github-issue-sync.json` 是**本机状态**：换机器或删掉后会回退到「回看 48 小时」，最坏情况是把已写入的评论再追加一次，人工核对时删掉即可。

## 六、2026-10-28 首次定时运行记录

- 计划：新建 0 行、并入 1 行、跳过 20 条（16 条已登记无新评论、5 条已关闭未登记）。
- 并入 `reczz28RaeeLOBPt`（issue #19）：报告人 10-27 追问「什么时候可以使用 ComfyUI」，维护者回复「放进后续的插件里面 这周会上」；`报错日志` 追加第 4 条，`进度说明` 追加 2026-10-28 段落，状态与负责人未改。
- 读回核对通过（首次核对遇到飞书短暂旧快照，重试后通过——这就是脚本里 3 次重试的由来）。
