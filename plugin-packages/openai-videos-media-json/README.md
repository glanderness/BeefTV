# Videos JSON · media 数组

适用于服务商明确提供 `POST /v1/videos` JSON 接口，并使用顶层 `media` 数组（`first_frame`、`last_frame`、`reference_image`、`reference_video`、`reference_audio`）、整数 `seconds` 与像素尺寸 `size` 的异步视频协议。

本插件由 BeefTV Contributors 维护。它描述具体线协议格式，不代表与任何服务商存在合作或授权关系；标准 OpenAI Videos / Sora 的 multipart 协议请继续使用 `openai-videos`（`newapi`）。

完整请求、查询及结果格式见 [docs/interface.md](docs/interface.md)。
