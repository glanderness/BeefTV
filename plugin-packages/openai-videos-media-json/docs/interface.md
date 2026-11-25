# Videos JSON · media 数组 接口字段

## 协议身份

- 插件 ID：`openai-videos-media-json`。
- Provider ID：`openai-videos-media-json`。
- 能力：`video`。
- 鉴权驱动：`bearer`。
- 创建：`POST /v1/videos`（`application/json`）。
- 查询：`GET /v1/videos/{{taskId}}`。
- 结果下载：`GET /v1/videos/{{taskId}}/content`（`Accept: video/mp4`，当轮询响应未返回 `video_url` 时自动回退）。

## 配置字段

| 字段 | 类型 | 必填 | 含义 |
| --- | --- | --- | --- |
| `apiKey` | secret | 是 | API Key |

## 统一字段映射

| 统一字段 | 类型 | 必填 | 上游映射 | 说明 |
| --- | --- | --- | --- | --- |
| `model` | string | 是 | `model` | 视频模型 ID（如 `minimax/h3`、`minimax/h3-fast`、`wan/wan3.0-video`）。 |
| `prompt` | string | 是 | `prompt` | 视频提示词。 |
| `images` | media[] | 否 | `media[type=first_frame|last_frame|reference_image]` | 支持公网 URL 与 `data:<mime>;base64,...` 内联数据；首尾帧不可与参考素材混用。 |
| `videos` | media[] | 否 | `media[type=reference_video]` | 参考视频地址或内联数据。 |
| `audios` | media[] | 否 | `media[type=reference_audio]` | 参考音频地址或内联数据。 |
| `duration` | integer | 否 | `seconds` | 整数时长秒数；未指定时省略。 |
| `aspectRatio` | string | 否 | `size` | 像素画布尺寸：`21:9`→`1536x672`、`16:9`→`1344x768`、`4:3`→`1024x768`、`1:1`→`768x768`、`3:4`→`768x1024`、`9:16`→`768x1344`；显式传入 `WIDTHxHEIGHT` 时原样透传。 |
| `providerOptions` | object | 否 | `size`、`seed`、`prompt_extend`、`watermark`、`audio`、`body`/`extra_body` | 仅在用户显式配置时才发送可选扩展字段，避免被严格校验的模型（如 `minimax/h3`）以 HTTP 400 拒绝。 |

## 响应与错误

创建响应读取 `id` / `task_id` 与 `status`（`queued` / `in_progress` / `completed` / `failed`）。轮询完成后优先读取直链 `video_url`（标记为 ephemeral，由宿主立即下载持久化且不向外部存储域名发送 API Key）；若 `video_url` 为 `null` 或缺失，宿主自动回退调用 `GET /v1/videos/{{taskId}}/content` 下载成片。HTTP 错误、`error.code` 及 `failed` 状态均保持失败语义，不包装成成功。

## 兼容边界

- 本协议独立于标准 OpenAI Videos multipart 协议（`openai-videos`），不改动现有 Sora / OpenAI Videos multipart 契约。
- 默认不下发 `watermark`、`audio`、`prompt_extend`、`seed`，需要时通过 `providerOptions.openai-videos-media-json` 显式传入。
- 公开采用该 `/v1/videos` JSON + 顶层 `media` 数组格式的网关（例如 GoodPut AI 视频生成接口）可直接选用此协议，服务地址与密钥由用户自行填写。

<!-- BEEFTV_PLUGIN_MANIFEST_START -->
## Manifest 完整接口定义

以下 JSON 与插件包内实际 `manifest.json` 逐字段一致，覆盖插件身份、权限、配置、鉴权、参数、校验、创建、Agent、查询、取消、结果下载、响应和 Agent 响应映射。`documentation` 字段的值就是当前完整文档；为避免文档在自身内部无限递归，JSON 中仅用等义占位文本表示正文。

