<p align="center">
  <img src="assets/readme/beeftv-wordmark.svg" width="640" alt="BeefTV — High-performance, lightweight, AI-native video workspace">
</p>

<p align="center"><strong>High-performance · Lightweight · AI Native</strong></p>

<p align="center">
  面向 AI 时代的视频创作工作台。<br>
  在一个自由画布中连接创意、模型与素材。
</p>

<p align="center">
  与 BeefTV Agent 一起推进创作，用 Skills 扩展方法，用工作流复用过程。<br>
  从分镜、素材到成片，让创作可以继续编辑、迭代和积累。
</p>

<p align="center">
  <a href="https://github.com/glanderness/BeefTV/stargazers"><img src="https://img.shields.io/github/stars/glanderness/BeefTV?style=flat-square&amp;logo=github&amp;label=Stars&amp;labelColor=303030&amp;color=E86C36" alt="BeefTV GitHub Stars"></a>
  <a href="https://github.com/glanderness/BeefTV/releases/latest"><img src="https://img.shields.io/github/v/release/glanderness/BeefTV?style=flat-square&amp;label=Release&amp;labelColor=303030&amp;color=525252" alt="BeefTV 最新版本"></a>
  <a href="QUICKSTART.md#下载与首次打开"><img src="https://img.shields.io/badge/Desktop-macOS%20%7C%20Windows-525252?style=flat-square&amp;labelColor=303030" alt="桌面版支持 macOS 和 Windows"></a>
  <a href="QUICKSTART.md"><img src="https://img.shields.io/badge/Workspace-Local--first-525252?style=flat-square&amp;labelColor=303030" alt="本地优先工作区"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Source%20Available-525252?style=flat-square&amp;labelColor=303030" alt="源码可用，许可范围见 LICENSE"></a>
</p>

<p align="center">
  <a href="https://beeftv.app/"><img src="assets/readme/button-website.svg" width="180" alt="访问 BeefTV 官网"></a>
  <a href="https://github.com/glanderness/BeefTV/releases/latest"><img src="assets/readme/button-download.svg" width="175" alt="下载 BeefTV 桌面版"></a>
</p>

<p align="center">
  <a href="README.en.md">English</a> ·
  <a href="#产品演示">产品演示</a> ·
  <a href="#beeftv-agent">Agent</a> ·
  <a href="#skills">Skills</a> ·
  <a href="#workflows">Workflows</a> ·
  <a href="docs/content/docs/overview/features.mdx">功能清单</a> ·
  <a href="QUICKSTART.md">开始使用</a> ·
  <a href="CONTRIBUTING.md">参与贡献</a>
</p>

## 产品演示

https://github.com/user-attachments/assets/94fe6a39-6933-44b3-a9a9-dbc28b2d284c

