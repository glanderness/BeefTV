# 本地 TTS 接口字段

## 协议身份

- 插件 ID：`local-tts`。
- Provider ID：`local-tts`。
- 能力：`audio`。
- 默认 Base URL：`http://127.0.0.1:8000`。
- 鉴权驱动：`bearer`。
- 创建：`POST /v1/audio/speech`。
- 生命周期：同步，直接返回音频字节。

## 请求字段

| 字段 | 来源 | 说明 |
| --- | --- | --- |
| `model` | 请求模型 | 模型 ID；本机服务可用模型目录的绝对路径。 |
| `input` | 待合成文本 | 必填。 |
| `voice` | 音色设置 | 仅在填写时下发；克隆型模型不使用预设音色。 |
| `response_format` | 音频格式 | 默认 `mp3`；`wav` 不需要 ffmpeg。 |
| `speed` | 语速 | 默认 `1`。 |
| `instruct` | 声音指令 | 文字描述音色，对应上游的 `instruct`。 |
| `ref_audio` | 参考音频 | 声音克隆的参考音频路径。 |
| `ref_text` | 参考文本 | 参考音频对应的转写，可选。 |

`ref_audio` 与 `ref_text` 只在填写时出现在请求体里；未填写时行为与普通语音合成一致。

## 参考音频要求

- `ref_audio` 必须是**上游服务所在主机上可读的文件路径**。本插件默认指向回环地址，
  因此该路径就是本机路径；它不会被上传到公网。
- 建议使用 16kHz 单声道 wav；其他常见格式（mp3、48kHz wav）也能被上游读取。
- 参考音频时长建议 3–15 秒，过短会降低相似度，过长会拖慢合成。

## 部署要求

BeefTV 默认拒绝本机与私网上游。要在部署环境里让该插件生效，需要精确放行：

```bash
export CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS=127.0.0.1
```

不要使用「允许全部私网」的方式绕过 SSRF 防护。

## 示例

```bash
curl -X POST http://127.0.0.1:8000/v1/audio/speech \
  -H 'Content-Type: application/json' \
  -d '{"model":"/Users/you/models/VoxCPM2","input":"你好","ref_audio":"/Users/you/voice.wav","ref_text":"参考音频说的话","response_format":"wav"}' \
  --output out.wav
```

<!-- BEEFTV_PLUGIN_MANIFEST_START -->
## Manifest 完整接口定义

以下 JSON 与插件包内实际 `manifest.json` 逐字段一致，覆盖插件身份、权限、配置、鉴权、参数、创建与响应映射。`documentation` 字段的值就是当前完整文档；为避免文档在自身内部无限递归，JSON 中仅用等义占位文本表示正文。

```json
{
  "apiVersion": "beeftv.plugin/v2",
  "id": "local-tts",
  "name": "本地 TTS（声音克隆）",
  "version": "1.0.0",
  "author": "BeefTV Contributors",
  "description": "面向本机 TTS 服务的语音合成协议：支持参考音频克隆、参考文本与文字音色设计。",
  "documentation": "<当前插件的完整 documentation，由 README.md 与 docs/interface.md 拼接而成；为避免 JSON 递归，此处不重复展开正文。>",
  "permissions": [
    "generation.run",
    "media.read"
  ],
  "configuration": {
    "fields": [
      {
        "name": "apiKey",
        "type": "secret",
        "label": "API Key",
        "required": true
      }
    ]
  },
  "contributes": {
    "providers": [
      {
        "id": "local-tts",
        "label": "本地 TTS（声音克隆）",
        "capabilities": [
          "audio"
        ],
        "scopes": [
          "user.custom-channel",
          "canvas",
          "creation"
        ],
        "baseUrl": "http://127.0.0.1:8000",
        "requiresPublicMediaUrls": false,
        "auth": {
          "type": "bearer",
          "field": "apiKey"
        },
        "parameters": [
          {
            "name": "model",
            "type": "string",
            "required": true,
            "mapping": "model",
            "description": "音频模型 ID；本机服务可用模型目录的绝对路径。"
          },
          {
            "name": "prompt",
            "type": "string",
            "required": true,
            "mapping": "input",
            "description": "待合成文本。"
          },
          {
            "name": "providerOptions",
            "type": "object",
            "required": false,
            "mapping": "provider-specific fields",
            "description": "插件命名空间内的扩展字段。"
          }
        ],
        "create": {
          "method": "POST",
          "path": "/v1/audio/speech",
          "contentType": "application/json",
          "body": {
            "model": {
              "$ref": "request.model"
            },
            "input": {
              "$ref": "request.prompt"
            },
            "voice": {
              "$omitEmpty": {
                "$coalesce": [
                  {
                    "$ref": "request.extra.audioVoice"
                  },
                  {
                    "$ref": "request.providerOptions.local-tts.voice"
                  }
                ]
              }
            },
            "response_format": {
              "$coalesce": [
                {
                  "$ref": "request.extra.audioFormat"
                },
                {
                  "$ref": "request.providerOptions.local-tts.response_format"
                },
                "mp3"
              ]
            },
            "speed": {
              "$coalesce": [
                {
                  "$ref": "request.extra.audioSpeed"
                },
                {
                  "$ref": "request.providerOptions.local-tts.speed"
                },
                1
              ]
            },
            "instruct": {
              "$omitEmpty": {
                "$coalesce": [
                  {
                    "$ref": "request.extra.audioInstructions"
                  },
                  {
                    "$ref": "request.providerOptions.local-tts.instruct"
                  }
                ]
              }
            },
            "ref_audio": {
              "$omitEmpty": {
                "$coalesce": [
                  {
                    "$ref": "request.extra.audioRefAudio"
                  },
                  {
                    "$ref": "request.providerOptions.local-tts.ref_audio"
                  }
                ]
              }
            },
            "ref_text": {
              "$omitEmpty": {
                "$coalesce": [
                  {
                    "$ref": "request.extra.audioRefText"
                  },
                  {
                    "$ref": "request.providerOptions.local-tts.ref_text"
                  }
                ]
              }
            }
          }
        },
        "response": {
          "binaryPayload": true,
          "resultKind": "audio",
          "status": "succeeded",
          "errorPaths": [
            "error.code"
          ],
          "messagePaths": [
            "error.message"
          ]
        }
      }
    ]
  }
}
```

<!-- BEEFTV_PLUGIN_MANIFEST_END -->
