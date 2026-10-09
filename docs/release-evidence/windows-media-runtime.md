# Windows 视频运行包

`scripts/package-media-runtime-windows.ps1` 固定使用 Gyan FFmpeg 8.0.1 essentials 静态发行包，并校验发行 ZIP 的 SHA256。只复制 `ffmpeg.exe`、上游 LICENSE、README 和来源/文件校验清单，不携带 ffplay、ffprobe 或开发工具。应用不修改用户 PATH，也不在用户首次导入时下载运行包。

应用和 CLI 从自身位置解析 `media-runtime/ffmpeg.exe`，不依赖当前工作目录。预览和剪辑共用此解析入口；`CANVAS_FFMPEG_PATH` 的显式配置优先，配置无效时不得暗中回退。Windows 子进程隐藏控制台。

发行包采用 GPL v3，作为独立进程运行，不改变 BeefTV 源代码的 MIT 声明。分发时须保留上游许可证、构建说明及对应源码获取信息；发布负责人应核对 FFmpeg 和该构建所含外部库的对应源码提供方式。FFmpeg 核心源码提交：`894da5ca7d`，完整构建说明随包保留在 `media-runtime/README.txt`。

验收至少覆盖：校验失败时不生成运行包、带中文和空格的搬移目录、测试进程 PATH 中无 FFmpeg 时 H.265 → H.264、原文件哈希不变、原生可播放素材不请求转码、重用预览、失败重试、串行转换、按用户清理缓存、更新及回滚时整组移动运行包。源码合并不等于正式 Windows 包已经发布。
