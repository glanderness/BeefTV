# 旧失败视频任务冻结协议更新：核实结果与兼容升级建议

> 对应任务 #78。核实日期：2026-10-27。状态：已完成源码核实和免费夹具复现；改法是架构建议，尚未实施、未发布。
>
> 本文只增加研究材料。没有修改产品实现、真实数据库、线上配置或用户客户端，没有调用付费模型。本轮由架构师核实并提出建议；没有另行发起独立评审。

## 1. 结论

**#76 报告的冻结成立。失败任务仍需要协议并没有错，错误在于把“协议仍被使用”解释成“不能安装这个协议的修复”。**

在最新主线 `c99cba49b6518673b078991cf9d995ba14be2921`，旧 Luma / Runway 清单已保存、且存在可查询上游 ID 的失败视频任务时，启动会保留整份旧清单。人工取回继续读旧解析器，无法完成任务；下一次启动仍会保留旧清单。同协议的新任务也使用这份注册表，所以也拿不到新版修复。

本轮以真实 SQLite、启动盘点、人工取回入口和素材入库复现了四种情况：Luma / Runway，分别把上游 ID 放在任务行或请求日志里。四种情况均冻结；在对照组中仅让现有运行时装入随包新版定义，四个原任务均恢复为 `READY`，视频文件字节与夹具一致，**生成请求数均为 0**。这证明安装新版定义能解除本次解析阻塞，不证明任何未实现的升级规则已经通过验收。

**推荐：正常维护升级和协议撤下分别处理。保留撤下及删除被引用协议 ID 的保护，取消待取回任务对正常兼容更新的整包冻结。**

- 相同协议的兼容修复按现有启动流程安装；旧任务使用相同协议 ID 的已修复实现，保留原任务 ID、渠道和凭据。
- 新包删掉仍被配置或任务使用的协议 ID / 旧别名时，继续保留旧包；不能只检查配置而漏掉任务。
- 不兼容协议应使用不同协议 ID，并继续提供旧 ID 对应的实现；复用已有多 provider / 多包能力，不以同一个 ID 静默替换成另一种查询合同。
- 不增加 Luma / Runway 白名单、`forceUpgrade` / `retentionMode` 开关、自动猜测“安全更新”的字段过滤器或任务版本仓库。

“相同协议”是维护者必须兑现并验证的兼容承诺，**不是字符串相等就能证明请求兼容**。本轮建议取消运行时一刀切冻结，同时把旧任务回执和取回请求加入更新回归；不是放行未经核对的任意同名包。

## 2. 核查基线与输入

