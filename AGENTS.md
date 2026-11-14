# AGENTS.md

本文件是BeefTV仓库中 AI、自动化工具和协作者的工作约定。用户当前任务优先于本文件；本文件优先于个人习惯。所有结论应能回溯到代码、配置、测试、日志或文档，不用历史印象替代现状。

## 1. 项目边界

BeefTV（`glanderness/BeefTV`）是面向 AI 影视与短剧创作的工作台，当前仍在快速开发。公开接口、数据结构和部署配置可能直接调整；除非任务明确要求，不为旧字段、旧 API 或旧数据增加兼容层。

仓库由几个边界清晰但可独立运行的单元组成：

| 单元 | 技术栈 | 入口 | 责任 |
| --- | --- | --- | --- |
| `web/` | Vite、React 19、TypeScript、React Router、Ant Design、Tailwind、Zustand、TanStack Query | `web/src/application.tsx`、`web/src/router.tsx` | 工作区 UI、画布交互、浏览器缓存、API 调用和模型协议适配 |
| `backend/` | Go 1.26、Gin、GORM、SQLite | `backend/cmd/desktop`、`backend/cmd/server` | 本地工作区 API、持久化任务、资源和外部模型协议适配 |
| `docs/` | Next.js、Fumadocs、MDX | `docs/content/docs/` | 面向用户和开发者的专题文档；构建配置见 `docs/source.config.ts` |

根目录脚本负责 Wails 与本地开发验证。主线不依赖 PostgreSQL、Redis、登录或多租户部署。

## 2. 开始工作前

1. 先读取任务涉及的入口、调用方、配置、锁文件和相邻测试；先理解现状，再决定是否抽象或重构。
2. 使用 `rg` / `rg --files` 搜索，优先并行读取相关文件。不要为了“统一风格”改动无关模块、依赖、格式或用户已有修改。
3. 先形成目标边界：页面负责什么、service 负责什么、handler/service/repository 如何分层、数据和错误如何流动。新增 helper 必须消除真实重复或隔离明确协议，不能只透传参数。
4. 检查 `git status --short`。不覆盖、不回滚、不清理非本次产生的变更；不使用 `git reset --hard`、`git checkout --` 或宽范围删除。
5. 手工编辑使用 `apply_patch`；默认使用 ASCII，业务中文或已有 Unicode 文件除外。注释只解释非直观算法、核心入口、安全边界和降级原因。

## 3. 目录职责和依赖方向

### 前端

- `web/src/pages/`：路由页面及页面私有 hook/组件；页面协调流程，不直接拼装后端协议。
- `web/src/layouts/`：路由级布局、全局浮层和页面壳；不要在页面重复设置全局 body 状态。
- `web/src/components/`：真实跨页面复用的 UI 或交互能力；页面私有组件留在页面目录。
- `web/src/services/api/`：业务 API、模型渠道协议、资源 API；不依赖 JSX、路由或 AntD 提示。
- `web/src/services/`：文件、媒体、同步、缓存和生成任务等跨页面副作用。
- `web/src/stores/`：跨页面状态和持久化配置；页面临时状态留在页面，媒体大对象不进 `localStorage`。
- `web/src/lib/`：纯函数、画布算法、协议转换、设计 token 和可独立测试的基础能力。
- `web/src/styles/globals.css`：变量、重置和必要的第三方覆盖；页面样式优先使用现有 token 或页面样式。

### 后端

- `backend/internal/handler/`：HTTP 入参、本地 workspace context、调用领域端口和统一响应；不放数据库查询。
- `backend/internal/bootstrap/` 与 `backend/internal/localapp/`：本地组合根和窄端口；启动层不得重新暴露巨型 `app.Service` 方法集。
- `backend/internal/task/`、`asset/`、`project/`、`generation/`：本地领域合同与实现；新合同不得反向 import `internal/app`。
- `backend/internal/app/`：跨域编排和尚未拆出的核心实现。Provider、Protocol、自定义渠道和插件是必须保留的本地扩展能力。
- `backend/internal/repository/`：GORM 查询和持久化；不承载业务策略。
- `backend/internal/model/`：结构、枚举和简单模型方法；不调用外部服务。
- `backend/internal/provider/`：模型供应商能力和协议实现。
- `backend/internal/database/`：数据库连接、迁移和连接池。
- `backend/cmd/`：可执行入口、迁移和启动配置；启动参数不得绕过数据目录约束。

