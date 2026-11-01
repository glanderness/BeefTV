# AIHubKit Video 接口字段

## 协议身份

- 插件 ID：`aihubkit-video`。
- Provider ID：`aihubkit-video`。
- 能力：`video`。
- 默认 Base URL：`https://apimodel.aihubkit.com`。
- 鉴权驱动：`bearer`。
- 创建：`POST /v1/videos`。
- 查询：`GET /v1/videos/{{taskId}}`。

## 配置字段

| 字段 | 类型 | 必填 | 含义 |
| --- | --- | --- | --- |
| `apiKey` | secret | 是 | API Key |

## 统一字段映射

| 统一字段 | 类型 | 必填 | 上游映射 | 说明 |
| --- | --- | --- | --- | --- |
| `model` | string | 是 | `model` | 渠道模型 ID，例如 seedance-2.5_v1。 |
| `prompt` | string | 是 | `prompt` | 视频提示词。 |
| `duration` | integer | 是 | `duration` | 视频时长（秒），范围由模型决定。 |
| `resolution` | string | 是 | `resolution` | 分辨率；数字档位转换为带 p 后缀的小写值。 |
| `aspectRatio` | string | 否 | `ratio` | 视频比例，例如 16:9。 |
| `images` | media[] | 否 | `referenceImages` | 参考图片的公网 HTTPS URL，按素材顺序发送。 |
| `videos` | media[] | 否 | `referenceVideos` | 参考视频的公网 HTTPS URL。 |
| `audios` | media[] | 否 | `referenceAudios` | 参考音频的公网 HTTPS URL。 |

## 上游请求模板逐字段清单

下表由插件请求模板生成，覆盖 body、query、headers 和 multipart 文件声明中的每个字段。

| 上游位置 | 值或转换表达式 |
| --- | --- |
| `create.method` | `"POST"` |
| `create.path` | `"/v1/videos"` |
| `create.contentType` | `"application/json"` |
| `create.body.model` | `{"$ref":"request.model"}` |
| `create.body.prompt` | `{"$ref":"request.prompt"}` |
| `create.body.duration` | `{"$ref":"request.duration"}` |
| `create.body.ratio` | `{"$omitEmpty":{"$ref":"request.aspectRatio"}}` |
| `create.body.resolution` | `{"$if":{"condition":{"$gt":[{"$toInt":{"$trim":{"$ref":"request.resolution"}}},0]},"then":{"$concat":[{"$toInt":{"$trim":{"$ref":"request.resolution"}}},"p"]},"else":{"$lower":{"$trim":{"$ref":"request.resolution"}}}}}` |
| `create.body.referenceImages` | `{"$omitEmpty":{"$map":{"from":{"$sortByOrder":{"$ref":"request.images"}},"as":"media","in":{"$ref":"media.value"}}}}` |
| `create.body.referenceVideos` | `{"$omitEmpty":{"$map":{"from":{"$sortByOrder":{"$ref":"request.videos"}},"as":"media","in":{"$ref":"media.value"}}}}` |
| `create.body.referenceAudios` | `{"$omitEmpty":{"$map":{"from":{"$sortByOrder":{"$ref":"request.audios"}},"as":"media","in":{"$ref":"media.value"}}}}` |
| `poll.method` | `"GET"` |
| `poll.path` | `"/v1/videos/{{taskId}}"` |
| `poll.contentType` | `"application/json"` |
| `result.method` | `"GET"` |
| `result.path` | `"/v1/videos/{{taskId}}/content"` |
| `result.contentType` | `"application/json"` |
| `result.headers.Accept` | `"video/mp4"` |

## Provider 扩展键

- 无额外扩展键。

动态模型或工作流允许使用文档声明的完整 `parameters/input/extra_body` 对象；该对象是协议本身的开放 schema，不会被宿主裁剪。

## 响应映射逐字段清单

| 映射位置 | 上游路径或转换表达式 |
| --- | --- |
| `response.taskId` | `{"$coalesce":[{"$ref":"response.id"},{"$ref":"response.task_id"},{"$ref":"taskId"}]}` |
| `response.status` | `{"$coalesce":[{"$ref":"response.status"},"unknown"]}` |
| `response.videos` | `{"$ref":"response.url"}` |
| `response.usage` | `{"$ref":"response.usage"}` |
| `response.messagePaths[0]` | `"error.message"` |
| `response.messagePaths[1]` | `"message"` |
| `response.errorPaths[0]` | `"error.code"` |
| `response.resultEphemeral` | `true` |

## 响应与错误

插件把上游 task/status/text/media/usage 映射为统一结果。临时媒体 URL 标记为 ephemeral，由宿主立即下载持久化。HTTP 错误、业务 code 和 error object 保持失败语义，不包装成成功。

## 兼容边界

