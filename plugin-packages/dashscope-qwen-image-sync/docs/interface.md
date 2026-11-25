# DashScope Qwen Image (同步) 接口字段

## 协议身份

- 插件 ID：`dashscope-qwen-image-sync`。
- Provider ID：`dashscope-qwen-image-sync`。
- 能力：`image`。
- 默认 Base URL：`https://dashscope.aliyuncs.com`。
- 鉴权驱动：`bearer`。
- 创建：`POST /api/v1/services/aigc/multimodal-generation/generation`（`originPath: true`，不发送 `X-DashScope-Async` 请求头）。
- 生命周期：同步响应。

## 配置字段

| 字段 | 类型 | 必填 | 含义 |
| --- | --- | --- | --- |
| `apiKey` | secret | 是 | API Key |

## 统一字段映射

| 统一字段 | 类型 | 必填 | 上游映射 | 说明 |
| --- | --- | --- | --- | --- |
| `model` | string | 是 | `model` | 图片模型 ID（如 `qwen-image-2.1-pro`、`qwen-image-2.1-turbo`、`qwen-image-3.0-pro`、`qwen-image-2.0-pro`）。 |
| `prompt` | string | 是 | `input.messages[0].content[].text` | 图片提示词。 |
| `images` | media[] | 否 | `input.messages[0].content[].image` | 参考图或编辑源图，优先发送 Base64 Data URL。 |
| `imageCount` | integer | 否 | `parameters.n` | 输出数量（1–6）。 |
| `aspectRatio` | string | 否 | `parameters.size` | 比例或尺寸，转换为 DashScope `宽*高` 格式。 |
| `resolution` | string | 否 | `parameters.size` | 分辨率档位。 |
| `quality` | string | 否 | `parameters` | 质量档位。 |
| `providerOptions` | object | 否 | `parameters.*` | 插件命名空间内的厂商扩展字段（`prompt_extend`、`prompt_extend_mode`、`enable_thinking`、`negative_prompt`、`seed`、`response_format`）。 |

## 响应与错误

同步响应从 `output.choices[].message.content[].image` 读取生成图片（兼容 URL 与 `data:` 内联 Data URL），并兼容 `output.results`、`output.image_url`、`data` 与 `usage`。HTTP 错误与业务 `code`/`output.code` 保持失败语义，不包装成成功；临时图片 URL 标记为 ephemeral，由宿主立即下载持久化。

## 兼容边界

对应阿里云百炼官方文档推荐的同步多模态图像端点 `/api/v1/services/aigc/multimodal-generation/generation`，直接返回结果而无需异步任务轮询，适用于 `qwen-image-2.1-pro` / `qwen-image-2.1-turbo` / `qwen-image-3.0-pro` / `qwen-image-3.0` 以及仅支持同步调用的 `qwen-image-2.0-pro` / `qwen-image-2.0`。

<!-- BEEFTV_PLUGIN_MANIFEST_START -->
## Manifest 完整接口定义

以下 JSON 与插件包内实际 `manifest.json` 逐字段一致，覆盖插件身份、权限、配置、鉴权、参数、校验、创建、Agent、查询、取消、结果下载、响应和 Agent 响应映射。`documentation` 字段的值就是当前完整文档；为避免文档在自身内部无限递归，JSON 中仅用等义占位文本表示正文。