调用链应保持为：`HTTP -> handler -> localapp/domain port -> app/domain implementation -> repository/model`；需要模型上游时进入 `generation` / `provider` / `protocol` / `outbound`。

### 插件和文档

- 宿主内核只承载通用工作区、画布基础交互与渲染修复；自带密钥的第三方或本地模型协议统一通过 `registerModelProtocol` 放进 `plugin-packages/`，专用创作流程做成插件槽位或节点扩展，不塞进宿主主干，也不在客户端内联复制服务端预设配置副本或绑定特定上游网关名称。
- 修改 `docs/` 前确认内容属于专题文档，而不是把长篇说明重新复制到根 README。目录索引见 `docs/index.md`。

## 4. 前端 API 和状态合同

### 后端业务 JSON

业务 API 的唯一调用入口是 `web/src/services/api/request.ts` 导出的 `http`：

- 模块写 `http.get/post/put/patch/delete`，由 `http` 解包 `{ code, data, msg, reason }`。不要再写 `request(apiClient.*)`，也不要再 `axios.create`。
- 二进制或非信封响应用 `http.raw`（CSV、诊断包 zip）。
- `apiClient` 只留给拦截器和 `http` 内部；默认 `VITE_CANVAS_BACKEND_URL || "/api"`。
- `request()` 仍可用于测试信封解包，不是业务模块的调用面。
- 后端成功响应为 `{ code: 0, data: T, msg: string }`；HTTP 200 不等于业务成功，`code !== 0` 必须抛错。失败时用 `ApiError.reason` / `ApiError.code` 判断类型，不要解析 `msg`。错误码见 `web/src/services/api/error-codes.ts` 与 `docs/content/docs/backend/http-api.mdx`。
- OpenAPI 3.0 在 `GET /api/openapi.yaml`。不要从规范生成 TypeScript 客户端来替换 `http` 模块。
- API 模块定义并导出接口类型；页面和 React Query 直接接收解包后的 `data`，不重复访问 `.data.data`。
- 查询参数使用 `compactApiParams` / `serializeApiParams`；取消请求传递 `AbortSignal` 并保留取消语义。
- 后端已提供分页、筛选或分类统计接口时，筛选条件、关键词匹配与分类计数必须在后端 SQL 查询阶段先过滤再分页；禁止前端循环翻页拉全表做内存假分页，禁止把业务对象或 `metadata` 直接 `JSON.stringify` 做文本搜索。
- `FormData` 不手动设置 `Content-Type`，让 Axios 生成 boundary。写路径失败必须向上抛出，不能 `catch { return defaultValue }`。

### 模型渠道和流式请求

- 自定义渠道 URL/Header 仍由 `custom-channel-relay.ts` 的 `channelRequest` 解析；实际发出走 `channel-transport.ts` 的 `createChannelTransport`。image / video / audio 只组协议 payload，不再各自 `axios + channelRequest`。
- 自定义渠道由本地后端 `/api/ai/custom` 中转；重建 headers 时清除 `x-goog-api-key` 和旧的 `X-Canvas-Upstream-Headers`，不得把第三方密钥放入浏览器 URL。
- Provider 特有 payload、响应解包和状态机留在对应 `image.ts`、`video.ts`、`audio.ts`；不要塞进通用 `request.ts`。
- 原始 `fetch` 仅用于媒体 blob/data URL、资源、Worker 或 SSE；必须检查 `response.ok`，传递正确的 `credentials` 和 `signal`。
- 文本任务 SSE 是 `GET /api/tasks/:id/text-events`，游标是递增事件 `id`；断线使用 `Last-Event-ID` 或 `?after=`，不能把任务 ID 当游标。
- 代理只对文本任务和明确的系统模型事件流路径关闭缓冲/缓存/gzip；不要给所有 `/api/` 请求复制长超时和 `proxy_buffering off`。