接口依据：https://86bdknokqu.apifox.cn/9260936m0 。配置渠道 Base URL 为 https://apimodel.aihubkit.com（已有 /v1 后缀也可由宿主合并），在模型设置中选择 AIHubKit Video。不要选择 Agnes、OpenAI Videos multipart 或其他 JSON profile。所有参考素材必须为公网可访问的 HTTPS URL；requiresPublicMediaUrls 让宿主使用已配置的公网素材存储，插件不自动向第三方图床上传素材。当前文档未明确首尾帧的字段名，因此显式首尾帧输入会在提交前失败，不将其转换为参考图。模型的分辨率、时长、素材数量上限以渠道实际支持为准。queued/unknown 保持等待，in_progress 映射为处理中，completed 映射为成功，failed 保持失败。完成后的 url 指向鉴权下载端点，宿主只向同源地址附加凭证并持久化视频；未返回 url 时使用同一任务的 /content 端点。未执行真实付费生成验收。

<!-- BEEFTV_PLUGIN_MANIFEST_START -->
## Manifest 完整接口定义

以下 JSON 与插件包内实际 `manifest.json` 逐字段一致，覆盖插件身份、权限、配置、鉴权、参数、校验、创建、Agent、查询、取消、结果下载、响应和 Agent 响应映射。`documentation` 字段的值就是当前完整文档；为避免文档在自身内部无限递归，JSON 中仅用等义占位文本表示正文。

