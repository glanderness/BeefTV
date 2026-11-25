# DashScope Wan Video 接口字段

## 协议身份

- 插件 ID：`dashscope-wan-video`。
- Provider ID：`dashscope-wan-video`。
- 能力：`video`。
- 默认 Base URL：`https://dashscope.aliyuncs.com`。
- 鉴权驱动：`bearer`。
- 创建：`POST /api/v1/services/aigc/video-generation/video-synthesis`（`originPath: true`，自动替换 `/compatible-mode/v1` 路径前缀并附带 `X-DashScope-Async: enable`）。
- 查询：`GET /api/v1/tasks/{{taskId}}`（`originPath: true`）。

## 配置字段

| 字段 | 类型 | 必填 | 含义 |
| --- | --- | --- | --- |
| `apiKey` | secret | 是 | API Key |

## 统一字段映射

| 统一字段 | 类型 | 必填 | 上游映射 | 说明 |
| --- | --- | --- | --- | --- |
| `model` | string | 是 | `model` | 视频模型 ID。 |
| `prompt` | string | 是 | `input.prompt` | 视频提示词。 |
| `images` | media[] | 否 | `input.media`（Wan 2.7/3.0）或 `img_url/first_frame_url/last_frame_url/reference_images`（Wan 2.1–2.6） | 显式 role 图片输入。 |
| `videos` | media[] | 否 | `input.media[type=reference_video]` 或 `input.video_url` | 参考视频。 |
| `audios` | media[] | 否 | `input.media[type=reference_audio]` 或 `input.audio_url` | 参考音频或音色。 |
| `duration` | integer | 否 | `parameters.duration` | 时长秒数（Wan 3.0 支持 2–30 或 -1）。 |
| `aspectRatio` | string | 否 | `parameters.ratio`（Wan 2.7/3.0） | 画幅比例（`adaptive`、`21:9`、`16:9`、`9:16`、`1:1`、`4:3`、`3:4`）。 |
| `resolution` | string | 否 | `parameters.resolution`（Wan 2.7/3.0 大写 `480P`/`720P`/`1080P`）或 `parameters.size`（Wan 2.1–2.6） | 分辨率档位。 |
| `generateAudio` | boolean | 否 | `parameters.audio` | 是否生成音频。 |
| `watermark` | boolean | 否 | `parameters.watermark` | 水印开关。 |
| `providerOptions` | object | 否 | `provider-specific fields` | 插件命名空间内的厂商扩展字段。 |

## Provider 扩展键

- `providerOptions.dashscope-wan-video.negative_prompt`
- `providerOptions.dashscope-wan-video.prompt_extend`
- `providerOptions.dashscope-wan-video.seed`
- `providerOptions.dashscope-wan-video.shot_type`
- `providerOptions.dashscope-wan-video.template`

## 响应与错误

插件把上游 `output.task_id`、`output.task_status`（兼容顶层 `task_status`/`status`）、`output.video_url` / `output.results` 与 `usage` 映射为统一结果。临时媒体 URL 标记为 ephemeral，由宿主立即下载持久化。HTTP 错误、业务 `code`/`output.code` 以及 `FAILED`/`UNKNOWN` 状态均按失败处理，不会包装成成功或无限轮询。

## 兼容边界

- **Wan 2.7 / 3.0 系列**（`wan3.0-*`、`wan3-*`、`wan2.7-*`）：按阿里云百炼官方文档使用统一 `input.media` 数组（`first_frame`、`last_frame`、`reference_image`、`reference_video`、`reference_audio`），以及 `parameters.resolution`（大写 `480P`/`720P`/`1080P`）和 `parameters.ratio`；其中 Wan 3.0 首尾帧模式与多模态参考互斥，提交前拦截混用。
- **Wan 2.1–2.6 系列**：保持原有 `input.img_url`、`input.first_frame_url`、`input.last_frame_url`、`input.reference_images`、`input.video_url`、`input.audio_url` 与 `parameters.size` 结构不变。
- `originPath: true` 允许复用已配置为 `https://dashscope.aliyuncs.com/compatible-mode/v1` 或业务空间专属域名的百炼渠道，自动解析到域名根路径 `/api/v1/...`。

<!-- BEEFTV_PLUGIN_MANIFEST_START -->
## Manifest 完整接口定义

以下 JSON 与插件包内实际 `manifest.json` 逐字段一致，覆盖插件身份、权限、配置、鉴权、参数、校验、创建、Agent、查询、取消、结果下载、响应和 Agent 响应映射。`documentation` 字段的值就是当前完整文档；为避免文档在自身内部无限递归，JSON 中仅用等义占位文本表示正文。