### 数据、缓存和写路径

- 画布、项目、任务、素材和大 JSON 使用按工作区命名空间区分的 `localforage`；`localStorage` 只保存小型配置、当前命名空间或 UI 偏好。命名空间（`getActiveUserScope` / `scopedStorageKey`）只用于区分本地存储，改动会让用户读不到已有数据。
- BeefTV 不管账号：每个后端进程只服务一个本地工作区，运行中不会切换。账号、登录、钱包、余额和扣费归服务端 API；BeefTV 只记当前服务端连接，切换连接时刷新模型能力目录。不要为"异步操作期间切换账号"加保护或测试；异步写回只需核对画布、项目、节点是否仍是原目标。
- 任务状态与可操作动作（重试、继续取回、失败原因）只认后端 `task.outcome`（`phase`、`regenerate`、`reason`），前端不自行拼凑覆盖。重新生成节点即使保留上一次成功媒体，只要最新任务处于可继续取回态，仍按最新 `task.outcome` 展示继续取回；继续取回只恢复原 `taskId` 轮询与结果入库，不重复发起上游扣费提交。
- 任务本地权威输出字段（如 `task.outputs[].resourceId`、`storageKey`、`mimeType`）必须在统一解析入口（`parseBackendGenerationResult`）合并进媒体条目，确保生成历史预览、节点回填与插入画布读取同一套媒体源，不在局部按钮分支打补丁。
- 后端不可用时的本地缓存是降级，不代表服务端已保存。UI 必须区分“本地缓存成功”和“服务端持久化成功”。
- 生成、激活、审批、权限、删除、上传、配额、账务和密钥相关操作属于强校验写路径；不使用空 ID、默认用户、默认权限或默认额度兜底。
- 素材删除必须先检查项目、画布、任务和其他业务引用；有引用则保留并返回来源，无引用才清理物理对象。物理删除失败不得删除素材记录。

## 5. 后端响应、权限和安全

- Gin 接口统一返回 `{ code, data, msg, reason }`；失败时 HTTP status 和业务 `code` 都应表达真实失败，不把所有错误包装成 200。机器可读原因放在 `reason`，见 `docs/content/docs/backend/http-api.mdx`。
- 对用户可自行修正的参数、参考素材或审核报错，服务端 API 洗去内部地址、密钥与请求号后须透传具体原因（多参考素材请求须标明第几张，如 `第 3 张参考图（@图片3）`），客户端原样展示，不用笼统的“提交失败，请稍后重试”掩盖真实原因。
- 所有对象读取、更新、删除都在 service 校验当前用户和资源归属；管理员权限在 service 校验，不依赖前端隐藏按钮。
- 默认开放本机回环（`localhost` / `127.0.0.1` / `::1`）和局域网私网模型上游，仅拦截链路本地（`169.254.0.0/16` 等）、未指定与多播地址；需要严格公网隔离的部署可显式设置 `CANVAS_ALLOW_PRIVATE_UPSTREAMS=false` 并通过 `CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS` 精确放行。
- 用户 API Key 保存在浏览器本地，任务创建时可能提交给自部署后端；只在可信部署和 HTTPS 下使用真实密钥。日志、错误上报、URL、localStorage 和持久任务正文不得写入敏感 URL、Cookie 或 API Key。
- 生产必须配置明确的 `CANVAS_CORS_ORIGINS`，保持 HTTPS，限制数据库、备份、数据目录和 `.settings-key` 权限；默认关闭公开注册。
- 数据库字段或表变化时同步更新 `docs/content/docs/backend/backend-database.mdx`，不能只改 GORM model。

