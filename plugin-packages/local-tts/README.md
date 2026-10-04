# 本地 TTS（声音克隆）

该目录是 BeefTV 声明式协议插件源码。后端从生成的 `local-tts.beeftv-plugin` 包加载，不依赖系统内置 `host:` 适配器。

本插件面向在**本机**运行的语音合成服务（例如 MLX-Audio 提供的 OpenAI 兼容接口），在通用语音协议之外额外支持参考音频克隆与文字音色描述。

完整接口见 [docs/interface.md](docs/interface.md)。
