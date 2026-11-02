# aihubkit Changelog

All notable public changes to the aihubkit distribution of BeefTV are documented in this file.

## Unreleased

## v1.0.4

- 延续 v1.0.3 的 aihubkit 账号体系、平台模型和通用临时文件存储能力。
- 将 aihubkit 与官方 BeefTV 的版本文件及发布流程完全分离，方便持续同步官方更新。
- 完善 Windows、Linux、macOS Intel 与 Apple Silicon 的全平台自动构建和发布流程。

## v1.0.3

- 接入 aihubkit 账号体系：桌面端启动后先登录，支持注册、账号隔离、额度与消费记录，并可从账号分组导入平台模型。
- 接入 aihubkit 通用临时文件存储：图片、视频、音频等参考素材在生成前自动上传并转换为公网 URL，无需用户额外配置 S3 存储桶。
- 平台能力集中在可插拔适配层，同时保留官方本地模式、Provider、Protocol 和自定义渠道，便于持续合并 BeefTV 上游的新画布、模型与任务能力。
- 修复开发模式下的登录跨域、后端启动等待和账号入口展示，完善托管凭据与参考素材上传的专项测试。

## v1.0.1

- 发布 aihubkit 独立版本线的首个桌面版本，发布版本为 `v1.0.1`，与上游 BeefTV 的版本号独立演进。
- 本版基于上游 BeefTV `v2.1.1`，提供 Windows x64、Ubuntu 24.04 x64、macOS Apple Silicon 和 Intel 安装包及便携包。