## 6. 画布、UI 和设计系统

- 画布组件、状态、算法分别放在 `web/src/components/canvas/`、`web/src/stores/canvas/`、`web/src/lib/canvas/`。事件忽略选择器必须覆盖 modal、popover、dropdown 等浮层。
- 画布拖拽、连接、缩放和快捷键要考虑 pointer capture、滚轮冒泡、焦点以及 `data-canvas-no-zoom` / `data-canvas-wheel-scroll` 边界。
- 节点和对象名称要有可发现的铅笔入口并支持单击编辑；双击或右键不能是唯一入口。图片节点保持原始比例，面板不能长期遮挡主要画布空间。
- Ant Design 共性主题和控件状态集中在 `web/src/lib/app-theme.ts` / `AppProviders`。自带外壳的产品弹窗用 `AppModal flush`，侧栏用 `AppDrawer`；不要再复制 `padding: 0` 的 Modal styles。内容外壳仍是 `.ant-modal-container`。
- 第三方覆盖限定在具体组件，不新增全局 `.ant-modal-*`、`.dark .ant-switch-*`、`.ant-checkbox-*` 或 Segmented 状态补丁。新增 CSS 前先搜索同名选择器，回到唯一源规则修改。
- 遵循 `web/src/components/ui/README.md` 及项目三层 token：Primitive → Semantic → Component。inline style 优先引用 `var(--token-name)`，不要散落颜色、圆角、阴影和层级字面值。
- 主操作、普通选中、Checkbox/Radio、Switch 是不同颜色角色；持久切换使用 `aria-pressed`，`type="primary"` 只表示当前主要命令。尊重 `prefers-reduced-motion`，键盘导航保留 `:focus-visible`。

### 画布外界面结构与样式硬约束

- **统一页面结构与去噪**：画布外页面遵循「页面标题与页面级动作 → 同级导航（按需）→ 单条工具栏（搜索/筛选/排序/刷新）→ 单一主要内容区 → 底部翻页或固定提交区」。工作区壳或页头已有当前页面名时，内容区不再重复同名大标题；层级之间不插入重复副标题、装饰性说明、版本号、技术标识或多个同权重主按钮。删除解释性小字前先确认其不承载费用、授权、错误或未保存状态，删除后同步清理空行盒与残留外边距。
- **布局对齐与单一滚动所有者**：优先复用共享 `PageHeader`（基准 `64px` 页头节奏与共享容器桌面 `40px`、`≤720px` 下 `20px` 内边距）、工作区导航、`PaginationBar`、`AppModal`、`AppDrawer` 与现有卡片壳；页面标题、标签页、工具栏与内容区左边缘对齐，次要或危险操作收进菜单。每个页面或浮层只保留一个主要纵向滚动容器（固定页头与底部动作由父 flex/grid 分配，内容区设 `min-height: 0`，不在外层页面、详情容器和表单上叠加竞争的纵向滚动条）；列表分页复用共享 `PaginationBar`（底部固定居中属共享组件演进目标，统一在共享层调整，页面不写私有定位覆盖）；折叠侧栏、移动导航或详情浮层关闭后不得残留主布局占位宽度。
- **单一样式所有者与覆盖禁令**：每个属性族只保留一个主要所有者（Primitive/Semantic token → 基础组件与第三方适配层 → 工作区壳与产品模式件 → 页面根命名空间组合）。禁止新增 `*-final`、`*-lock` 或追加到文件尾部的兜底覆盖层，禁止页面间用 `!important` 互相压制；页面 CSS 必须限定在页面根选择器内，不能假设懒加载样式会随路由卸载消失。状态使用 `data-state`、`aria-selected`、`aria-pressed` 或明确变体类表达，禁止依赖中文 `aria-label` 文案或 `> div:first-child` 绑定几何与状态；过渡优先 `opacity` / `transform`，禁止 `transition: all`，同一点击只由一层负责反馈。
- **状态真实性与提交流程**：相同对象在发现、安装、持有与详情中的身份由真实 ID、版本与关联关系判定，不按同名推断已安装或可更新。表单折叠高级项保留原值，校验报错自动展开并定位字段；保存或生成期间防止重复提交，异步结果不得回写已切换对象或已关闭表单；错误态不伪装成空态，真实完成后才提示成功。

