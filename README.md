<p align="center">
  <img src="assets/readme/beeftv-wordmark.svg" width="640" alt="BeefTV — High-performance, lightweight, AI-native video workspace">
</p>

<p align="center"><strong>High-performance · Lightweight · AI Native</strong></p>

<p align="center">
  面向 AI 时代的视频创作工作台。<br>
  在一个自由画布中连接创意、模型、素材与 Agent。
</p>

<p align="center">
  <a href="#产品演示">产品演示</a> ·
  <a href="docs/content/docs/overview/features.mdx">功能清单</a> ·
  <a href="QUICKSTART.md">开始使用</a> ·
  <a href="CONTRIBUTING.md">参与贡献</a>
</p>

## 产品演示

<video src="https://github.com/user-attachments/assets/7acc2ad6-5312-4e22-bf1c-96d05c7cd1e3" controls muted></video>

## Why BeefTV

| High Performance | Lightweight | AI Native |
| --- | --- | --- |
| 面向复杂创作画布优化。视口渲染、节点加载、媒体预览与生成任务彼此解耦，让项目增长时仍能保持顺畅操作。 | 以低资源占用和低使用门槛为目标。一个桌面工作区即可开始创作，能力按需加载，不要求部署完整的生产 SaaS。 | AI 不是附加按钮，而是工作流的一部分。Agent 可以理解画布、调用模型、组织素材，并将结果写回可继续编辑的创作流程。 |

## 一个画布，完整创作链路

- **生成**：从提示词或参考素材生成文字、图片、视频与音频。
- **组织**：用节点和连线建立素材关系、创作上下文与生成流程。
- **加工**：继续裁切、标注、局部重绘、拆分、引用和组合结果。
- **迭代**：保留过程、复用素材，让一次生成变成可持续演进的工作流。

BeefTV 同时提供项目库、个人资产库、异步任务、模型渠道、创作工具与 Agent 工作区。完整范围见[功能清单](docs/content/docs/overview/features.mdx)。

## 工作方式

```text
想法 / 参考素材
       ↓
AI Native 自由画布
       ↓
Agent + 模型 + 创作工具
       ↓
文字 / 图片 / 视频 / 音频 / 分镜
       ↓
可编辑、可复用、可继续生成的工作流
```

## Open by design

- 自由配置文本、图片、视频与音频模型渠道，不绑定单一 Provider。
- 项目、画布、素材与任务由统一工作区管理，数据可以本地保存和迁移。
- 桌面端基于 React、Go 与 Wails，模型协议和工作台能力可继续扩展。

## 开始使用

```bash
git clone https://github.com/glanderness/BeefTV.git
cd BeefTV
./scripts/build-beeftv-release.sh
```

详细环境要求、Windows 构建与本地开发方式见 [`QUICKSTART.md`](QUICKSTART.md) 和[桌面发布文档](docs/desktop-release.md)。首次启动后，添加自己的模型渠道即可开始创作。

## 项目状态

BeefTV 正在快速迭代，数据结构和外部接口仍可能变化。建议在个人设备或可信环境中使用，并避免将本地 workspace API 直接暴露到公网。

- [更新记录](CHANGELOG.md)
- [安全策略](SECURITY.md)
- [贡献指南](CONTRIBUTING.md)

## 贡献与许可

欢迎提交 Issue 和 Pull Request。开发流程与测试要求见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

项目按照 [`LICENSE`](LICENSE) 发布；上游来源、保留声明与第三方归属见 [`NOTICE`](NOTICE)。
