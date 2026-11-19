# BeefTV 桌面发布

公开发布还须核对[媒体组件的许可与源码交付](media-source-distribution.md)。流水线会附带许可文件和 macOS FFmpeg/ffprobe 源码包；预构建组件的完整源码材料仍需分发者落实，不能把构建成功视为已完成全部许可义务。

生产桌面包使用仓库根目录的 `VERSION` 作为唯一版本源。发布脚本会把版本号、当前 Git 提交和 UTC 构建时间同时注入前端与 Go 后端，并生成不依赖 Vite 开发服务器的 Wails 应用包。

带自动更新的生产包还要注入更新源地址和 Ed25519 公钥。密钥、草稿发布、签名清单和回滚语义见下方「桌面自动更新」。`v1.5.2` 及以前的安装包不含更新器，不能靠补发清单给已经装好的二进制补上自动更新。

本地合同检查仍由 `scripts/verify-beeftv-local-release.sh` 负责。macOS 发布脚本会先跑该门禁；Windows 发布脚本只做本机打包，不重复整套门禁。

前端未压缩产物的默认体积上限为 105 MiB，可通过 `BEEFTV_WEB_BUDGET_MIB` 调整。包含 FFmpeg、MediaPipe 和预设资源的主线基线约为 99.24 MiB；自动更新增量约 25 KiB。此上限不是 zip 下载大小。

## macOS

```bash
./scripts/build-beeftv-release.sh
```

macOS 构建会从固定源码构建并校验原生 LGPL 媒体运行时（`ffmpeg` 与 `ffprobe`），不要求构建机预装 BeefTV 或第三方媒体库。打包时同步校验两个可执行文件的目标架构、SHA-256 哈希和系统动态库依赖，并将哈希写入 `sources.json` 与对应源码包；公开分发须满足上方媒体组件交付要求。

如果系统没有全局 Go，可通过 `BEEFTV_GO_DIR` 指定本地工具链目录：

```bash
BEEFTV_GO_DIR=/tmp/beeftv-go.rpIfVN/go ./scripts/build-beeftv-release.sh
```

生产自动更新包需要额外环境变量：

| 变量 | 作用 |
| --- | --- |
| `BEEFTV_UPDATER_PUBLIC_KEY` | 注入更新源公钥；缺省则更新器保持关闭 |
| `BEEFTV_UPDATER_FEED_URL` | 可选，默认官方 `desktop-update-v2.json` 地址（`v2.0.6` 及更早版本使用 `desktop-update.json`） |
| `BEEFTV_WAILS_PLATFORM` | 可选，例如 `darwin/arm64` 或 `darwin/amd64` |
| `BEEFTV_SKIP_LOCAL_VERIFY` | 设为 `1` 时跳过本地门禁；发布流水线的校验作业会跑门禁 |
| `BEEFTV_EXTRA_LDFLAGS` | 追加到 Wails `-ldflags` |

产物：

```text
backend/cmd/desktop/build/bin/BeefTV.app
backend/cmd/desktop/build/bin/BeefTV.app/Contents/Resources/plugin-packages/*.beeftv-plugin
backend/cmd/desktop/build/bin/BeefTV.app/Contents/Resources/agent-host/bundled-plugins/{beeftv-plugin-market,beeftv-plugin-ll2,beeftv-plugin-ysdui}
```

验收重点：

- `backend/cmd/desktop/build/bin/BeefTV.app` 存在；
- Wails 将 `frontend/dist` 编译进应用二进制；应用包内应存在 `Contents/MacOS/BeefTV`，并由构建日志确认完成 `Compiling frontend` 与 `Packaging application`；
- macOS `Info.plist` 的 `CFBundleShortVersionString` 和 `CFBundleVersion` 与根目录 `VERSION`（去掉 `v` 前缀）一致；
- `/api/health/live` 与 `/api/system/version` 返回的版本信息来自同一份发布元数据；
- 发布启动不需要 `127.0.0.1:3000` 的 Vite 开发服务器。