### 字体、排版与可读性硬约束

- **统一字体入口**：同一系统内的工作区页面、原生控件、AntD 控件与 Portal 浮层（`.app-user-overlays`）保持一致的系统无衬线字体栈，禁止混用字体家族或仅加局部工具类宣称统一；仅源码、命令和技术标识使用 `--font-mono`，需要对齐的计数、时间、金额与表格进度使用 `font-variant-numeric: tabular-nums`。BeefTV 标志的字重与斜体仅限品牌资产，不扩散到标题与导航。
- **标准字号角色与行高**：普通界面字距为 `0`、字形为 `normal`，按完整角色组合使用：`16px/22px`（页面/侧栏/弹窗标题，字重 `500`）与 `16px/24px`（页面内主分区标题，字重 `500`；禁止拿历史 `22px` `--fs-title` 当普通页面标题）、`14px/22px`（条目名称 `500`、可读正文 `400`、导航 `400`；多段长文 `14px/24px`，导航选中只切换主文字色与底色/标记，禁止加粗引起宽度跳动）、`13px/20px`（输入/选择/菜单/分页 `400`，标准按钮 `550`）、`12px/18px`（表单字段标签 `500`、日期与必要辅助说明 `400`、紧凑次级按钮 `550`；注意 `--fs-label` 当前为 `11px`，不等于表单标签）、`12px/20px`（等宽代码）。新增普通 UI 禁用 `7/9/10px` 字号、随意 `620+` 字重、斜体、全大写转换或中文 `tracking-wide`；首页、项目库和资产库既有卡片精调值仅作基准页例外保留，不外推为新页面默认。
- **语义文字色与对比度门槛**：工作区文字引用 `--user-ink`（主文字）、`--user-ink-muted`（简介、日期、必要说明、常态导航）、`--user-ink-soft`（仅占位符与非关键元数据）及 `--user-action-foreground`，不在各页散写 `#999`、`text-white/45` 或对整块文字容器叠加透明度。新增普通文字与实际合成背景对比度须不低于 `4.5:1`（浅色主题下 `--user-ink-soft` 低于 `4.5:1`，需读懂的日期、状态与说明须选 `--user-ink-muted`，深浅主题分别核对）。
- **截断、换行与窄窗口响应**：卡片名称单行省略须保留可访问名称及详情/Tooltip/`title` 完整查看入口；报错、费用、授权与确认文案禁止省略截断。长文件名或 URL 按需使用 `overflow-wrap: anywhere`，禁止全站 `word-break: break-all`；窄窗口优先重排、换行或收纳次要操作，禁止整页 `transform: scale()`、整体缩字号、把 `line-height` 设成控件高度或用逐项 `translateY` 凑图标文字居中。

### 技能列表展示硬约束

- 技能市场、我的技能和我的投稿的列表名称区只展示技能名称。描述、作者、版本、文件数量与脚本文件、兼容性说明、使用条件和其他详情统一放在对应的详情视图中，禁止在列表恢复副标题、摘要或“含脚本”等说明文字。
- 右侧仅保留用户认可的简短灰色来源标识及必要的操作、启用状态和投稿进度。来源标识使用“官方”“我的”“市场”“插件”等短文案，具体来源和权限说明放在提示或详情中，禁止扩展成第二行说明。
- 新增技能信息时先接入详情视图。交付前检查三个子页面的列表，确认名称区没有附加说明，且详情入口能够读取完整信息。