```json
{
  "apiVersion": "beeftv.plugin/v3",
  "id": "openai-videos-media-json",
  "name": "Videos JSON · media 数组",
  "version": "1.0.0",
  "author": "BeefTV Contributors",
  "description": "使用顶层 media 数组（first_frame/last_frame/reference_*）、seconds 与像素 size 的 /v1/videos JSON 异步视频协议。",
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
        "id": "openai-videos-media-json",
        "label": "Videos JSON · media 数组",
        "capabilities": [
          "video"
        ],
        "scopes": [
          "admin.system-channel",
          "user.custom-channel",
          "canvas",
          "creation",
          "agent"
        ],
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
            "description": "视频模型 ID（如 minimax/h3、minimax/h3-fast、wan/wan3.0-video）。"
          },
          {
            "name": "prompt",
            "type": "string",
            "required": true,
            "mapping": "prompt",
            "description": "视频提示词。"
          },
          {
            "name": "images",
            "type": "media[]",
            "required": false,
            "mapping": "media[type=first_frame|last_frame|reference_image]",
            "description": "首尾帧或参考图片（支持公网 URL 与 data URL）。"
          },
          {
            "name": "videos",
            "type": "media[]",
            "required": false,
            "mapping": "media[type=reference_video]",
            "description": "参考视频。"
          },
          {
            "name": "audios",
            "type": "media[]",
            "required": false,
            "mapping": "media[type=reference_audio]",
            "description": "参考音频。"
          },
          {
            "name": "duration",
            "type": "integer",
            "required": false,
            "mapping": "seconds",
            "description": "整数时长秒数。"
          },
          {
            "name": "aspectRatio",
            "type": "string",
            "required": false,
            "mapping": "size",
            "description": "画幅比例（换算为 768P 像素画布如 1344x768）或显式 WIDTHxHEIGHT。"
          },
          {
            "name": "providerOptions",
            "type": "object",
            "required": false,
            "mapping": "size / seed / prompt_extend / watermark / audio / body",
            "description": "仅在显式配置时下发的可选扩展参数。"
          }
        ],
        "variables": [
          {
            "name": "ratioNorm",
            "value": {
              "$lower": {
                "$trim": {
                  "$ref": "request.aspectRatio"
                }
              }
            }
          },
          {
            "name": "isWxH",
            "value": {
              "$eq": [
                {
                  "$len": {
                    "$split": [
                      {
                        "$ref": "vars.ratioNorm"
                      },
                      "x"
                    ]
                  }
                },
                2
              ]
            }
          },
          {
            "name": "resolvedSize",
            "value": {
              "$coalesce": [
                {
                  "$ref": "request.providerOptions.openai-videos-media-json.size"
                },
                {
                  "$if": {
                    "condition": {
                      "$ref": "vars.isWxH"
                    },
                    "then": {
                      "$trim": {
                        "$ref": "request.aspectRatio"
                      }
                    },
                    "else": {
                      "$switch": {
                        "cases": [
                          {
                            "when": {
                              "$eq": [
                                {
                                  "$ref": "vars.ratioNorm"
                                },
                                "21:9"
                              ]
                            },
                            "then": "1536x672"
                          },
                          {
                            "when": {
                              "$in": [
                                {
                                  "$ref": "vars.ratioNorm"
                                },
                                [
                                  "16:9",
                                  "landscape"
                                ]
                              ]
                            },
                            "then": "1344x768"
                          },
                          {
                            "when": {
                              "$eq": [
                                {
                                  "$ref": "vars.ratioNorm"
                                },
                                "4:3"
                              ]
                            },
                            "then": "1024x768"
                          },
                          {
                            "when": {
                              "$in": [
                                {
                                  "$ref": "vars.ratioNorm"
                                },
                                [
                                  "1:1",
                                  "square"
                                ]
                              ]
                            },
                            "then": "768x768"
                          },
                          {
                            "when": {
                              "$eq": [
                                {
                                  "$ref": "vars.ratioNorm"
                                },
                                "3:4"
                              ]
                            },
                            "then": "768x1024"
                          },
                          {
                            "when": {
                              "$in": [
                                {
                                  "$ref": "vars.ratioNorm"
                                },
                                [
                                  "9:16",
                                  "portrait"
                                ]
                              ]
                            },
                            "then": "768x1344"
                          }
                        ],
                        "default": null
                      }
                    }
                  }
                }
              ]
            }
          }
        ],
        "validations": [
          {
            "assert": {
              "$lte": [
                {
                  "$len": {
                    "$filter": {
                      "from": {
                        "$ref": "request.images"
                      },
                      "as": "media",
                      "where": {
                        "$eq": [
                          {
                            "$ref": "media.role"
                          },
                          "first_frame"
                        ]
                      }
                    }
                  }
                },
                1
              ]
            },
            "message": "最多只能提供 1 张首帧图片"
          },
          {
            "assert": {
              "$lte": [
                {
                  "$len": {
                    "$filter": {
                      "from": {
                        "$ref": "request.images"
                      },
                      "as": "media",
                      "where": {
                        "$eq": [
                          {
                            "$ref": "media.role"
                          },
                          "last_frame"
                        ]
                      }
                    }
                  }
                },
                1
              ]
            },
            "message": "最多只能提供 1 张尾帧图片"
          },
          {
            "assert": {
              "$or": [
                {
                  "$eq": [
                    {
                      "$len": {
                        "$filter": {
                          "from": {
                            "$ref": "request.images"
                          },
                          "as": "media",
                          "where": {
                            "$eq": [
                              {
                                "$ref": "media.role"
                              },
                              "last_frame"
                            ]
                          }
                        }
                      }
                    },
                    0
                  ]
                },
                {
                  "$eq": [
                    {
                      "$len": {
                        "$filter": {
                          "from": {
                            "$ref": "request.images"
                          },
                          "as": "media",
                          "where": {
                            "$eq": [
                              {
                                "$ref": "media.role"
                              },
                              "first_frame"
                            ]
                          }
                        }
                      }
                    },
                    1
                  ]
                }
              ]
            },
            "message": "使用尾帧时必须同时提供首帧图片"
          },
          {
            "assert": {
              "$or": [
                {
                  "$eq": [
                    {
                      "$len": {
                        "$filter": {
                          "from": {
                            "$ref": "request.images"
                          },
                          "as": "media",
                          "where": {
                            "$in": [
                              {
                                "$ref": "media.role"
                              },
                              [
                                "first_frame",
                                "last_frame"
                              ]
                            ]
                          }
                        }
                      }
                    },
                    0
                  ]
                },
                {
                  "$and": [
                    {
                      "$eq": [
                        {
                          "$len": {
                            "$filter": {
                              "from": {
                                "$ref": "request.images"
                              },
                              "as": "media",
                              "where": {
                                "$not": {
                                  "$in": [
                                    {
                                      "$ref": "media.role"
                                    },
                                    [
                                      "first_frame",
                                      "last_frame"
                                    ]
                                  ]
                                }
                              }
                            }
                          }
                        },
                        0
                      ]
                    },
                    {
                      "$eq": [
                        {
                          "$len": {
                            "$ref": "request.videos"
                          }
                        },
                        0
                      ]
                    },
                    {
                      "$eq": [
                        {
                          "$len": {
                            "$ref": "request.audios"
                          }
                        },
                        0
                      ]
                    }
                  ]
                }
              ]
            },
            "message": "首尾帧模式不能同时混用参考图、参考视频或参考音频"
          }
        ],
        "create": {
          "method": "POST",
          "path": "/v1/videos",
          "contentType": "application/json",
          "body": {
            "$merge": [
              {
                "model": {
                  "$ref": "request.model"
                },
                "prompt": {
                  "$ref": "request.prompt"
                },
                "seconds": {
                  "$if": {
                    "condition": {
                      "$gt": [
                        {
                          "$ref": "request.duration"
                        },
                        0
                      ]
                    },
                    "then": {
                      "$ref": "request.duration"
                    },
                    "else": null
                  }
                },
                "size": {
                  "$omitEmpty": {
                    "$ref": "vars.resolvedSize"
                  }
                },
                "media": {
                  "$omitEmpty": {
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
                            "type": {
                              "$switch": {
                                "cases": [
                                  {
                                    "when": {
                                      "$eq": [
                                        {
                                          "$ref": "media.role"
                                        },
                                        "first_frame"
                                      ]
                                    },
                                    "then": "first_frame"
                                  },
                                  {
                                    "when": {
                                      "$eq": [
                                        {
                                          "$ref": "media.role"
                                        },
                                        "last_frame"
                                      ]
                                    },
                                    "then": "last_frame"
                                  },
                                  {
                                    "when": {
                                      "$and": [
                                        {
                                          "$eq": [
                                            {
                                              "$ref": "request.operation"
                                            },
                                            "image_to_video"
                                          ]
                                        },
                                        {
                                          "$eq": [
                                            {
                                              "$ref": "media.role"
                                            },
                                            ""
                                          ]
                                        },
                                        {
                                          "$eq": [
                                            {
                                              "$len": {
                                                "$ref": "request.images"
                                              }
                                            },
                                            1
                                          ]
                                        },
                                        {
                                          "$eq": [
                                            {
                                              "$len": {
                                                "$ref": "request.videos"
                                              }
                                            },
                                            0
                                          ]
                                        },
                                        {
                                          "$eq": [
                                            {
                                              "$len": {
                                                "$ref": "request.audios"
                                              }
                                            },
                                            0
                                          ]
                                        }
                                      ]
                                    },
                                    "then": "first_frame"
                                  }
                                ],
                                "default": "reference_image"
                              }
                            },
                            "url": {
                              "$ref": "media.value"
                            }
                          }
                        }
                      },
                      {
                        "$map": {
                          "from": {
                            "$sortByOrder": {
                              "$ref": "request.videos"
                            }
                          },
                          "as": "media",
                          "in": {
                            "type": "reference_video",
                            "url": {
                              "$ref": "media.value"
                            }
                          }
                        }
                      },
                      {
                        "$map": {
                          "from": {
                            "$sortByOrder": {
                              "$ref": "request.audios"
                            }
                          },
                          "as": "media",
                          "in": {
                            "type": "reference_audio",
                            "url": {
                              "$ref": "media.value"
                            }
                          }
                        }
                      }
                    ]
                  }
                },
                "seed": {
                  "$omitEmpty": {
                    "$ref": "request.providerOptions.openai-videos-media-json.seed"
                  }
                },
                "prompt_extend": {
                  "$omitEmpty": {
                    "$ref": "request.providerOptions.openai-videos-media-json.prompt_extend"
                  }
                },
                "watermark": {
                  "$omitEmpty": {
                    "$ref": "request.providerOptions.openai-videos-media-json.watermark"
                  }
                },
                "audio": {
                  "$omitEmpty": {
                    "$ref": "request.providerOptions.openai-videos-media-json.audio"
                  }
                }
              },
              {
                "$coalesce": [
                  {
                    "$ref": "request.providerOptions.openai-videos-media-json.body"
                  },
                  {
                    "$ref": "request.providerOptions.openai-videos-media-json.extra_body"
                  },
                  {}
                ]
              }
            ]
          }
        },
        "poll": {
          "method": "GET",
          "path": "/v1/videos/{{taskId}}"
        },
        "result": {
          "method": "GET",
          "path": "/v1/videos/{{taskId}}/content",
          "headers": {
            "Accept": "video/mp4"
          }
        },
        "response": {
          "taskId": {
            "$coalesce": [
              {
                "$ref": "response.id"
              },
              {
                "$ref": "response.task_id"
              },
              {
                "$ref": "response.data.id"
              },
              {
                "$ref": "taskId"
              }
            ]
          },
          "status": {
            "$coalesce": [
              {
                "$ref": "response.status"
              },
              {
                "$ref": "response.data.status"
              },
              "pending"
            ]
          },
          "message": {
            "$coalesce": [
              {
                "$ref": "response.error.message"
              },
              {
                "$ref": "response.message"
              },
              {
                "$ref": "response.fail_reason"
              }
            ]
          },
          "videos": {
            "$coalesce": [
              {
                "$ref": "response.video_url"
              },
              {
                "$ref": "response.url"
              },
              {
                "$ref": "response.data.video_url"
              },
              {
                "$ref": "response.data.url"
              }
            ]
          },
          "usage": {
            "$ref": "response.usage"
          },
          "errorPaths": [
            "error.code"
          ],
          "messagePaths": [
            "error.message",
            "message"
          ],
          "resultEphemeral": true
        }
      }
    ]
  },
  "documentation": "<当前插件的完整 documentation，由 README.md 与 docs/interface.md 拼接而成；为避免 JSON 递归，此处不重复展开正文。>"
}
```
<!-- BEEFTV_PLUGIN_MANIFEST_END -->