## Windows（amd64，必须在 Windows 本机执行）

在仓库根目录执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-beeftv-windows-release.ps1
```

产物：

```text
backend\cmd\desktop\build\bin\BeefTV.exe
backend\cmd\desktop\build\bin\plugin-packages\*.beeftv-plugin
backend\cmd\desktop\build\bin\agent-host\bundled-plugins\{beeftv-plugin-market,beeftv-plugin-ll2,beeftv-plugin-ysdui}
```

官方协议插件归档（`*.beeftv-plugin`）必须和 `BeefTV.exe` 放在同一目录下的 `plugin-packages\`（不能在 `plugin-packages\` 下放子目录，否则已发布客户端的应用内更新校验会拒绝）；随包 pi 插件目录（按 `plugin-packages/bundled-plugin-dirs.txt` 清单）统一放在 `agent-host\bundled-plugins\` 下，随 `agent-host` 整树更新。从开始菜单、快捷方式或资源管理器启动时，工作目录不一定是仓库或 exe 所在目录；应用按可执行文件位置查找官方插件与随包插件目录，不依赖当前工作目录。

### 本机前提

脚本发现缺工具就退出，不会安装全局工具，也不会改用户 PATH。

| 前提 | 用途 | 依据 |
| --- | --- | --- |
| Windows 10/11 amd64 | Wails Windows 目标 | [Wails CLI platforms](https://wails.io/docs/reference/cli) |
| Go 1.25 或更新，且在 PATH（或 `BEEFTV_GO_DIR\bin\go.exe`） | 编译桌面后端；`backend/go.mod` 要求 1.25 | 仓库 `backend/go.mod` |
| Bun 在 PATH | `wails.json` 的 `bun install --frozen-lockfile` 与 `bun run build:desktop` | 仓库 `backend/cmd/desktop/wails.json` |
| `CGO_ENABLED` 不能是 `0` | `gorm.io/driver/sqlite` 依赖 `github.com/mattn/go-sqlite3` | [go-sqlite3 README](https://github.com/mattn/go-sqlite3#windows) |
| PATH 中的 `gcc`/`clang`，或可执行的 `CC` | 编译 go-sqlite3。Go 1.25 起 Windows CGO 需要支持 DWARF 5 的 GCC（binutils 2.37 或更新） | [go-sqlite3 Windows](https://github.com/mattn/go-sqlite3#windows)、[Go Minimum Requirements · cgo](https://go.dev/wiki/MinimumRequirements#cgo) |
| 已有 `plugin-packages/*.beeftv-plugin`，或能现场打包 | 官方协议包是运行时依赖 | 仓库 `plugin-packages/build-packages.sh` |
| Microsoft WebView2 Runtime | 运行 Wails 窗口。Windows 11 通常已安装 | [Wails Windows](https://wails.io/docs/guides/windows)、[Wails installation](https://wails.io/docs/gettingstarted/installation) |

现场打包官方插件时的顺序：

1. 若已有 `plugin-packages/*.beeftv-plugin`，直接使用；
2. 否则若本机有 `bash`、`zip` 和 `node`，调用现有 `plugin-packages/build-packages.sh`；
3. 否则用 Bun 或 Node 运行 `plugin-packages/embed-documentation.mjs`，再用 PowerShell 写出带正斜杠路径的 zip。反斜杠路径会被插件校验拒绝。

构建使用与 macOS 相同的 Wails 模块 `github.com/wailsapp/wails/v2/cmd/wails@v2.16.0`，并显式传入 `-platform windows/amd64`、`-webview2 download`。Wails 把生产二进制写到 `build/bin`。缺少 WebView2 时，下载策略会提示安装官方 bootstrapper。

本脚本不生成 NSIS 安装包。Wails 的 `-nsis` 需要另装 NSIS，且默认安装脚本是否包含 `plugin-packages\` 未经本仓库验证。当前支持的发布形态是：把 `BeefTV.exe` 和旁边的 `plugin-packages\` 一起分发。

### NSIS 安装包

`scripts/package-desktop-installer.py --platform windows-amd64` 调用 `scripts/installers/windows.nsi`，把 `BeefTV.exe`、`plugin-packages\`、`agent-host\`、`cli\`、`media-runtime\` 等载荷打成 `BeefTV-vX.Y.Z-windows-amd64-setup.exe`。

- 安装位置可选。默认 `%LOCALAPPDATA%\Programs\BeefTV`；覆盖安装默认沿用上一次的安装位置（读取注册表 `InstallLocation`），用户仍可另选。静默安装用 `/D=<目录>` 指定。
- 无论选择哪个文件夹，安装包都装入其下名为 `BeefTV` 的子目录：选择 `D:\Apps` 会安装到 `D:\Apps\BeefTV`。
- 安装器以当前用户权限运行（`RequestExecutionLevel user`）。它会拒绝盘符根目录、非空的非 BeefTV 目录（避免覆盖用户数据）以及当前用户无写权限的目录（例如 `Program Files`，需改用其他文件夹），并在目录页给出提示。
- 卸载只删除随包文件、`agent-host`、`plugin-packages`、`cli`、`media-runtime` 和根目录清单内的文件；未知用户文件保留。安装位置的临时暂存和备份目录与被替换目录同卷，替换完成前不删除旧程序。

在非 Windows 主机交叉编译出来的 exe，不能当作 Windows 验收通过。

## 启动目录与数据目录

桌面进程默认数据目录来自 Go 的 `os.UserConfigDir()`，再拼 `BeefTV`：

| 系统 | 默认数据目录 |
| --- | --- |
| Windows | `%AppData%\BeefTV`（Roaming） |
| macOS | `~/Library/Application Support/BeefTV` |

其中包含 SQLite、本地资源和迁移备份。隔离调试时设置 `CANVAS_DESKTOP_DATA_DIR`，或启动桌面程序时传入 `--data-dir=/绝对路径/独立测试目录`；启动参数优先于环境变量，拒绝相对路径和文件系统根目录。`CANVAS_BACKEND_DATA_DIR` 只作用于 `cmd/server`，不会改桌面数据目录。

官方插件源目录是安装包内的只读输入；启动后会复制到数据目录下的 `plugin-packages\`。源目录找不到时，桌面后端无法完成启动。

需要知道的限制：

- 未签名的 `BeefTV.exe` 可能被 SmartScreen 拦截；本脚本不签名。
- 构建机没有 C 编译器时，脚本会失败。常见 MSYS2/MinGW 路径若存在但不在 PATH，脚本会指出路径，不会自动加入 PATH。
- 数据库连接串目前把数据目录与 `/open_ai_canvas.db` 直接拼接。Windows 一般接受正斜杠；数据目录名里如果出现 `?` 或 `#`，可能被当成 DSN 参数。

发布前先停止 Wails/Vite 开发进程，避免开发输出与生产构建并发写入同一目录。

## 桌面自动更新

自动更新只服务于已经装过「带更新器的生产包」的用户。检查、下载、安装都在应用内完成；安装并重启前，正在运行的版本不会被替换。

### 现有安装

`v1.5.2` 及以前的安装包里没有更新器。给仓库补上更新源或签名清单，不会让这些已经装好的版本自己升级。

用户需要先手动下载并安装第一个带更新器的版本。之后就可以在应用里检查更新。项目、素材、设置、BeefTV 账号连接和自定义插件会留在原来的数据目录，不会跟着安装包走。

### 会保留的数据

更新包只替换应用本身：

| 系统 | 被替换 | 不会进更新包、也不会被替换 |
| --- | --- | --- |
| macOS | `BeefTV.app` | `~/Library/Application Support/BeefTV` |
| Windows | `BeefTV.exe` 和旁边的 `plugin-packages\*.beeftv-plugin` | `%AppData%\BeefTV` |

应用包身份和可执行文件路径保持不变，所以前端 IndexedDB 会继续可用。官方插件随应用包更新；用户自己装的插件如果放在数据目录里，会留下来。

程序与数据必须使用独立目录。尤其不要把 Windows zip 解压到 `%AppData%\BeefTV`，也不要将 `CANVAS_DESKTOP_DATA_DIR` 指向 exe 所在目录。更新器会在退出前拒绝这类目录重叠。

更新包禁止带上 `.env`、SQLite 数据库和 `.settings-key`。打包工具遇到用户数据目录会直接拒绝。

### 更新签名和 Apple 签名

这是两件独立的事。

- **更新签名**：Ed25519 签的是 `desktop-update.json` 里的清单。清单写明每个系统包的下载地址、SHA-256 和大小。应用用编译进去的公钥验签，再核对 zip 哈希。不依赖 Apple 证书，也不走业务云接口。
- **Apple 签名 / 公证**：决定下载后的 `.app` 能否通过 Gatekeeper 的默认信任检查。现有 macOS 脚本仍使用 ad hoc `codesign --sign -`，没有 Developer ID 身份或 Apple 公证；首次手动安装可能被拦截。更新器本身不依赖 Apple 证书，但要让用户无需手动放行，需要 Developer ID Application 签名及 Apple 公证。首次安装指引见 [快速开始](../QUICKSTART.md#下载与首次打开)。

发布验收必须分别记录安装包哈希、`codesign --verify --deep --strict` 和 `spctl --assess --type execute --verbose=4` 的结果。前两项通过不代表 Gatekeeper 放行；还需在没有历史放行记录的 Mac 上，通过浏览器下载、解压并从 Finder 首次打开验收。GitHub 与 Cloudflare 提供相同字节的包时，不会改变 Apple 对应用签名的判断。

Windows 目前也不做 Authenticode 签名。SmartScreen 可能拦截首次手动安装。

### 密钥

在本机生成，不要写进仓库，也不要在终端打印私钥：

```bash
cd backend
go run ./cmd/update-release gen-key \
  --private-key /path/to/beeftv-updater.private \
  --public-key /path/to/beeftv-updater.public
```

私钥文件权限是 `0600`，内容是 64 字节 Ed25519 私钥的标准 Base64。公钥是 32 字节公钥的标准 Base64。

GitHub 仓库配置：

| 位置 | 名称 | 内容 |
| --- | --- | --- |
| Actions secret | `BEEFTV_UPDATER_PRIVATE_KEY` | 私钥文件全文 |
| Actions variable | `BEEFTV_UPDATER_PUBLIC_KEY` | 公钥文件全文 |

发布流水线会用私钥推导公钥，必须和变量一致，否则失败，不会发布未签名更新源。

本地要打带更新器的包时，导出公钥即可：

```bash
export BEEFTV_UPDATER_PUBLIC_KEY="$(tr -d '[:space:]' < /path/to/beeftv-updater.public)"
./scripts/build-beeftv-release.sh
```

脚本会把下面两个链接期变量写进二进制：

- `infinite-canvas/backend/internal/desktopupdate.FeedURL` = `https://updates.beefapi.com/beeftv/desktop-update-v2.json`（`v2.1.0+`；`v2.0.6` 及以前为 `desktop-update.json`）
- `infinite-canvas/backend/internal/desktopupdate.PublicKey` = 公钥 Base64

两个都为空时，应用里的更新器保持关闭，但仍显示当前版本。

**丢失私钥**：已经发出去的包只认当时编进去的公钥。新密钥签的清单，旧包验不过。换密钥等于重新发一个需要用户手动安装的引导包。不要轮换生产密钥，除非旧私钥已经泄露或确认丢失。

**泄露私钥**：立刻停用自动更新源（不要再发布用该密钥签的清单），换新密钥，并让用户手动安装新引导包。

### 发布

版本号只来自仓库根目录 `VERSION`，必须是稳定的 `vMAJOR.MINOR.PATCH`。不要用预发布号，也不要按 `main` 的 commit SHA 轮询。

正式文件名固定为：

```text
BeefTV-vX.Y.Z-darwin-arm64.zip
BeefTV-vX.Y.Z-darwin-amd64.zip
BeefTV-vX.Y.Z-windows-amd64.zip
BeefTV-vX.Y.Z-linux-amd64.zip
BeefTV-vX.Y.Z-<platform>-from-vA.B.C.delta.zip
desktop-update.json
desktop-update-v2.json
```

Actions 中的 `desktop-*` 临时安装包保留 7 天，用于发布任务之间传递文件及短期排查。正式 GitHub Release 和 R2 下载文件不受此期限影响。清理历史临时包前，应确认对应发布任务成功，且对应版本的平台安装包和更新清单齐全；未确认发布成功的包和升级验证报告保留。

zip 里的布局：

- macOS：`BeefTV.app/...`，保留可执行权限；内部安全符号链接会被解成普通文件，不会写成 zip 符号链接项。随包插件目录位于 `Contents/Resources/agent-host/bundled-plugins/`。
- Windows：根目录的 `BeefTV.exe`、`plugin-packages/*.beeftv-plugin`（仅扁平文件）与 `agent-host/`（含 `agent-host/bundled-plugins/` 随包插件目录）。
- Linux x64：`BeefTV-linux/` 内包含 `BeefTV`、`cli/beeftv`、`agent-host/`（含 `agent-host/bundled-plugins/` 随包插件目录）和 `plugin-packages/`。在 Ubuntu 24.04 原生构建，使用 GTK3 和 WebKitGTK 4.1；安装依赖和启动方法见 [Linux 安装说明](linux-install.md)。更新和回滚替换整个程序目录，用户数据留在配置目录。

新版本更新清单和安装包使用 Cloudflare R2（国内源镜像同步至 CNB `https://cnb.cool/beeftv-downloads/desktop`）：

```text
https://updates.beefapi.com/beeftv/desktop-update.json
https://updates.beefapi.com/beeftv/desktop-update-v2.json
```

`v2.0.6` 及更早客户端使用 `desktop-update.json`（`schema: 1`，严格解码，只含单 `url`）；`v2.1.0` 起使用 `desktop-update-v2.json`（`schema: 2`，含 `urls: [国内源, R2]` 或 `[R2]`，并可选携带 `deltas[fromVersion]` 增量包）。客户端按系统时区或语言判断：中国大陆优先连接国内源（CNB），其他地区优先 R2；任一源连接失败、超时或持续低速时自动切换另一源并从已下载字节续传，最终以同一份 `sha256` 校验为准。

当 `desktop-update-v2.json` 包含匹配当前运行版本的 `deltas[currentVersion]` 时，`v2.1.0+` 客户端优先下载增量包 `BeefTV-vX.Y.Z-<platform>-from-vA.B.C.delta.zip`：未变化的运行时文件（如 `node`、`ffmpeg`、静态插件）直接从本机安装目录复用并逐文件核验 SHA-256，主程序可执行文件使用内置纯 Go 二进制差分补丁（`BTDELTA1`）还原并核验新版本 SHA-256，把常规升级下载量从 160–280 MB 压缩至数 MB。若本机已安装文件缺失或哈希不符、或增量包下载/校验失败，更新器会自动无缝回退为下载并安装完整平台 `.zip`。

流水线先验证 R2 的条件写能力，再建 draft，四个平台构建任务并行执行（`build-windows` 完成后立即并行启动 Windows 安装器生命周期与已发布版本升级验收，无需等待较慢的 macOS 构建）。各平台打包阶段同步生成平台 `.zip`、原生安装器以及基于上一正式版本的 `.delta.zip`（若上一正式版本缺少对应 `.zip` 则跳过增量包）并保存为 Actions 产物。收齐并全部验收通过后生成签名清单，先将版本包（含完整 `.zip` 与 `.delta.zip`）和版本清单写入 R2 不可变路径并从公开地址完整读回校验。之后发布 GitHub Release，按旧 ETag 条件替换 R2 最新清单（同时激活仅含 R2 地址的 `desktop-update-v2.json`）。随后 `mirror` 作业触发 CNB 将四个安装包、四个完整更新 ZIP 与（若存在）四个增量 `.delta.zip` 同步到 CNB 并完成匿名 Range 续传与完整 SHA-256 校验，并在 GitHub Actions 侧再次对全部更新 ZIP（含 `.delta.zip`）执行匿名 HTTP 206 续传与完整 SHA-256 校验，校验全部通过后才将包含国内源与 R2 双源地址的 `desktop-update-v2.json` 条件激活到 R2；若镜像作业失败，只需重跑 `mirror-desktop.yml`，不重跑整个发版。失败或缺包不会激活 R2 更新源。

Linux 发布任务会从最终 ZIP 解压执行随包 CLI，并在 Xvfb 中启动桌面程序，确认本地后端和可见窗口。当 PR 修改了打包脚本、媒体运行时或桌面更新器路径时，`Desktop installer checks` 工作流会提前执行原生打包、Xvfb 启动与 `.deb` 安装校验，不发布版本，也不调用付费模型。

`v1.5.6` 及以前的更新器内置 GitHub 清单地址，更早期过渡版本曾内置已下线的旧版对象存储清单地址；若旧客户端无法访问历史清单地址，只需手动安装一次带 `updates.beefapi.com` 更新源的新版安装包，后续即可在应用内正常接收更新（用户数据目录保持不变）。

### R2 发布配置

使用 `beeftv-releases` 桶及自定义域名 `updates.beefapi.com`，只存放公开发行文件。Actions 使用 Secret `BEEFTV_R2_ACCESS_KEY_ID`、`BEEFTV_R2_SECRET_ACCESS_KEY` 和 Variable `BEEFTV_R2_ENDPOINT`，region 为 `auto`。更新签名密钥保持不变。版本对象长期缓存且不可变，最新清单禁止缓存；生产下载不使用限流的 `r2.dev` 开发域名。

`scripts/publish-desktop-r2.py` 面向 R2 发布（`check-store`、`stage`、`activate`、`activate-v2`），复用 `update-release verify` 验签，并在每次操作前用随机探测对象验证存储端原生 `If-None-Match` / `If-Match` 条件写，检测到失效立即停发。由于自定义域名的 CDN 缓存命中可能忽略 `If-Match`，`stage` 和 `activate` 均从公开地址完整读取文件并核对大小与 SHA-256，`--verification-receipt "$RUNNER_TEMP/release-public-verification.json"` 仅在同一 GitHub 仓库/run/attempt/job 内校验发布输入绑定，不上传为产物，也不跨作业复用。

如果 GitHub 发布成功而存储激活失败，保留正式版本及所有不可变对象。先核查 R2 存储与公开入口，确认没有并发发布后再用同一版本原始清单重跑 `activate` / `activate-v2`。不要删除正式 tag 或重建不同内容的同版本包。条件写成功但最终回读失败时，新清单可能已经生效，不能把它当作未发布。已经安装新版本的客户端不自动降级。

在 `glanderness/BeefTV` 的 `main` 上手动运行 `.github/workflows/release-desktop.yml`。输入的 `confirm_version` 必须和 `VERSION` 一致。`CHANGELOG.md` 必须有对应的 `## vX.Y.Z` 段落，这段文字会同时成为 GitHub Release 说明和清单里的 `notes`。

工作流会拒绝：

- 在非 `main`、非官方仓库上发布
- 缺少密钥或公私钥不匹配
- 标签或 Release 已经存在（包括 draft）
- 新版本不高于已经发布的稳定版本
- 四个平台包还没齐就签名

Apple 公证不在这条工作流里。macOS 作业沿用现有脚本的 ad hoc 签名。Windows 作业安装 MSYS2 UCRT64 GCC，并核对 binutils ≥ 2.37，以符合 Go 1.25 的 DWARF 5 要求；不要用 Chocolatey mingw 或旧版 TDM-GCC。

同一版本的资源是不可变的。不要覆盖已发布的 tag、zip 或 `desktop-update.json`。

本地打包和签名（用测试密钥，不要用生产私钥做实验）：

```bash
cd backend
go run ./cmd/update-release package \
  --platform darwin-arm64 \
  --input cmd/desktop/build/bin/BeefTV.app \
  --output /tmp/BeefTV-vX.Y.Z-darwin-arm64.zip
go run ./cmd/update-release sign \
  --version vX.Y.Z \
  --commit "$(git rev-parse HEAD)" \
  --changelog ../CHANGELOG.md \
  --private-key /path/to/beeftv-updater.private \
  --expect-public-key "$(tr -d '[:space:]' < /path/to/beeftv-updater.public)" \
  --require-platforms darwin-arm64,darwin-amd64,windows-amd64,linux-amd64 \
  --asset darwin-arm64=/tmp/BeefTV-vX.Y.Z-darwin-arm64.zip \
  --asset darwin-amd64=/tmp/BeefTV-vX.Y.Z-darwin-amd64.zip \
  --asset windows-amd64=/tmp/BeefTV-vX.Y.Z-windows-amd64.zip \
  --asset linux-amd64=/tmp/BeefTV-vX.Y.Z-linux-amd64.zip \
  --output /tmp/desktop-update.json
```

### 回滚

客户端在退出前校验并把更新准备到程序所在磁盘；无写入权限、磁盘空间不足或签名错误时保留当前运行的应用。替换/启动失败会尝试恢复旧程序。程序旁的 `.beeftv-update-*` 目录暂存旧程序和恢复记录；本地后端启动、界面挂载、素材与画布缓存成功加载，且本地工作区与两类资源列表读取成功后，客户端自动清理同一安装位置已成功升级的目录（包括旧版本遗留目录）。失败、回滚、记录不完整或含额外文件的目录继续保留。Windows 升级锁随句柄关闭删除；macOS 保留零字节 `.BeefTV.update.lock`，防止仍使用旧版锁协议的助手并发替换应用，它不存储升级包或旧程序。清理失败不阻塞使用，下次启动重试。已启动的新进程不会自动降级，以免把迁移后的数据库交给旧程序；恢复旧程序时需另行确认数据库兼容或还原匹配的数据备份。

已经发布的版本不能收回。已经更新成功的用户，不会因为删除 GitHub Release 而回到旧包。

发现新版本有问题：

1. 不要改写或删除该版本的 zip 和 `desktop-update.json`，可能还有人正在下载。
2. 在 `CHANGELOG.md` 写清问题，把 `VERSION` 升到更高的稳定号。
3. 从修复后的 `main` 再跑一次发布工作流。
4. 已安装更新器的用户检查更新后会拿到更高版本。

如果某个 draft 失败且从未公开：确认没有用户能下到它之后，可以删除该 draft 和对应 tag，再对同一 `VERSION` 重试。已经公开的 tag 不要复用。

`/releases/latest` 指向最近一次发布的正式版，按发布时间而不是按最大版本号。只按时间顺序发布递增的稳定版本。
# 发布前校验

正式桌面发布只能在官方仓库 `main` 分支通过 `workflow_dispatch` 手动触发，发布工作流在构建与开放更新源前强制核验：`confirm_version` 与 `VERSION` 完全一致且高于已发布稳定版、`CHANGELOG.md` 存在对应版本段落、Ed25519 签名密钥对与存储桶凭证齐全、`./scripts/verify-beeftv-local-release.sh` 本地发布契约通过，以及四端产物的安装与启动冒烟全部通过。