## 7. 本地开发、部署和数据目录

- 先阅读 `.env.example` 和对应 Compose 文件。宿主机后端开发必须使用 Git 忽略的 `.local/project-workbench-debug`，通过 `CANVAS_BACKEND_DATA_DIR` 显式指定；不要把 `backend/data` 当作开发账号数据库。
- 本地缓存放 `.local/cache`；不要提交数据库、上传文件、`.env`、真实密钥、构建产物或编辑器配置。
- 宿主机开发：`backend/` 运行 `CANVAS_BACKEND_DATA_DIR=../.local/project-workbench-debug go run ./cmd/server`，`web/` 使用 Bun 和 Vite；不要用 pnpm/npm 覆盖同一套 `node_modules`，也不要提交 `pnpm-lock.yaml` 或 `package-lock.json`。Docker 热更新使用 `docker-compose.dev.yml`；本地构建运行使用 `docker-compose.local.yml`。
- 单机 Compose 使用 `docker-compose.yml`（SQLite 数据卷，backend、web），源码构建可叠加 `docker-compose.build.yml`。公网只暴露 web 的 `3000`，backend `8080` 留在 Compose 网络内。
- 默认不启动 dev server；只有用户明确要求浏览器预览或联调时才启动，并先确认端口、数据目录和现有进程。
- macOS 本机唯一正式应用路径是 `/Applications/BeefTV.app`。需要更新本机应用时只运行 `./scripts/update-local-beeftv-app.sh`；不将 `build/bin/BeefTV.app` 作为可使用版本保留，不复制、重命名或存档额外 `.app` 副本。
- 健康检查只能证明入口可用，不能替代登录、SSE、任务生成和资源访问验证。

## 8. 验证纪律

项目当前默认不自动运行语法检查、类型检查、测试或构建。用户明确要求验证，或改动风险需要验证时，按范围选择最小充分命令，并在交付中如实记录：

- 前端：`cd web && bun run build`；专项测试用 `bun test ...`。UI 退场规则用 `bun run lint`（只禁 antd Empty 和静态 `Modal.confirm`，不是风格检查）。
- 后端：`cd backend && go test ./...`；涉及资源、任务或权限时补对应集成/冒烟路径。
- 旧内置 Agent 已从产品运行面退场：`/agent/*` 路由不再注册，通用任务创建、任务重试和任务 Worker 拒绝 `cloud_agent`、`cloud_agent_step`、`agent_memory_compact`，旧轮次与记忆压缩调度保持停用，历史数据保留。当前分支的替换内核采用 `agent-host/` 中钉选的官方 pi SDK，Go 管理运行时、业务轮次及操作授权；React 使用 `/api/assistant/*`。宿主只有 Durable 一套执行运行时：旧 JSONL 会话只读历史，在旧会话里发新消息会以交接说明开一条新的 Durable 会话，不恢复旧 SDK 的 create/prompt/replace/abort 执行路径。核对官方 API 与实际接入路径，不能恢复旧入口或另建模型会话循环；零模型宿主验证、真实业务操作、付费模型验收与正式发布分别记证据。
- 文档站：`cd docs && bun run types:check` 或 `bun run build`。
- UI 变更能浏览器验证时，检查关键路由、明暗主题、滚动、弹窗、空态和核心交互；不能验证时说明替代依据，不把静态阅读或 `git diff` 写成运行验证。

同类失败连续三次时停止盲试，记录现象、已排除项和新假设，再切换路径或请求用户决策。

## 9. 文档与交付