| 材料 | 本轮固定来源 | 核查用途 |
| --- | --- | --- |
| 当前主线 | 通过平台 git 实际 fetch main，两次读回均为 `c99cba49b6518673b078991cf9d995ba14be2921`；本工作树同基线 | 生产调用链与夹具执行代码 |
| v2.0.4 | `542124baadcdbe5ce34ba9029ef7f1d192b49d16` | 直接读取旧版两个 `manifest.json`，不凭手写字段重建旧定义 |
| #76 | 读取 `X9426l1CHOOK-LGHix0na` 最新 conversation，23:11 源码审查；差异 `542124ba..c99cba49` | 待验证问题和本版免费验收授权；原报告不是运行证据 |
| #39 | 实际 fetch 分支，头为 `3f251c7862ed97fb48c6d38e958798e9c2e720da`；[调研报告](protocol-retirement-patterns.md)与当前文件 SHA-256 相同 | 检查外部依据与整包延迟升级建议的来源 |
| #49 | 实际 fetch 分支，头为 `c90e9733d4c276a750045ac780e50b28176edbd8`；[协议决策约定](../architecture/protocol-decision-contract.md)与当前文件 SHA-256 相同 | 确认前端协议写入改造仍为后续建议，不借此恢复前端实施范围 |
| #51 | 实际 fetch 分支，头为 `e3cbcd0db0b5561bfca68b7fe305b1b4ec51c5df`；`retention.go` 与当前文件 SHA-256 相同 | 旧别名、日志中上游 ID、保留规则与相邻测试 |
| BYOK 原建议 | [7.3 节](byok-consolidation-plan.md#73-先修启动清理再删除包) | 原文针对“需要保留旧版查询解析器”的任务，不等于所有任务都需要旧解析器 |

历史文档只作为输入，不把它们的通过记录算成本轮验证。#39、#49 中的方案也不能当作当前已实现的前端能力。

### 对任务补充说明的修正

1. 本轮官方形状回执实际报错是 **“声明式协议已完成但没有返回结果”**。`protocol/manifest.go:667` 在媒体为空时把 `Result` 置为 nil，最终进入 `generation/protocol.go:947`；#76 指向的“没有返回媒体地址”（同文件 `977`）是相邻的非 nil 空媒体分支，不是本夹具实际路径。
2. “永久无法安装”应表述为：**只要旧记录与待取回引用保持不变，每次启动都会继续推迟，没有超时自动解除**。引用消失、任务完成或定义被另行更新可以改变结果。
3. 本版修复不限于结果字段：Luma 改了路径拼接、状态与请求映射；Runway 增加版本请求头并修改创建字段。因此不能以“只改解析”为由给整包放行盖章。
4. 本轮没有真实用户数据库和供应商运行读回，不能断言已有多少用户遇到问题，也不能证明旧版本曾在官方服务上成功提交。Luma 旧查询路径本身就有错误；夹具证明的是题设数据条件存在时的真实应用行为。

## 3. 可复现条件与完整因果链

### 3.1 必要条件

1. 本地持久化 `plugin_registry` 已有旧 `luma-dream-machine` 或 `runway-video` 定义。仅下载新版应用、全新 registry 并不会触发这个冻结。
2. 本版随包清单与旧清单字节不同。`deferralFor` 比较 `Raw`，不比较 semver；两包在旧版与本版都仍标 `2.0.0`。
3. 盘点能得到相应协议的 `PendingTasks > 0`，例如 `failed` 任务的 `provider_request_id` 非空，或 `api_call_logs` 中能找到该任务的非空上游 ID。
4. 任务保存的 `config.interfaceType` 能匹配该包贡献的 provider ID 或运行时支持的旧别名。
5. 取回时上游给出成功回执，视频地址只有 Luma `assets.video` 或 Runway `output[]` 这种旧解析未覆盖的字段。

### 3.2 各层做了什么

| 层 | 代码位置（均为上述基线） | 观察 |
| --- | --- | --- |
| 引用盘点 | `repository/provider_references.go:56–81` | 失败但持有上游 ID、或日志能补 ID 的任务仍计数；读取 `provider` 与 `input_json`，按任务内协议去重 |
| 盘点汇总 | `app/plugin_references.go:41–61` | 配置、渠道模型、任务计数合到一次启动快照；没有新增持久化状态 |
| 启动接入 | `app/service.go:169` | 实际生产服务使用带引用盘点的插件运行时 |
| 升级推迟 | `plugins/retention.go:144–175` | 清单不同且有 pending 就推迟整个包，未区分修复、请求变更或真正不兼容 |
| 保留旧记录 | `plugins/bootstrap.go:116–119` | `continue` 跳过新包缓存/替换，`byID` 中仍是旧记录 |
| 人工取回 | `app/provider_task_recovery.go:66–164` | 注入当前 registry，补回日志 ID，选择原协议 adapter，再查询、下载和保存；没有另行选新包 |
| fallback | `generation/registry.go:42–45` | 已有注入的 registry 就直接返回，不会用随包最新版覆盖它 |
| 结果为空 | `protocol/manifest.go:667–670`；`generation/protocol.go:946–948` | 旧解析返回成功但 `Result=nil`，取回报错，任务仍失败 |
| 新任务执行 | `app/provider.go:112`；`generation/protocol.go:37–42` | 同样使用当前 registry；不是只给旧任务留下旧定义 |

循环如下：

```text
旧失败任务仍可查询 → 算作协议引用 → 整包更新被推迟
          ↑                            ↓
    任务仍然失败 ← 取回仍然使用缺字段的旧解析器
```

这不是 registry 有多个竞争来源，而是唯一运行定义被错误的升级条件锁住。无需新建第二套 resolver 或专用恢复运行时。

### 3.3 影响范围

| 情况 | 当前行为 |
| --- | --- |
| 旧失败任务，上游 ID 在任务行 | 冻结本次定义变化；已实测 |
| 旧失败任务，上游 ID 仅在请求日志 | 同样冻结；盘点不会回写 ID，人工查询才补回；已实测 |
| 排队/运行中任务 | 也计入 pending，会冻结被引用包；源码及既有盘点测试支持 |
| 取消中、仍有上游 ID 且取消未确认 | 同样计入；不是只有失败任务 |
| 已成功，或失败且任务/日志均无上游 ID | 此任务不计入 pending；若无其他阻碍，可升级 |
| 只有保存配置，且新版仍能解析该 ID | 不冻结；已有测试证明 |
| 无旧安装记录 | 没有可保留定义，照常安装；盘点失败也不阻止全新插件 |
| 已冻结包的新任务 | 使用旧定义，修复同样未生效；从真实注入链确认，未另发模拟创建任务 |
| 同一包贡献多个 provider | 任一被计入的旧任务可拖住整个包，不限于那个 provider |
| 其他协议 | 规则对所有走该官方包 reconcile 的协议适用；不能把“两种视频已复现”扩写成“所有协议解析都坏了” |
| 盘点失败 | 当前会冻结所有定义变化的已有官方包，即使没有删 ID；这是另一种触发条件 |

本次没有修改用户上传包，也没有把 bundled workflow 的独立处理循环当作同一升级机制。

## 4. 免费复现与证据强度

### 4.1 已执行的诊断

使用 Go `-overlay` 临时添加测试，不把测试文件写进产品目录。运行环境为 macOS arm64、Go `go1.26.3`，SQLite 使用独立 `t.TempDir()` 数据目录；假上游只监听测试回环地址。未启动应用、worker 或 dev server。

步骤：

1. 由 `v2.0.4` 清单制作临时插件包，通过真实 `NewLocal` 初始化 SQLite 中的旧 registry。
2. 写入合成 `failed` 视频任务，分别测试行内 ID 和日志 ID，然后关闭服务与数据库。
3. 临时发行目录换为当前清单，重新启动；断言引用计数为 1、升级被推迟且没有 `retired` 标记。
4. 调用真实 `QueryFailedVideoTask`。假上游返回官方成功回执；断言解析失败、未下载、零 POST。
5. 再按真实带盘点构造器重建运行时，断言仍推迟。
6. 对照实验：使用**已有的无引用盘点构造器** `newPluginRuntimeWithStore`，仅在临时数据库中装入新版；原失败任务不删除、不更换协议、不改成成功来逃过检查。
7. 再调用同一人工取回入口，验证原任务 `READY`、资源和素材登记成功、实际文件字节一致。

第 6 步只隔离“是否安装新版定义”这个变量，**不是给真实用户的操作办法，也不是推荐产品提供绕过盘点开关**。

| 子例 | 新版正常启动 | 装入新版的对照组 | 每子例网络计数（含失败取回与成功取回） |
| --- | --- | --- | --- |
| Luma，任务行 ID | 冻结、取回失败 | 同任务恢复并保存视频 | 0 POST / 2 查询 GET / 1 下载 GET |
| Luma，请求日志 ID | 冻结、取回失败 | 同任务恢复并保存视频 | 同上 |
| Runway，任务行 ID | 冻结、取回失败 | 同任务恢复并保存视频 | 同上 |
| Runway，请求日志 ID | 冻结、取回失败 | 同任务恢复并保存视频 | 同上 |

最终执行结果：`TestAuditOldVideoRegistryFreeze` 顶层 1 项、子例 4 项全部通过；`internal/app` 用时 1.857s。测试中的“通过”表示成功复现故障并完成对照，**不是产品修复通过**。

交付前直接从本文提取附录 A 脚本再次执行，四个子例仍通过（包耗时 1.973s）；附录 B 与实际执行的夹具源码逐字核对一致。

另执行当前 `internal/plugins` / `internal/repository` 的保留、升级及引用相关测试：26 个顶层用例、2 个子例通过，包耗时分别为 0.602s / 0.936s。它们确认现行规则按原设计工作，并不否定跨模块冲突。

### 4.2 实验证据的限制

- Luma 假上游同时接受旧错误路径 `/v1/dream-machine/...` 和新版正确路径 `/dream-machine/...`，以便隔离解析问题。Runway 假上游接受有/无版本头。**这个实验没有证明旧错误请求能在官方生产服务上成功，也没有证明任意中转地址兼容新版。**
- 没有跑真实桌面升级、UI、付费生成或全量回归；没有把现有 `TestRunVideoTaskReads...` 的内容阅读写成这轮的测试结果。
- 新任务受旧 registry 影响有源码证据，但本轮完整运行验证集中在已有失败任务；实施阶段仍需补新建路径。
- #51 测的是“有任务应保留旧定义”，结果修复测试直接加载新包；两组分别通过，缺的是“有真实旧 registry 的升级后恢复”这个组合。

## 5. #39 的依据复核：撤下保护成立，整包冻结不是上游通行要求

本轮只复查影响本次决定的官方材料；不重新扩展 LiteLLM、OpenRouter、one-api / new-api 等路由研究。外部比较的问题是：已有引用是否要求永远使用旧实现，还是要求兼容更新后仍可使用原配置和远程对象？

| 官方依据 | 本轮确认的事实 | 对 BeefTV 的适用结论与限制 |
| --- | --- | --- |
| [Grafana 插件弃用政策](https://grafana.com/legal/plugin-deprecation/) | 从搜索/插件视图移除后，旧安装仍加载；直链/CLI 安装与隐藏目录不是同一动作 | 支持保留已被使用的撤下插件；没有要求有旧对象就禁止更新。Grafana AGPL-3.0，只参考思路，不复制实现 |
| [VS Code 扩展弃用](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#deprecating-extensions) | 不自动迁移或卸载已安装的弃用扩展，替代项通过迁移操作选择 | 支持不擅自换协议；不能推出冻结同协议的 bug 修复。VS Code 源码 MIT，本轮只读文档 |
| [Home Assistant 弃用](https://developers.home-assistant.io/docs/deprecating/) | 仍被使用的实体先保留；永久失效集成保留能解释错误的 stub；被替代的集成阻止新建条目 | 支持将弃用、永久停服、正常升级分开；不承诺供应商关闭后还能取回。源码 Apache-2.0，本轮只读文档 |
| [Terraform Framework 兼容演进](https://developer.hashicorp.com/terraform/plugin/framework/deprecations) | patch/minor 建议保持向后兼容；移除在 major 发生；重命名期间同时支持新旧字段 | 支持维护者兑现兼容更新，不能把对象存在等同于版本永不变。Framework MPL-2.0，只参考规则 |
| [Terraform init](https://developer.hashicorp.com/terraform/cli/commands/init) | lock file 保留已选 provider 版本，显式 `-upgrade` 可选择符合约束的新版 | 锁文件是明确版本选择机制，不是根据资源是否存在禁止升级；不照搬 Terraform 的升级交互或整个版本管理系统 |

**推论（本报告的建议，不是外部文档原话）：**正常兼容更新应让旧数据和远程任务继续由新版实现处理；确实不兼容时才需要独立旧实现/显式迁移。#39 的“有任务即推迟”是当时为缺少版本绑定作出的本地保守取舍，并非这些项目共同证明的必要规则。

原 BYOK 7.3.3 的前提是“需要保留旧版查询解析器”。本次任务恰恰需要新版解析器；将前提扩成“任何待取回任务”造成死循环。因此建议修订 #39 第 3.4、4.1、5、6 节与 `plugin-retention.md` 对正常更新的描述；不撤销它们对删除仍被使用协议的保护。

## 6. 推荐的最小改法

### 6.1 保存什么，更新什么

| 操作 | 建议处理 | 依据 |
| --- | --- | --- |
| 正常、兼容的同协议更新 | 更新当前 registry 的实现；保留用户启停状态、配置协议 ID、旧任务和原请求身份 | 本轮四个恢复对照；Terraform 兼容演进；现有单 registry 架构 |
| 整包撤下，有旧配置或待取回任务 | 保留现有定义及现有可用包记录，保持 `retired` 投影 | Grafana / Home Assistant；#51 已有实现和回归 |
| 整包撤下，无引用 | 按现有启动清理 | 原产品需求及既有测试；不增加时间阈值 |
| 新包删除或改名被引用的 provider ID / 别名 | 暂缓替换旧包，或发行时继续提供旧 provider；统计配置与任务两类引用 | 防止 `Resolve` 直接失去对象；复用 #51 旧别名规则 |
| 同 ID 实际改为不兼容查询合同 | 不能靠“同 ID”放行；发行中保留旧 ID 对应的旧实现，新合同使用另一 ID | 旧任务仍需查询同一远程对象；不是增加运行时猜测过滤器 |
| 盘点失败 | 撤下/可能删除旧 ID 的更新保留旧定义；完整保留原可解析 ID 的兼容更新不因盘点失败自动冻结 | 无删除时无需用引用数量阻止修复；删除时仍无法证明无人使用。此项是本地推导，需专项回归 |

正常更新不改变已保存配置，不把任务的 `failed` 改成成功，不清空上游 ID，不删除历史任务来解除冻结，也不自动重新生成。

### 6.2 落到现有模块

1. **`plugins/retention.go`**：删除 `snapshot.total(stored).PendingTasks > 0` 对所有定义变化的无条件推迟。复用现有 ID 解析逻辑，把 `configuredOnlyIn` 的判断扩成“新版不再解析的 ID 上仍有 `Configured` 或 `PendingTasks` 引用”。别名仍来自 `protocol.ResolvableIDs`，不重写别名表。
2. **盘点失败的判断顺序**：先检查新定义是否保留旧定义的全部可解析 ID；全部保留时无需引用盘点证明可以更新。存在移除且盘点不可读时仍暂缓；盘点可读时只检查被移除的 ID 是否有人引用。包名不能代替 provider ID 可解析性的证明。新清单合法性继续依赖既有包校验和加载，不另加“安全字段”名单。
3. **`bootstrap.go`**：继续使用同一个 `deferralFor` 结果、包缓存、registry 提交和启停状态复制；不在人工恢复路径另拼一个“更新后的解析器”。调整已有注释，不新建第二套升级服务。
4. **`repository/provider_references.go` / `app/plugin_references.go`**：保留可恢复失败任务与日志 ID 的盘点。它们对撤下与删 ID 的保护仍然必要；本次不改任务状态范围来掩盖问题。
5. **协议包与文档**：维护更新必须携带旧回执、原任务查询和新请求的本地回归；真正不兼容时保留旧 ID / 旧包，通过现有机制供旧任务使用。同步版本号和文档，使维护者可以辨认更新，但不把 semver 比较当运行时兼容证明。

这里新增的是对现有保护条件的收缩，不是一个自动语义兼容分类器。没有可靠方法仅靠 manifest 差异猜测厂商是否仍接受旧任务；用白名单放行两家供应商只会把下一次相同问题留给其他协议。

### 6.3 本次两包的具体检查

| 包 | 已证实的修改 | 实施时必须保留/验证 |
| --- | --- | --- |
| Luma | `response.assets.video`；`dreaming → processing`；`poll.originPath=true`；创建映射、媒体要求和验证变化；版本仍 `2.0.0` | 原 `taskId` 的 GET；根地址与带子路径地址的预期请求；旧 `video_url` 等回执兼容；`fail_reason` 原分支已被新版 message 表达式去掉，须保留或给出明确的不兼容理由 |
| Runway | `response.output` 数组；poll 新增 `X-Runway-Version: 2024-11-06`；创建字段和验证变化；版本仍 `2.0.0` | 原 `taskId` 的 GET 与版本头；旧 URL 字段和 `output.url` 对象回执；`output` 对象非空时不能只以 `$coalesce` 列表仍含旧分支就认定兼容 |

Luma 官方现有 [Python 视频指南](https://docs.lumalabs.ai/docs/python-video-generation)展示凭创建所得 ID 查询并读取 `generation.assets.video`。Runway 官方 [SDK 成功回执类型](https://github.com/runwayml/sdk-python/blob/main/src/runwayml/types/task_retrieve_response.py)声明 `output: List[str]`；[SDK 许可证](https://github.com/runwayml/sdk-python/blob/main/LICENSE)为 Apache-2.0。本轮只依据字段合同编写自有夹具，没有复制 SDK 实现。Runway 网页 API 正文未正常展示，改读该官方源码，不把侧栏当正文证据。

Luma 的 `originPath` 会替换地址中的路径；一个过去依赖旧拼接错误才能工作的中转不能自动算作已兼容。当前证据只支持官方路径与夹具合同。若验收确认存在必须继续支持的旧路径合同，应保留相应旧协议实现，不能用域名猜测、404 后换路径试发或重新 create 来补救。

### 6.4 不选的方案

| 方案 | 不推荐原因 |
| --- | --- |
| 从引用盘点排除所有 failed 任务 | 会在撤下时删掉实际还能取回视频的协议；违背 #51 已验证的恢复调用链 |
| 只放行 Luma / Runway，或只放行几个 response 字段 | 厂商特例不断增长；本次还包含查询路径/请求头变化，字段名单也不能证明兼容 |
| 保留整包冻结，要求用户先把任务处理完 | 本次任务正需要修复后才能处理完；会推动用户删任务或重做生成 |
| 所有更新都无条件覆盖，不再保护移除的 ID | 会直接破坏旧配置与旧任务解析，丢掉原本合理的保护 |
| 任务 digest + 多版本包仓库 | 本次无需，涉及任务持久化、包回收及选择逻辑；且永久锁住有缺陷解析器本身并不能解决问题 |

## 7. 实施后的免费回归要求

下表是后续产品修改的验收要求，**除明确注明本轮已复现的诊断之外，均未执行为修复验收**。

| 场景 | 必须断言的结果 |
| --- | --- |
| 本文四个旧 registry + failed 子例 | 改用正常 `NewLocal` 启动就安装新版；删去诊断用无盘点构造器；原任务取回为 READY、文件正确、无 POST |
| 旧运行中任务，已有上游 ID | 更新后继续查询同一 ID；不执行 create；拿到新结果字段 |
| 同包新任务 | 在有旧待取回任务时也使用新版创建/查询映射；本地假上游完成创建、查询、下载 |
| 正常旧回执 | 旧 `video_url`、`output.url`、错误字段等仍按约定解析；字段缺失不伪装成功 |
| Luma 路径 / Runway 请求头 | 精确断言 URL、方法、原任务 ID、版本头和凭据来源；不只检查状态成功 |
| 已保存配置引用被移除 ID | 仍保留旧记录和可解析实现；启停状态不变 |
| 只有任务引用被移除 ID | 同样保留，含日志 ID、运行中、取消未确认；防止删除宽泛 pending 分支后漏保护 |
| 旧别名 `openai-video` | 保留/移除判断与 `Registry.Resolve` 一致；同名包不等于旧 provider 仍可用 |
| 整包撤下 | 有引用保留并标记，零引用清理，未知引用保留；保持现有前端范围，不在本次修改默认列表 |
| 盘点失败 | 保留所有原可解析 ID 的正常更新可以安装；移除 ID 或整包撤下仍保留旧定义 |
| 多 provider 包 | 保留所有仍被引用的 ID；一个仍存在的 provider 的任务不挡住正常更新 |
| 重启、重复启动、回退 | 新清单安装后持久化，重复启动不恢复旧冻结记录；配置/任务 ID 不改；回退清单的实际请求行为可重放验证 |
| 禁用包、用户包、缺包 | 不重新启用用户停用包；不扩大为用户上传包的自动更新；继续通过已有缺包/来源保护用例 |
| 现有恢复行为 | 视频失败只查询，图片原身份恢复/重放规则不变；不要用本次规则改写重试、租约或授权 |

修改旧测试时应改合同，而不是删断言：`TestDeferredUpgradeKeepsTheOldQueryDefinition` 的“同 ID 任意变更都冻结”预期不再合适；拆成“兼容更新采用新版”和“删除被引用 ID 保留旧实现”。`TestFailedAuditDefersUpgradeOfShippedPlugin` 也要按是否移除 ID 分开。仓库引用盘点测试继续保留。

最小相关测试范围：plugins / repository 的保留与引用、app 的启动升级与人工视频取回、generation/protocol 的两包请求响应和既有恢复。只有这些通过，才能把本问题记为已修复；本轮结论不能代替发布任务的其他检查。

## 8. 迁移、回退与交接

- 不需要数据表迁移，不改写用户模型配置或历史任务；修复应在下次正常启动更新 registry。继续使用现有提交机制，避免启动成功但只更新内存。
- 回退应用并不等于所有定义都会按期望回退。当前运行时没有“只升不降”的 semver 判断，旧包和新包可能版本号相同；必须用实际清单、旧任务和回退后的调用记录验证。回退到缺字段版本可能重新失去取回能力，不能承诺无损继续取回。
- 若兼容回归失败，保留旧协议实现并把不兼容合同分为不同 ID；不要删除用户任务，也不要临时加厂商放行名单。
- 建议 Chief 按第 6–7 节安排最小后台修订，修改相应既有设计文档，再回到 #76 的免费发布验收。本报告本身不批准或执行发布。

## 附录 A：复现命令

在上述固定提交的仓库根目录运行以下 Python。它会从本文附录提取 Go 诊断测试，使用 `-overlay` 编译；仅创建临时文件和临时数据库。需要 Go、Git、SQLite 的 CGO 环境和仓库已有媒体夹具；不需要真实凭据，不需要预先打包全部插件。

```python
from pathlib import Path
import json, os, subprocess, tempfile

root = Path.cwd()
report = root / "docs/research/video-protocol-upgrade.md"
text = report.read_text()
source = text.split("\n<!-- audit-go-start -->\n", 1)[1].split("\n<!-- audit-go-end -->", 1)[0]
source = source.strip().removeprefix("```go\n").removesuffix("```")
with tempfile.TemporaryDirectory(prefix="beeftv-protocol-audit-") as directory:
    temp = Path(directory)
    test = temp / "audit_test.go"
    test.write_text(source)
    for name in ("luma-dream-machine", "runway-video"):
        ref = "542124baadcdbe5ce34ba9029ef7f1d192b49d16:plugin-packages/" + name + "/manifest.json"
        (temp / (name + ".json")).write_bytes(subprocess.check_output(["git", "show", ref]))
    overlay = temp / "overlay.json"
    overlay.write_text(json.dumps({"Replace": {
        str(root / "backend/internal/app/protocol_upgrade_audit_test.go"): str(test)
    }}))
    env = dict(os.environ, AUDIT_FIXTURE_DIR=str(temp))
    subprocess.run([
        "go", "test", "-overlay=" + str(overlay), "./internal/app",
        "-run", "^TestAuditOldVideoRegistryFreeze$", "-count=1", "-v"
    ], cwd=root / "backend", env=env, check=True)
```

既有定向测试命令（在 `backend/`）：

```sh
go test ./internal/plugins ./internal/repository \
  -run 'Test(Retains|DropsOfficial|DeferredUpgrade|Upgrade|SavedConnection|FailedAudit|TaskProviderReferences|TaskProtocols|InputProtocol|ChannelModelProtocolReferences|Retention|RuntimeWithoutAudit)' \
  -count=1 -v
```

## 附录 B：诊断夹具源码

本夹具刻意断言当前故障；实施修复后必须按第 7 节改为正常升级成功的回归，不能把原样通过当成修复成功。

<!-- audit-go-start -->
```go
package app

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/plugins"
	"infinite-canvas/backend/internal/protocol"
)

// 仅诊断：复用真实盘点、启动、人工取回和入库，不修改产品代码。
func TestAuditOldVideoRegistryFreeze(t *testing.T) {
	for _, id := range []string{"luma-dream-machine", "runway-video"} {
		for _, logOnly := range []bool{false, true} {
			name := id + "/row-id"
			if logOnly {
				name = id + "/log-id"
			}
			t.Run(name, func(t *testing.T) {
				allowLoopbackProviderTest(t)
				oldRaw, err := os.ReadFile(filepath.Join(os.Getenv("AUDIT_FIXTURE_DIR"), id+".json"))
				if err != nil {
					t.Fatal(err)
				}
				newRaw, err := os.ReadFile(filepath.Join("../../../plugin-packages", id, "manifest.json"))
				if err != nil {
					t.Fatal(err)
				}
				release := t.TempDir()
				t.Setenv("CANVAS_OFFICIAL_PLUGIN_DIR", release)
				ship := func(raw []byte) {
					var b bytes.Buffer
					z := zip.NewWriter(&b)
					f, err := z.Create("manifest.json")
					if err != nil {
						t.Fatal(err)
					}
					if _, err := f.Write(raw); err != nil {
						t.Fatal(err)
					}
					if err := z.Close(); err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(filepath.Join(release, id+".beeftv-plugin"), b.Bytes(), 0600); err != nil {
						t.Fatal(err)
					}
				}
				ship(oldRaw)
				payload, err := os.ReadFile("testdata/reference-fragmented-30fps.mp4")
				if err != nil {
					t.Fatal(err)
				}
				var posts, polls, downloads atomic.Int32
				var server *httptest.Server
				server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.Method != http.MethodGet {
						posts.Add(1)
						http.Error(w, "unexpected write", 400)
						return
					}
					if r.URL.Path == "/video.mp4" {
						downloads.Add(1)
						w.Header().Set("Content-Type", "video/mp4")
						_, _ = w.Write(payload)
						return
					}
					// 两种 Luma 路径均返回同一回执，隔离查询路径错误与解析错误。
					valid := r.URL.Path == "/dream-machine/v1/generations/original" || r.URL.Path == "/v1/dream-machine/v1/generations/original"
					if id == "runway-video" {
						valid = r.URL.Path == "/v1/tasks/original"
					}
					if !valid {
						t.Errorf("unexpected path %s", r.URL.Path)
						http.NotFound(w, r)
						return
					}
					polls.Add(1)
					w.Header().Set("Content-Type", "application/json")
					if id == "luma-dream-machine" {
						_ = json.NewEncoder(w).Encode(map[string]any{"id": "original", "state": "completed", "assets": map[string]any{"video": server.URL + "/video.mp4"}})
					} else {
						_ = json.NewEncoder(w).Encode(map[string]any{"id": "original", "status": "SUCCEEDED", "output": []string{server.URL + "/video.mp4"}})
					}
				}))
				defer server.Close()
				dir := t.TempDir()
				svc, db := openDBRuntimeMatrix(t, dir)
				input, err := json.Marshal(canvasGenerationInput{Mode: "video", Config: providerConfig{BaseURL: server.URL, APIKey: "audit-fixture", Model: "fixture", InterfaceType: id}})
				if err != nil {
					t.Fatal(err)
				}
				now := time.Now()
				task := model.Task{ID: "audit-task", UserID: "local", Type: "canvas_video", Status: model.TaskStatusFailed, ProviderRequestID: "original", InputJSON: string(input), CreatedAt: now, UpdatedAt: now}
				if logOnly {
					task.ProviderRequestID = ""
				}
				if err := db.Create(&task).Error; err != nil {
					t.Fatal(err)
				}
				if logOnly {
					if err := db.Create(&model.ApiCallLog{ID: "audit-log", UserID: "local", TaskID: task.ID, Capability: "video", ProviderRequestID: "original", CreatedAt: now}).Error; err != nil {
						t.Fatal(err)
					}
				}
				closeDBRuntimeMatrix(t, svc, db)
				ship(newRaw)
				svc, db = openDBRuntimeMatrix(t, dir)
				defer closeDBRuntimeMatrix(t, svc, db)
				counts, err := svc.repo.TaskProviderReferences()
				if err != nil || counts[id] != 1 {
					t.Fatalf("references=%v err=%v", counts, err)
				}
				view, ok := plugins.ByID(svc.pluginRuntime.List(), id)
				if !ok || view.Retention == nil || view.Retention.Retired {
					t.Fatalf("expected deferred active plugin: %+v", view.Retention)
				}
				oldAdapter, ok := svc.protocolRegistry().Resolve(id)
				if !ok {
					t.Fatal("missing retained adapter")
				}
				_, err = svc.QueryFailedVideoTask(context.Background(), "local", task.ID)
				if err == nil || !strings.Contains(err.Error(), "声明式协议已完成但没有返回") {
					t.Fatalf("expected parser failure, got %v", err)
				}
				if posts.Load() != 0 || downloads.Load() != 0 {
					t.Fatalf("unexpected requests posts=%d downloads=%d", posts.Load(), downloads.Load())
				}
				// 再次启动仍冻结；仅重建运行时，不启动 worker。
				svc.pluginRuntime, err = newPluginRuntimeWithReferences(dir, plugins.NewRepositoryStore(svc.repo), newPluginReferences(dir, svc.repo))
				if err != nil {
					t.Fatal(err)
				}
				view, _ = plugins.ByID(svc.pluginRuntime.List(), id)
				if view.Retention == nil {
					t.Fatal("freeze disappeared without resolving task")
				}
				// 对照组：用既有无盘点构造器安装随包定义，任务和输入原样保留。
				// 此构造器只用于诊断，不是建议给产品添加的绕过开关。
				svc.pluginRuntime, err = newPluginRuntimeWithStore(dir, plugins.NewRepositoryStore(svc.repo))
				if err != nil {
					t.Fatal(err)
				}
				newAdapter, _ := svc.protocolRegistry().Resolve(id)
				before, _ := oldAdapter.BuildPoll(context.Background(), protocol.PollContext{TaskID: "original"})
				after, _ := newAdapter.BuildPoll(context.Background(), protocol.PollContext{TaskID: "original"})
				result, err := svc.QueryFailedVideoTask(context.Background(), "local", task.ID)
				if err != nil {
					t.Fatal(err)
				}
				if !result.Recovered || result.Task.ID != task.ID || result.Task.ProviderRequestID != "original" || result.Task.ResultState != "READY" || len(result.Task.Outputs) != 1 || result.Task.Outputs[0].MaterializedAssetID == "" {
					t.Fatalf("incomplete recovery: %+v", result)
				}
				if posts.Load() != 0 || polls.Load() != 2 || downloads.Load() != 1 {
					t.Fatalf("requests posts=%d polls=%d downloads=%d", posts.Load(), polls.Load(), downloads.Load())
				}
				var resource model.Resource
				if err := db.First(&resource, "id = ?", result.Task.Outputs[0].ResourceID).Error; err != nil {
					t.Fatal(err)
				}
				saved, err := os.ReadFile(filepath.Join(dir, "resources", filepath.FromSlash(resource.ObjectKey)))
				if err != nil || !bytes.Equal(saved, payload) {
					t.Fatalf("saved bytes differ: %v", err)
				}
				t.Logf("freeze=true; unchanged-task recovery=READY; posts=%d polls=%d downloads=%d; old poll=%+v; new poll=%+v", posts.Load(), polls.Load(), downloads.Load(), before, after)
			})
		}
	}
}
```
<!-- audit-go-end -->