```json
{
  "apiVersion": "beeftv.plugin/v2",
  "id": "aihubkit-video",
  "name": "AIHubKit Video",
  "version": "1.0.0",
  "author": "BeefTV Contributors",
  "description": "AIHubKit Video 独立请求协议插件。",
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
        "id": "aihubkit-video",
        "label": "AIHubKit Video",
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
        "baseUrl": "https://apimodel.aihubkit.com",
        "requiresPublicMediaUrls": true,
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
            "description": "渠道模型 ID，例如 seedance-2.5_v1。"
          },
          {
            "name": "prompt",
            "type": "string",
            "required": true,
            "mapping": "prompt",
            "description": "视频提示词。"
          },
          {
            "name": "duration",
            "type": "integer",
            "required": true,
            "mapping": "duration",
            "description": "视频时长（秒），范围由模型决定。"
          },
          {
            "name": "resolution",
            "type": "string",
            "required": true,
            "mapping": "resolution",
            "description": "分辨率；数字档位转换为带 p 后缀的小写值。"
          },
          {
            "name": "aspectRatio",
            "type": "string",
            "required": false,
            "mapping": "ratio",
            "description": "视频比例，例如 16:9。"
          },
          {
            "name": "images",
            "type": "media[]",
            "required": false,
            "mapping": "referenceImages",
            "description": "参考图片的公网 HTTPS URL，按素材顺序发送。"
          },
          {
            "name": "videos",
            "type": "media[]",
            "required": false,
            "mapping": "referenceVideos",
            "description": "参考视频的公网 HTTPS URL。"
          },
          {
            "name": "audios",
            "type": "media[]",
            "required": false,
            "mapping": "referenceAudios",
            "description": "参考音频的公网 HTTPS URL。"
          }
        ],
        "validations": [
          {
            "assert": {
              "$gt": [
                {
                  "$len": {
                    "$trim": {
                      "$ref": "request.model"
                    }
                  }
                },
                0
              ]
            },
            "message": "AIHubKit Video 必须选择模型"
          },
          {
            "assert": {
              "$gt": [
                {
                  "$len": {
                    "$trim": {
                      "$ref": "request.prompt"
                    }
                  }
                },
                0
              ]
            },
            "message": "AIHubKit Video 提示词不能为空"
          },
          {
            "assert": {
              "$gt": [
                {
                  "$ref": "request.duration"
                },
                0
              ]
            },
            "message": "AIHubKit Video 时长必须为正整数"
          },
          {
            "assert": {
              "$gt": [
                {
                  "$len": {
                    "$trim": {
                      "$ref": "request.resolution"
                    }
                  }
                },
                0
              ]
            },
            "message": "AIHubKit Video 必须选择分辨率"
          },
          {
            "assert": {
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
                              "$coalesce": [
                                {
                                  "$ref": "media.role"
                                },
                                "reference_image"
                              ]
                            },
                            [
                              "reference_image",
                              "subject_reference",
                              "style_reference"
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
            "message": "AIHubKit Video 当前接口文档仅明确参考图字段，请使用参考图片，勿设置首尾帧或遮罩"
          },
          {
            "assert": {
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
                          "$and": [
                            {
                              "$eq": [
                                {
                                  "$at": [
                                    {
                                      "$split": [
                                        {
                                          "$ref": "media.value"
                                        },
                                        "://"
                                      ]
                                    },
                                    0
                                  ]
                                },
                                "https"
                              ]
                            },
                            {
                              "$gt": [
                                {
                                  "$len": {
                                    "$at": [
                                      {
                                        "$split": [
                                          {
                                            "$ref": "media.value"
                                          },
                                          "://"
                                        ]
                                      },
                                      1
                                    ]
                                  }
                                },
                                0
                              ]
                            }
                          ]
                        }
                      }
                    }
                  }
                },
                0
              ]
            },
            "message": "AIHubKit Video 参考素材必须使用公网 HTTPS URL，请先配置公网素材存储"
          },
          {
            "assert": {
              "$eq": [
                {
                  "$len": {
                    "$filter": {
                      "from": {
                        "$ref": "request.videos"
                      },
                      "as": "media",
                      "where": {
                        "$not": {
                          "$and": [
                            {
                              "$eq": [
                                {
                                  "$at": [
                                    {
                                      "$split": [
                                        {
                                          "$ref": "media.value"
                                        },
                                        "://"
                                      ]
                                    },
                                    0
                                  ]
                                },
                                "https"
                              ]
                            },
                            {
                              "$gt": [
                                {
                                  "$len": {
                                    "$at": [
                                      {
                                        "$split": [
                                          {
                                            "$ref": "media.value"
                                          },
                                          "://"
                                        ]
                                      },
                                      1
                                    ]
                                  }
                                },
                                0
                              ]
                            }
                          ]
                        }
                      }
                    }
                  }
                },
                0
              ]
            },
            "message": "AIHubKit Video 参考素材必须使用公网 HTTPS URL，请先配置公网素材存储"
          },
          {
            "assert": {
              "$eq": [
                {
                  "$len": {
                    "$filter": {
                      "from": {
                        "$ref": "request.audios"
                      },
                      "as": "media",
                      "where": {
                        "$not": {
                          "$and": [
                            {
                              "$eq": [
                                {
                                  "$at": [
                                    {
                                      "$split": [
                                        {
                                          "$ref": "media.value"
                                        },
                                        "://"
                                      ]
                                    },
                                    0
                                  ]
                                },
                                "https"
                              ]
                            },
                            {
                              "$gt": [
                                {
                                  "$len": {
                                    "$at": [
                                      {
                                        "$split": [
                                          {
                                            "$ref": "media.value"
                                          },
                                          "://"
                                        ]
                                      },
                                      1
                                    ]
                                  }
                                },
                                0
                              ]
                            }
                          ]
                        }
                      }
                    }
                  }
                },
                0
              ]
            },
            "message": "AIHubKit Video 参考素材必须使用公网 HTTPS URL，请先配置公网素材存储"
          }
        ],
        "create": {
          "method": "POST",
          "path": "/v1/videos",
          "contentType": "application/json",
          "body": {
            "model": {
              "$ref": "request.model"
            },
            "prompt": {
              "$ref": "request.prompt"
            },
            "duration": {
              "$ref": "request.duration"
            },
            "ratio": {
              "$omitEmpty": {
                "$ref": "request.aspectRatio"
              }
            },
            "resolution": {
              "$if": {
                "condition": {
                  "$gt": [
                    {
                      "$toInt": {
                        "$trim": {
                          "$ref": "request.resolution"
                        }
                      }
                    },
                    0
                  ]
                },
                "then": {
                  "$concat": [
                    {
                      "$toInt": {
                        "$trim": {
                          "$ref": "request.resolution"
                        }
                      }
                    },
                    "p"
                  ]
                },
                "else": {
                  "$lower": {
                    "$trim": {
                      "$ref": "request.resolution"
                    }
                  }
                }
              }
            },
            "referenceImages": {
              "$omitEmpty": {
                "$map": {
                  "from": {
                    "$sortByOrder": {
                      "$ref": "request.images"
                    }
                  },
                  "as": "media",
                  "in": {
                    "$ref": "media.value"
                  }
                }
              }
            },
            "referenceVideos": {
              "$omitEmpty": {
                "$map": {
                  "from": {
                    "$sortByOrder": {
                      "$ref": "request.videos"
                    }
                  },
                  "as": "media",
                  "in": {
                    "$ref": "media.value"
                  }
                }
              }
            },
            "referenceAudios": {
              "$omitEmpty": {
                "$map": {
                  "from": {
                    "$sortByOrder": {
                      "$ref": "request.audios"
                    }
                  },
                  "as": "media",
                  "in": {
                    "$ref": "media.value"
                  }
                }
              }
            }
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
                "$ref": "taskId"
              }
            ]
          },
          "status": {
            "$coalesce": [
              {
                "$ref": "response.status"
              },
              "unknown"
            ]
          },
          "videos": {
            "$ref": "response.url"
          },
          "usage": {
            "$ref": "response.usage"
          },
          "messagePaths": [
            "error.message",
            "message"
          ],
          "errorPaths": [
            "error.code"
          ],
          "resultEphemeral": true
        }
      }
    ]
  }
}
```
<!-- BEEFTV_PLUGIN_MANIFEST_END -->