[下载演示视频](assets/readme/beeftv-demo.mp4) · 早期画布界面演示；2.0 系列能力见下方介绍与[发布说明](https://github.com/glanderness/BeefTV/releases/latest)。

[查看 2.0.1 实机案例](docs/content/docs/overview/examples.mdx)：从一句创意到可编辑分镜，三个文字技能，以及两组素材的工作流复用。

## BeefTV Agent

**从创作意图，推进到可编辑的交付。**

描述目标，让创作助手准备分镜、整理参考素材与生成方案。确认方案后，继续推进素材生成、结果检查、剪辑与导出，交付成片及可编辑工程。

- **围绕画布创作**：结合当前素材与创作上下文安排下一步。
- **确认后推进**：先查看方案，再开始制作；通过进度了解任务状态。
- **保留编辑空间**：查看结果，继续调整素材和剪辑。

![BeefTV Agent 将确认后的咖啡短片分镜交付为两个可编辑文本节点](assets/readme/beeftv-2.0.1-agent-delivery.webp)

**实机案例：8 秒咖啡短片分镜。** 描述「深夜接过咖啡，抬头迎来清晨」→ 确认双镜头方案 → Agent 将时长、画面与声音写入两个可编辑文本节点。本例完成文字分镜交付，未生成成片。[查看输入与交付](docs/content/docs/overview/examples.mdx#agent从创意到两个可编辑分镜)。

生成需要可用的模型渠道；影音检查还需配置支持的多模态模型。字幕、画面与局部排版仍需人工核对。

[了解创作助手](docs/content/docs/overview/features.mdx#beeftv-agent创作助手)

## Skills

**把创作方法，变成随时可用的技能。**

为创作助手提供特定任务的方法、步骤与要求。浏览技能市场，查看使用条件与文件，再安装指定版本。

![BeefTV 2.0.1 技能市场：浏览技能、用途和固定版本](assets/readme/beeftv-2.0.1-skills.webp)

| 官方技能 | 本次实际交付 |
| --- | --- |
| 双镜头文字分镜 | 咖啡短片：两镜各 4 秒，列出画面、声音与待确认项。 |
| 采访提纲 | 社区书店：三个开放问题、条件追问、补拍与授权清单。 |
| 素材清单整理 | 咖啡视频＋清晨照片：用途分类、授权记录与时长、声音缺口。 |

上图为 2.0.1 安装版实拍。实测使用官方 1.0.0 技能文件的本地私人副本；市场仍标注「效果尚未验证」。[查看三个示例的输入与结果](docs/content/docs/overview/examples.mdx#skills三个文字任务)。

- **按需使用**：启用或停用已安装技能，管理自己的技能库。
- **保留版本**：查看更新，也可回退到已安装的历史版本。
- **按习惯改写**：复制为私人版本；作者可准备投稿，分别确认上传与公开送审。

文字技能无需配置多模态模型；涉及图片、视频或音频的技能，按其使用条件配置相应能力。

[了解技能使用与管理](docs/content/docs/overview/features.mdx#skills创作技能)

## Workflows

**把跑通的步骤，留给下一次创作。**

将画布节点保存为可复用工作流，设置可替换输入、固定内容与输出。下次更换素材，沿用已有配置继续运行。

| 第一次：赛车视频 | 第二次：霓虹街景视频 |
| --- | --- |
| ![同一关键帧提取工作流，赛车视频执行完成并输出车手画面](assets/readme/beeftv-2.0.1-workflow-first.webp) | ![替换为霓虹街景视频后重新运行，执行完成并输出街景画面](assets/readme/beeftv-2.0.1-workflow-second.webp) |

**实机案例：同一模板，两组输入。**「关键帧提取 · 本地处理」保存后，先运行赛车视频，再替换为霓虹街景视频；保持模板版本 1 与截帧参数不变，两次均显示「已完成 1 / 1」并输出对应首帧。此流程在本地处理，无模型调用。[查看复用步骤](docs/content/docs/overview/examples.mdx#workflows同一模板两组素材)。

- **从画布封装**：框选节点，点击「保存为工作流」。
- **编辑模板**：调整节点、连接、模型与处理参数。
- **替换输入运行**：添加到画布，绑定新素材，查看进度与结果。

工作流支持生成与媒体处理步骤，具体能力以编辑器提示为准；模型生成仍按所用渠道计费。

[了解工作流创建与复用](docs/content/docs/overview/features.mdx#将画布节点保存为可复用工作流)

## 一个画布，完整创作链路

- **生成**：从提示词或参考素材生成文字、图片、视频与音频。
- **组织**：用节点和连线建立素材关系、创作上下文与生成流程。
- **加工**：继续裁切、标注、局部重绘、拆分、引用和组合结果。
- **迭代**：保留过程、复用素材，让一次生成变成可持续演进的工作流。

BeefTV 同时提供项目库、个人资产库、异步任务、模型渠道与创作工具。完整范围见[功能清单](docs/content/docs/overview/features.mdx)。

## Why BeefTV

| High Performance | Lightweight | AI Native |
| --- | --- | --- |
| 面向复杂画布优化渲染、媒体预览与任务处理。 | 本地优先，一个桌面工作区即可开始，能力按需加载。 | Agent 推进创作，Skills 提供方法，工作流复用步骤。 |

## Open-Source，Design Your Own BeefTV

- 可以自由配置文本、图片、视频与音频模型渠道，不绑定单一 Provider。
- 项目、画布、素材与任务由统一工作区管理，数据可以本地保存和迁移。
- 桌面端基于 React、Go 与 Wails，模型协议和工作台能力可继续自定义或者扩展。

## 开始使用

1. [下载桌面版](https://github.com/glanderness/BeefTV/releases/latest)，按[首次打开说明](QUICKSTART.md#下载与首次打开)进入本地工作区，无需注册。
2. 在「模型配置」中连接 BeefAPI，或添加自己的模型渠道。
3. 新建画布，添加参考素材，向创作助手描述目标；也可从节点开始自由创作。

模型配置与源码构建见 [快速开始](QUICKSTART.md)，打包要求见[桌面发布文档](docs/desktop-release.md)。

## 社区

交流创作方法、分享技能与工作流，或反馈使用问题。

<p>
  <a href="https://beeftv.app/assets/beeftv-wecom-qr.png"><img src="assets/readme/button-community.svg" width="185" alt="扫码加入 BeefTV 社群"></a>
  <a href="https://x.com/beefnoode"><img src="assets/readme/button-x.svg" width="180" alt="在 X 关注 @beefnoode"></a>
</p>

## 贡献与许可

欢迎提交 Issue 和 Pull Request。开发流程与测试要求见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

仓库采用分范围许可：自首次引入新许可的提交起，符合授权条件的新增原创内容适用 [`BeefTV Source Available License 1.0`](LICENSE)；已按 MIT 发布的历史内容继续适用同文件保留的 MIT 条款，上游和第三方材料保留各自许可。

新许可允许自部署、内部二开及使用 BeefTV 制作并销售作品；对其覆盖的软件进行商业转售、套壳销售、收费部署或定制交付，以及免费或收费向第三方提供托管功能，均需事先书面授权。独立教程、培训和一般技术咨询可收费，不能借此变相交付软件系统。授权联系：[lucas@bf-labs.cn](mailto:lucas@bf-labs.cn)。

新限制不追溯适用于历史 MIT 内容，也不覆盖第三方独立许可的材料。这是一份源码可用许可，不能将整个仓库视为标准 MIT 或 OSI 定义的开源项目。具体场景及覆盖边界见[许可说明](docs/content/docs/overview/licensing.mdx)，上游来源与第三方归属见 [`NOTICE`](NOTICE)。

## ⭐ Star History

<a href="https://www.star-history.com/?repos=glanderness%2FBeefTV&amp;type=date&amp;legend=bottom-right">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=glanderness/BeefTV&amp;type=date&amp;theme=dark&amp;legend=bottom-right" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=glanderness/BeefTV&amp;type=date&amp;legend=bottom-right" />
    <img alt="BeefTV GitHub Star History" src="https://api.star-history.com/chart?repos=glanderness/BeefTV&amp;type=date&amp;legend=bottom-right" />
  </picture>
</a>
