# BeefTV for DeepSeek Harness

面向 AI 视频创作的 DSH 原生工作台，左侧复用 BeefTV 画布、项目、素材、技能、插件与模型设置，右侧常驻 DSH 原生 Agent。**在 DSH 插件市场安装插件后即可直接使用，无需单独安装 BeefTV 桌面客户端。**

## 运行方式（双模式）

- **本机已有 BeefTV 桌面应用**：自动检测并优先连接本机 BeefTV（macOS / Linux 需 2.2.0+，Windows 需 2.4.3+），共用同一份画布、素材、配置与账号。若本机版本过低，会明确提示升级，不会强行拉起旧版应用。如使用自定义路径的便携版 BeefTV，可通过环境变量 `BEEFTV_LOCAL_APP_DIR` 指定目录。
- **未安装 BeefTV 桌面应用（免安装独立运行）**：
  - 插件本身为纯 JS 跨平台轻量包，支持 macOS（Apple Silicon / Intel）、Windows x64 与 Linux x64。Linux 上需要系统已安装 `libgtk-3`、`libwebkit2gtk-4.1` 以及解压工具 `unzip`（若未安装 `unzip`，会自动尝试 `bsdtar` 或 `python3`）。
  - 首次在 DSH 侧边栏点击「使用独立工作区」时，插件会自动从 BeefTV 官方签名更新源（国内镜像优先、海外官方源兜底）下载当前系统的运行包（解压后约 400–700 MB），完成 Ed25519 签名、SHA256 与压缩包安全校验后解压到插件私有目录（`~/.dsh/storages/beeftv/runtimes/`），启动健康校验通过后再切换当前指针，全程不会在系统应用目录或桌面新增独立应用。
  - 准备完成后，后续打开 BeefTV 面板将直接进入独立工作区；数据保存在 `~/.dsh/storages/beeftv/workspace`，并在顶部标明「独立工作区，和本机 BeefTV 不是同一份数据」。
  - 独立运行环境支持工作台内一键检查更新与升级：在无进行中的生成或工具调用时先后台下载并校验新版本，通过启动健康检查后再平滑切换并回收旧版；若新版本启动失败会自动回滚恢复原可用版本，画布与素材完整保留。
  - 如果之后又安装了本机 BeefTV 桌面端，插件会提示一次是否切换并共享本机数据；点「暂不」后不再重复打扰。
- **离线 / 预装支持**：
  - 方式一（环境变量）：设置 `BEEFTV_HARNESS_RUNTIME_DIR` 指向预置运行包的**根目录**：
    - macOS：包含 `BeefTV.app/Contents/MacOS/BeefTV`（或 `Contents/MacOS/BeefTV`）与对应 `cli/beeftv` 的目录；
    - Windows：包含 `BeefTV.exe` 与 `cli/beeftv.exe` 的目录；
    - Linux：包含 `BeefTV-linux/BeefTV`（或 `BeefTV`）与对应 `cli/beeftv` 的目录。
  - 方式二（插件托管目录预置）：将对应平台运行包放入 `~/.dsh/storages/beeftv/runtimes/<目录名>/`，并在 `~/.dsh/storages/beeftv/runtimes/current.json` 写入：
    ```json
    { "version": "v2.4.2", "dir": "v2.4.2-darwin-arm64", "platform": "darwin-arm64" }
    ```
    开机无需联网下载即可直接使用（托管更新只会清理带插件归属标记的旧版目录，不会删除用户预置目录）。

## 创作协作特性

- 生成复用 BeefTV 的提议与审批机制；审片会调用审片模型，可能收费，提交前同样会询问。模型推理使用 DSH 当前模型配置。
- 画布选中节点后点「问助手」，选中的内容会填到右侧输入框，不会自动发送。
- 提交生成后会自动等结果，完成时在对话里接着做，不用再问一句。工作台菜单里可以关闭「生成完自动继续」，也可以调整每轮步数上限（默认 40 步）。点停止后，这一轮不会再自动继续。
- 关闭 DeepSeek Harness 或断开连接期间完成的生成不会自动续跑；重新打开 BeefTV 面板时会提示一次「有 N 个生成在你离开时完成。」

## 安装与开发调试

直接安装轻量跨平台插件包（推荐，用户无需单独下载 BeefTV）：

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add dsh-beeftv
```

本地源码调试安装：

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add "file:$(pwd)/plugins/deepseek-harness"
```

标准插件发布包默认不含平台二进制（纯 JS 轻量包，跨平台通用）。如确需制作单平台离线预装包（体积会增加约 150 MB+），可在本地用 `node plugins/deepseek-harness/package-runtime.mjs` 准备 `runtime/` 目录，再按离线预装流程打包。

每次修改源码后重新执行安装命令并重启 DeepSeek Harness 即可加载更新。插件包名为 `dsh-beeftv`，侧栏入口为 BeefTV。

## 权限与数据

Host 通过本机私有 IPC（macOS/Linux 使用 0600 权限 Unix Domain Socket + 对端 UID 校验；Windows 使用当前用户 SID 独占的 Named Pipe）获取运行时能力，账号与模型密钥留在 BeefTV 原有存储中。浏览器只得到当前连接生命周期内的临时画布访问地址。切换连接会撤销旧 MCP 客户端，后端只会关闭由插件启动的实例。

Agent 通过现有 BeefTV MCP 访问工作区。生成提交、业务目录中标记为写入、生成或无法识别的网关调用，以及会调用付费模型的只读操作（如审片），由 DSH 请求批准；选择完全权限时不弹出审批，直接执行。其余明确标记为只读且不提交生成的调用可直接读取。批准后使用 BeefTV 的 `caller` 模式核对版本与提交任务。画布视图上下文仅包含路由、画布标识与已选节点。

托管运行包与随包运行包均遵循 BeefTV LICENSE 与 NOTICE，第三方资源保留各自许可。