- 根 `README.md` 只保留项目定位、能力概览、快速开始、部署、安全和文档入口；详细专题写入 `docs/content/docs/`。
- `README.md` 是根 README 的中文准稿；每次修改 `README.md` 时，同步更新 `README.en.md`，并在两个文件顶部保留语言切换链接。
- 功能与代码地图分别维护在 `docs/content/docs/overview/features.mdx`、`docs/content/docs/backend/code-map.mdx`。尚未确认的实现状态保留在任务或拉取请求中，不写入公开产品文档。
- API、数据表、SSE、资源存储、部署或安全边界变化时同步对应专题文档；不要只改代码和根 README。
- 文档默认中文，不写过期日期，不公开密码、Token、Cookie、真实账号、机器敏感路径、会话编号、飞书表编号、内部授权记录、预算金额、线上日志编号或客户与内部人名；提交说明和 PR 描述里也不写这些内容。命令、端口、环境变量必须以当前脚本和 Compose 为准。
- Git 提交说明使用 `<type>(<scope>): <业务模块> - <变更摘要>`，`type` 为 `feat|fix|refactor|perf|docs|test|build|ci|chore|revert`。
- 团队协作流程（交叉 review、付费授权、预算与合并/发版审批）另见团队私有工作约定，不在公开仓库维护。AI 代理默认不直接合并 PR 或发版。

交付前至少检查：改动是否聚焦、调用方和类型是否同步、错误/权限/数据归属是否完整、必要文档是否同步、验证是否如实说明、是否留下密钥或本地数据，并**主动逐条复核第 10 节「防止屎山」且运行 `node scripts/structure-budget.mjs`**（无需用户提醒）。

## 10. 防止屎山

重构后的结构靠下面几条守住，修 bug 和加功能时同样适用；每次改动提交或交付前必须主动自检，不等用户追问：

- 同一个结论只在一处计算。任务能否重试、能否取回只读后端 `task.outcome`，前端不另行推断或补写；模型能力、协议、扣费结论和错误归类归服务端 API。
- 客户端不加参考素材（尺寸、比例、像素、大小、格式、时长等）预检门禁；上游报错脱敏、真实原因透传与具体素材定位（如「第 N 张参考图 `@图片N`」）统一在服务端 API 完成，BeefTV 只展示与透传。
- 不新增按模型名写的规则。内置渠道的差异交给服务端 API；自带 Key 的第三方渠道写成协议插件（`plugin-packages/`）。
- 新代码不放进 `backend/internal/app`，放到对应领域包；新包不得 import `internal/app`。
- 已发布的数据库迁移版本不改，只追加新版本。
- 测试测行为，不读源码文字做断言。按职责拆分大文件时保持外部行为不变，遇到阻碍正常拆分的旧读源码文本断言测试应直接删除或改为真实行为测试；禁止把已知视觉或渲染缺陷（如深色底深色图标、零尺寸元素）写进测试基线或快照锁死。
- 修 bug 前先查这条规则写在几处；有多处就先合成一处再修。历史预览、节点渲染与插入画布等同一业务的多个入口必须走同一解析或过滤函数。
- 文件超过约 800 行且最近常改、常修时，在本次改动里按职责拆开；不为拆而拆，不为凑旧行数把正常多行代码压成单行。
- `node scripts/structure-budget.mjs` 守住两类规则：① **只降不升预算**（`backend/internal/app` 非测试行数、直接依赖 `*app.Service` 的 handler 数、读源码文字断言的测试数、存量 `>1000` 行大文件白名单；存量文件修 bug 不锁死逐行数字，但严禁新增 `>1000` 行大文件，且 `--update` 默认只允许收紧已减小的指标）；② **零容忍红线**（禁止 `web/test/` 下出现 `>500` 行或 `>64KB` 的超大测试 JSON 夹具、禁止 `web/src/pages/dev/` 下放置未从应用路由入口可达的孤立文件、禁止业务代码用 `JSON.stringify` 做文本搜索筛选）。后端改动同步运行 `node scripts/deadcode-budget.mjs`，死代码只减不增。
- 每周花半小时铲屎：运行 `node scripts/structure-budget.mjs --hotspots 7` 看近 7 天修 bug 最集中的文件，挑一处拆开或合并规则，再运行 `--update` 收紧白名单；发版前关掉已经过时的 PR。