```json
{
  "apiVersion": "beeftv.plugin/v2",
  "id": "dashscope-qwen-image-sync",
  "name": "DashScope Qwen Image (同步)",
  "version": "1.0.0",
  "author": "BeefTV Contributors",
  "description": "DashScope 多模态同步图像生成与编辑协议插件（POST /api/v1/services/aigc/multimodal-generation/generation）。",
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
        "id": "dashscope-qwen-image-sync",
        "label": "DashScope Qwen Image (同步)",
        "capabilities": [
          "image"
        ],
        "scopes": [
          "admin.system-channel",
          "user.custom-channel",
          "canvas",
          "creation",
          "agent"
        ],
        "baseUrl": "https://dashscope.aliyuncs.com",
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
            "description": "图片模型 ID（如 qwen-image-2.1-pro、qwen-image-3.0-pro、qwen-image-2.0-pro）。"
          },
          {
            "name": "prompt",
            "type": "string",
            "required": true,
            "mapping": "input.messages[0].content[].text",
            "description": "图片提示词。"
          },
          {
            "name": "images",
            "type": "media[]",
            "required": false,
            "mapping": "input.messages[0].content[].image",
            "description": "参考图或编辑源图，优先发送 Base64 Data URL。"
          },
          {
            "name": "imageCount",
            "type": "integer",
            "required": false,
            "mapping": "parameters.n",
            "description": "输出数量（1–6）。"
          },
          {
            "name": "aspectRatio",
            "type": "string",
            "required": false,
            "mapping": "parameters.size",
            "description": "比例或尺寸，转换为 DashScope 宽*高 格式。"
          },
          {
            "name": "resolution",
            "type": "string",
            "required": false,
            "mapping": "parameters.size",
            "description": "分辨率档位。"
          },
          {
            "name": "quality",
            "type": "string",
            "required": false,
            "mapping": "parameters",
            "description": "质量档位。"
          },
          {
            "name": "providerOptions",
            "type": "object",
            "required": false,
            "mapping": "parameters.*",
            "description": "插件命名空间内的厂商扩展字段。"
          }
        ],
        "create": {
          "method": "POST",
          "path": "/api/v1/services/aigc/multimodal-generation/generation",
          "contentType": "application/json",
          "originPath": true,
          "body": {
            "model": {
              "$ref": "request.model"
            },
            "input": {
              "messages": [
                {
                  "role": "user",
                  "content": {
                    "$concatArrays": [
                      {
                        "$map": {
                          "from": {
                            "$sortByOrder": {
                              "$ref": "request.images"
                            }
                          },
                          "as": "media",
                          "in": {
                            "image": {
                              "$coalesce": [
                                {
                                  "$ref": "media.dataUrl"
                                },
                                {
                                  "$ref": "media.url"
                                }
                              ]
                            }
                          }
                        }
                      },
                      [
                        {
                          "text": {
                            "$ref": "request.prompt"
                          }
                        }
                      ]
                    ]
                  }
                }
              ]
            },
            "parameters": {
              "size": {
                "$omitEmpty": {
                  "$switch": {
                    "cases": [
                      {
                        "when": {
                          "$eq": [
                            {
                              "$ref": "request.aspectRatio"
                            },
                            "1:1"
                          ]
                        },
                        "then": "1024*1024"
                      },
                      {
                        "when": {
                          "$eq": [
                            {
                              "$ref": "request.aspectRatio"
                            },
                            "3:4"
                          ]
                        },
                        "then": "960*1280"
                      },
                      {
                        "when": {
                          "$eq": [
                            {
                              "$ref": "request.aspectRatio"
                            },
                            "4:3"
                          ]
                        },
                        "then": "1280*960"
                      },
                      {
                        "when": {
                          "$eq": [
                            {
                              "$ref": "request.aspectRatio"
                            },
                            "2:3"
                          ]
                        },
                        "then": "1024*1536"
                      },
                      {
                        "when": {
                          "$eq": [
                            {
                              "$ref": "request.aspectRatio"
                            },
                            "3:2"
                          ]
                        },
                        "then": "1536*1024"
                      },
                      {
                        "when": {
                          "$eq": [
                            {
                              "$ref": "request.aspectRatio"
                            },
                            "9:16"
                          ]
                        },
                        "then": "864*1536"
                      },
                      {
                        "when": {
                          "$eq": [
                            {
                              "$ref": "request.aspectRatio"
                            },
                            "16:9"
                          ]
                        },
                        "then": "1536*864"
                      },
                      {
                        "when": {
                          "$eq": [
                            {
                              "$ref": "request.aspectRatio"
                            },
                            "1024x1024"
                          ]
                        },
                        "then": "1024*1024"
                      },
                      {
                        "when": {
                          "$eq": [
                            {
                              "$ref": "request.aspectRatio"
                            },
                            "2048x2048"
                          ]
                        },
                        "then": "2048*2048"
                      },
                      {
                        "when": {
                          "$eq": [
                            {
                              "$ref": "request.aspectRatio"
                            },
                            "1024x1536"
                          ]
                        },
                        "then": "1024*1536"
                      },
                      {
                        "when": {
                          "$eq": [
                            {
                              "$ref": "request.aspectRatio"
                            },
                            "1536x1024"
                          ]
                        },
                        "then": "1536*1024"
                      },
                      {
                        "when": {
                          "$eq": [
                            {
                              "$ref": "request.aspectRatio"
                            },
                            "1024x1280"
                          ]
                        },
                        "then": "1024*1280"
                      },
                      {
                        "when": {
                          "$eq": [
                            {
                              "$ref": "request.aspectRatio"
                            },
                            "1280x1024"
                          ]
                        },
                        "then": "1280*1024"
                      },
                      {
                        "when": {
                          "$eq": [
                            {
                              "$ref": "request.aspectRatio"
                            },
                            "960x1280"
                          ]
                        },
                        "then": "960*1280"
                      },
                      {
                        "when": {
                          "$eq": [
                            {
                              "$ref": "request.aspectRatio"
                            },
                            "1280x960"
                          ]
                        },
                        "then": "1280*960"
                      }
                    ],
                    "default": null
                  }
                }
              },
              "n": {
                "$if": {
                  "condition": {
                    "$gt": [
                      {
                        "$toInt": {
                          "$ref": "request.imageCount"
                        }
                      },
                      0
                    ]
                  },
                  "then": {
                    "$toInt": {
                      "$ref": "request.imageCount"
                    }
                  },
                  "else": 1
                }
              },
              "prompt_extend": {
                "$coalesce": [
                  {
                    "$ref": "request.providerOptions.dashscope-qwen-image-sync.prompt_extend"
                  },
                  true
                ]
              },
              "prompt_extend_mode": {
                "$omitEmpty": {
                  "$ref": "request.providerOptions.dashscope-qwen-image-sync.prompt_extend_mode"
                }
              },
              "enable_thinking": {
                "$coalesce": [
                  {
                    "$ref": "request.providerOptions.dashscope-qwen-image-sync.enable_thinking"
                  },
                  false
                ]
              },
              "response_format": {
                "$omitEmpty": {
                  "$ref": "request.providerOptions.dashscope-qwen-image-sync.response_format"
                }
              },
              "negative_prompt": {
                "$omitEmpty": {
                  "$ref": "request.providerOptions.dashscope-qwen-image-sync.negative_prompt"
                }
              },
              "seed": {
                "$omitEmpty": {
                  "$ref": "request.providerOptions.dashscope-qwen-image-sync.seed"
                }
              },
              "watermark": {
                "$omitEmpty": {
                  "$ref": "request.watermark"
                }
              }
            }
          }
        },
        "response": {
          "status": "succeeded",
          "message": {
            "$coalesce": [
              {
                "$ref": "response.output.message"
              },
              {
                "$ref": "response.message"
              }
            ]
          },
          "images": {
            "$coalesce": [
              {
                "$flatMap": {
                  "from": {
                    "$ref": "response.output.choices"
                  },
                  "as": "choice",
                  "in": {
                    "$map": {
                      "from": {
                        "$ref": "choice.message.content"
                      },
                      "as": "item",
                      "in": {
                        "$omitEmpty": {
                          "$ref": "item.image"
                        }
                      }
                    }
                  }
                }
              },
              {
                "$ref": "response.output.results"
              },
              {
                "$ref": "response.output.image_url"
              },
              {
                "$ref": "response.data"
              }
            ]
          },
          "usage": {
            "$ref": "response.usage"
          },
          "errorPaths": [
            "code",
            "output.code"
          ],
          "resultEphemeral": true,
          "messagePaths": [
            "message",
            "output.message"
          ]
        }
      }
    ]
  },
  "documentation": "<当前插件的完整 documentation，由 README.md 与 docs/interface.md 拼接而成；为避免 JSON 递归，此处不重复展开正文。>"
}
```
<!-- BEEFTV_PLUGIN_MANIFEST_END -->