```json
{
  "apiVersion": "beeftv.plugin/v3",
  "id": "dashscope-wan-video",
  "name": "DashScope Wan Video",
  "version": "2.1.0",
  "author": "影策 / Open AI Canvas contributors",
  "description": "DashScope Wan Video 独立请求协议插件，兼容 Wan 2.1–2.6 传统字段与 Wan 2.7 / 3.0 统一 input.media 数组格式。",
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
        "id": "dashscope-wan-video",
        "label": "DashScope Wan Video",
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
        "baseUrl": "https://dashscope.aliyuncs.com",
        "requiresPublicMediaUrls": true,
        "mediaTransport": {
          "image": "inline",
          "video": "url",
          "audio": "url"
        },
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
            "description": "视频模型 ID（如 wan3.0-video、wan3.0-video-prime、wan2.7-i2v、wan2.6-r2v、wan2.2-kf2v-flash）。"
          },
          {
            "name": "prompt",
            "type": "string",
            "required": true,
            "mapping": "input.prompt",
            "description": "视频提示词。"
          },
          {
            "name": "images",
            "type": "media[]",
            "required": false,
            "mapping": "input.media（Wan 2.7/3.0）或 input.img_url / first_frame_url / last_frame_url / reference_images（Wan 2.1–2.6）",
            "description": "显式 role 图片输入。"
          },
          {
            "name": "videos",
            "type": "media[]",
            "required": false,
            "mapping": "input.media[type=reference_video] 或 input.video_url",
            "description": "参考视频。"
          },
          {
            "name": "audios",
            "type": "media[]",
            "required": false,
            "mapping": "input.media[type=reference_audio] 或 input.audio_url",
            "description": "参考音频或音色。"
          },
          {
            "name": "duration",
            "type": "integer",
            "required": false,
            "mapping": "parameters.duration",
            "description": "时长秒数（Wan 3.0 支持 2–30 或 -1）。"
          },
          {
            "name": "aspectRatio",
            "type": "string",
            "required": false,
            "mapping": "parameters.ratio（Wan 2.7/3.0）",
            "description": "画幅比例（adaptive、21:9、16:9、9:16、1:1、4:3、3:4）。"
          },
          {
            "name": "resolution",
            "type": "string",
            "required": false,
            "mapping": "parameters.resolution（Wan 2.7/3.0 大写 480P/720P/1080P）或 parameters.size（Wan 2.1–2.6）",
            "description": "分辨率档位。"
          },
          {
            "name": "generateAudio",
            "type": "boolean",
            "required": false,
            "mapping": "parameters.audio",
            "description": "是否生成音频。"
          },
          {
            "name": "watermark",
            "type": "boolean",
            "required": false,
            "mapping": "parameters.watermark",
            "description": "水印开关。"
          },
          {
            "name": "providerOptions",
            "type": "object",
            "required": false,
            "mapping": "provider-specific fields",
            "description": "插件命名空间内的厂商扩展字段。"
          }
        ],
        "variables": [
          {
            "name": "modelFamily",
            "value": {
              "$at": [
                {
                  "$split": [
                    {
                      "$last": {
                        "$split": [
                          {
                            "$lower": {
                              "$trim": {
                                "$ref": "request.model"
                              }
                            }
                          },
                          "/"
                        ]
                      }
                    },
                    "-"
                  ]
                },
                0
              ]
            }
          },
          {
            "name": "usesMediaArray",
            "value": {
              "$in": [
                {
                  "$ref": "vars.modelFamily"
                },
                [
                  "wan2.7",
                  "wan3.0",
                  "wan3"
                ]
              ]
            }
          },
          {
            "name": "isWan3",
            "value": {
              "$in": [
                {
                  "$ref": "vars.modelFamily"
                },
                [
                  "wan3.0",
                  "wan3"
                ]
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
                        "$sortByOrder": {
                          "$ref": "request.images"
                        }
                      },
                      "as": "media",
                      "where": {
                        "$in": [
                          {
                            "$ref": "media.role"
                          },
                          [
                            "first_frame"
                          ]
                        ]
                      }
                    }
                  }
                },
                1
              ]
            },
            "message": "Wan 视频最多只能有一个首帧"
          },
          {
            "assert": {
              "$lte": [
                {
                  "$len": {
                    "$filter": {
                      "from": {
                        "$sortByOrder": {
                          "$ref": "request.images"
                        }
                      },
                      "as": "media",
                      "where": {
                        "$in": [
                          {
                            "$ref": "media.role"
                          },
                          [
                            "last_frame"
                          ]
                        ]
                      }
                    }
                  }
                },
                1
              ]
            },
            "message": "Wan 视频最多只能有一个尾帧"
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
                            "$sortByOrder": {
                              "$ref": "request.images"
                            }
                          },
                          "as": "media",
                          "where": {
                            "$in": [
                              {
                                "$ref": "media.role"
                              },
                              [
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
                  "$eq": [
                    {
                      "$len": {
                        "$filter": {
                          "from": {
                            "$sortByOrder": {
                              "$ref": "request.images"
                            }
                          },
                          "as": "media",
                          "where": {
                            "$in": [
                              {
                                "$ref": "media.role"
                              },
                              [
                                "first_frame"
                              ]
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
            "message": "Wan 视频使用尾帧时必须同时提供首帧"
          },
          {
            "assert": {
              "$or": [
                {
                  "$not": {
                    "$ref": "vars.isWan3"
                  }
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
            "message": "Wan 3.0 首尾帧模式不能同时混用参考图、参考视频或参考音频"
          }
        ],
        "create": {
          "method": "POST",
          "path": "/api/v1/services/aigc/video-generation/video-synthesis",
          "originPath": true,
          "contentType": "application/json",
          "body": {
            "model": {
              "$ref": "request.model"
            },
            "input": {
              "prompt": {
                "$omitEmpty": {
                  "$ref": "request.prompt"
                }
              },
              "negative_prompt": {
                "$omitEmpty": {
                  "$ref": "request.providerOptions.dashscope-wan-video.negative_prompt"
                }
              },
              "media": {
                "$omitEmpty": {
                  "$if": {
                    "condition": {
                      "$ref": "vars.usesMediaArray"
                    },
                    "then": {
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
                    },
                    "else": null
                  }
                }
              },
              "img_url": {
                "$omitEmpty": {
                  "$if": {
                    "condition": {
                      "$and": [
                        {
                          "$not": {
                            "$ref": "vars.usesMediaArray"
                          }
                        },
                        {
                          "$ne": [
                            {
                              "$ref": "request.operation"
                            },
                            "reference_to_video"
                          ]
                        },
                        {
                          "$eq": [
                            {
                              "$len": {
                                "$filter": {
                                  "from": {
                                    "$sortByOrder": {
                                      "$ref": "request.images"
                                    }
                                  },
                                  "as": "media",
                                  "where": {
                                    "$in": [
                                      {
                                        "$ref": "media.role"
                                      },
                                      [
                                        "last_frame"
                                      ]
                                    ]
                                  }
                                }
                              }
                            },
                            0
                          ]
                        }
                      ]
                    },
                    "then": {
                      "$coalesce": [
                        {
                          "$first": {
                            "$map": {
                              "from": {
                                "$filter": {
                                  "from": {
                                    "$sortByOrder": {
                                      "$ref": "request.images"
                                    }
                                  },
                                  "as": "media",
                                  "where": {
                                    "$in": [
                                      {
                                        "$ref": "media.role"
                                      },
                                      [
                                        "first_frame"
                                      ]
                                    ]
                                  }
                                }
                              },
                              "as": "media",
                              "in": {
                                "$ref": "media.value"
                              }
                            }
                          }
                        },
                        {
                          "$first": {
                            "$map": {
                              "from": {
                                "$filter": {
                                  "from": {
                                    "$sortByOrder": {
                                      "$ref": "request.images"
                                    }
                                  },
                                  "as": "media",
                                  "where": {
                                    "$in": [
                                      {
                                        "$ref": "media.role"
                                      },
                                      [
                                        "reference_image",
                                        "edit_source",
                                        ""
                                      ]
                                    ]
                                  }
                                }
                              },
                              "as": "media",
                              "in": {
                                "$ref": "media.value"
                              }
                            }
                          }
                        }
                      ]
                    },
                    "else": null
                  }
                }
              },
              "first_frame_url": {
                "$omitEmpty": {
                  "$if": {
                    "condition": {
                      "$and": [
                        {
                          "$not": {
                            "$ref": "vars.usesMediaArray"
                          }
                        },
                        {
                          "$gt": [
                            {
                              "$len": {
                                "$filter": {
                                  "from": {
                                    "$sortByOrder": {
                                      "$ref": "request.images"
                                    }
                                  },
                                  "as": "media",
                                  "where": {
                                    "$in": [
                                      {
                                        "$ref": "media.role"
                                      },
                                      [
                                        "last_frame"
                                      ]
                                    ]
                                  }
                                }
                              }
                            },
                            0
                          ]
                        }
                      ]
                    },
                    "then": {
                      "$first": {
                        "$map": {
                          "from": {
                            "$filter": {
                              "from": {
                                "$sortByOrder": {
                                  "$ref": "request.images"
                                }
                              },
                              "as": "media",
                              "where": {
                                "$in": [
                                  {
                                    "$ref": "media.role"
                                  },
                                  [
                                    "first_frame"
                                  ]
                                ]
                              }
                            }
                          },
                          "as": "media",
                          "in": {
                            "$ref": "media.value"
                          }
                        }
                      }
                    },
                    "else": null
                  }
                }
              },
              "last_frame_url": {
                "$omitEmpty": {
                  "$if": {
                    "condition": {
                      "$not": {
                        "$ref": "vars.usesMediaArray"
                      }
                    },
                    "then": {
                      "$first": {
                        "$map": {
                          "from": {
                            "$filter": {
                              "from": {
                                "$sortByOrder": {
                                  "$ref": "request.images"
                                }
                              },
                              "as": "media",
                              "where": {
                                "$in": [
                                  {
                                    "$ref": "media.role"
                                  },
                                  [
                                    "last_frame"
                                  ]
                                ]
                              }
                            }
                          },
                          "as": "media",
                          "in": {
                            "$ref": "media.value"
                          }
                        }
                      }
                    },
                    "else": null
                  }
                }
              },
              "reference_images": {
                "$omitEmpty": {
                  "$if": {
                    "condition": {
                      "$and": [
                        {
                          "$not": {
                            "$ref": "vars.usesMediaArray"
                          }
                        },
                        {
                          "$eq": [
                            {
                              "$ref": "request.operation"
                            },
                            "reference_to_video"
                          ]
                        }
                      ]
                    },
                    "then": {
                      "$map": {
                        "from": {
                          "$filter": {
                            "from": {
                              "$sortByOrder": {
                                "$ref": "request.images"
                              }
                            },
                            "as": "media",
                            "where": {
                              "$in": [
                                {
                                  "$ref": "media.role"
                                },
                                [
                                  "reference_image",
                                  "subject_reference",
                                  "style_reference"
                                ]
                              ]
                            }
                          }
                        },
                        "as": "media",
                        "in": {
                          "$ref": "media.value"
                        }
                      }
                    },
                    "else": null
                  }
                }
              },
              "video_url": {
                "$omitEmpty": {
                  "$if": {
                    "condition": {
                      "$not": {
                        "$ref": "vars.usesMediaArray"
                      }
                    },
                    "then": {
                      "$first": {
                        "$map": {
                          "from": {
                            "$filter": {
                              "from": {
                                "$sortByOrder": {
                                  "$ref": "request.videos"
                                }
                              },
                              "as": "media",
                              "where": {
                                "$in": [
                                  {
                                    "$ref": "media.role"
                                  },
                                  [
                                    "reference_video",
                                    ""
                                  ]
                                ]
                              }
                            }
                          },
                          "as": "media",
                          "in": {
                            "$ref": "media.value"
                          }
                        }
                      }
                    },
                    "else": null
                  }
                }
              },
              "audio_url": {
                "$omitEmpty": {
                  "$if": {
                    "condition": {
                      "$not": {
                        "$ref": "vars.usesMediaArray"
                      }
                    },
                    "then": {
                      "$first": {
                        "$map": {
                          "from": {
                            "$filter": {
                              "from": {
                                "$sortByOrder": {
                                  "$ref": "request.audios"
                                }
                              },
                              "as": "media",
                              "where": {
                                "$in": [
                                  {
                                    "$ref": "media.role"
                                  },
                                  [
                                    "reference_audio",
                                    "reference_voice",
                                    ""
                                  ]
                                ]
                              }
                            }
                          },
                          "as": "media",
                          "in": {
                            "$ref": "media.value"
                          }
                        }
                      }
                    },
                    "else": null
                  }
                }
              }
            },
            "parameters": {
              "size": {
                "$omitEmpty": {
                  "$if": {
                    "condition": {
                      "$not": {
                        "$ref": "vars.usesMediaArray"
                      }
                    },
                    "then": {
                      "$ref": "request.resolution"
                    },
                    "else": null
                  }
                }
              },
              "resolution": {
                "$omitEmpty": {
                  "$if": {
                    "condition": {
                      "$ref": "vars.usesMediaArray"
                    },
                    "then": {
                      "$switch": {
                        "cases": [
                          {
                            "when": {
                              "$in": [
                                {
                                  "$upper": {
                                    "$trim": {
                                      "$ref": "request.resolution"
                                    }
                                  }
                                },
                                [
                                  "480",
                                  "480P"
                                ]
                              ]
                            },
                            "then": "480P"
                          },
                          {
                            "when": {
                              "$in": [
                                {
                                  "$upper": {
                                    "$trim": {
                                      "$ref": "request.resolution"
                                    }
                                  }
                                },
                                [
                                  "720",
                                  "720P"
                                ]
                              ]
                            },
                            "then": "720P"
                          },
                          {
                            "when": {
                              "$in": [
                                {
                                  "$upper": {
                                    "$trim": {
                                      "$ref": "request.resolution"
                                    }
                                  }
                                },
                                [
                                  "1080",
                                  "1080P"
                                ]
                              ]
                            },
                            "then": "1080P"
                          }
                        ],
                        "default": {
                          "$omitEmpty": {
                            "$upper": {
                              "$trim": {
                                "$ref": "request.resolution"
                              }
                            }
                          }
                        }
                      }
                    },
                    "else": null
                  }
                }
              },
              "ratio": {
                "$omitEmpty": {
                  "$if": {
                    "condition": {
                      "$ref": "vars.usesMediaArray"
                    },
                    "then": {
                      "$switch": {
                        "cases": [
                          {
                            "when": {
                              "$eq": [
                                {
                                  "$trim": {
                                    "$ref": "request.aspectRatio"
                                  }
                                },
                                ""
                              ]
                            },
                            "then": null
                          },
                          {
                            "when": {
                              "$in": [
                                {
                                  "$lower": {
                                    "$trim": {
                                      "$ref": "request.aspectRatio"
                                    }
                                  }
                                },
                                [
                                  "auto",
                                  "adaptive"
                                ]
                              ]
                            },
                            "then": "adaptive"
                          },
                          {
                            "when": {
                              "$in": [
                                {
                                  "$trim": {
                                    "$ref": "request.aspectRatio"
                                  }
                                },
                                [
                                  "21:9",
                                  "16:9",
                                  "9:16",
                                  "1:1",
                                  "4:3",
                                  "3:4"
                                ]
                              ]
                            },
                            "then": {
                              "$trim": {
                                "$ref": "request.aspectRatio"
                              }
                            }
                          }
                        ],
                        "default": "adaptive"
                      }
                    },
                    "else": null
                  }
                }
              },
              "duration": {
                "$omitEmpty": {
                  "$if": {
                    "condition": {
                      "$or": [
                        {
                          "$gt": [
                            {
                              "$ref": "request.duration"
                            },
                            0
                          ]
                        },
                        {
                          "$eq": [
                            {
                              "$ref": "request.duration"
                            },
                            -1
                          ]
                        }
                      ]
                    },
                    "then": {
                      "$ref": "request.duration"
                    },
                    "else": null
                  }
                }
              },
              "prompt_extend": {
                "$omitEmpty": {
                  "$ref": "request.providerOptions.dashscope-wan-video.prompt_extend"
                }
              },
              "watermark": {
                "$ref": "request.watermark"
              },
              "seed": {
                "$omitEmpty": {
                  "$ref": "request.providerOptions.dashscope-wan-video.seed"
                }
              },
              "shot_type": {
                "$omitEmpty": {
                  "$ref": "request.providerOptions.dashscope-wan-video.shot_type"
                }
              },
              "audio": {
                "$ref": "request.generateAudio"
              },
              "template": {
                "$omitEmpty": {
                  "$ref": "request.providerOptions.dashscope-wan-video.template"
                }
              }
            }
          },
          "headers": {
            "X-DashScope-Async": "enable"
          }
        },
        "poll": {
          "method": "GET",
          "path": "/api/v1/tasks/{{taskId}}",
          "originPath": true
        },
        "response": {
          "taskId": {
            "$coalesce": [
              {
                "$ref": "response.output.task_id"
              },
              {
                "$ref": "response.task_id"
              },
              {
                "$ref": "taskId"
              }
            ]
          },
          "status": {
            "$coalesce": [
              {
                "$ref": "response.output.task_status"
              },
              {
                "$ref": "response.task_status"
              },
              {
                "$ref": "response.status"
              },
              "pending"
            ]
          },
          "message": {
            "$coalesce": [
              {
                "$ref": "response.output.message"
              },
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
                "$ref": "response.output.video_url"
              },
              {
                "$ref": "response.output.results"
              },
              {
                "$ref": "response.video_url"
              }
            ]
          },
          "errorPaths": [
            "code",
            "output.code"
          ],
          "resultEphemeral": true,
          "usage": {
            "$ref": "response.usage"
          },
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
