# Higgsfield MAGI‑2 接口说明

- 文生视频 `sand/magi-2/text-to-video`，需要提示词。
- 首尾帧 `sand/magi-2/image-to-video`，需要首帧图片，可选尾帧。
- 多素材参考 `sand/magi-2/reference-to-video`，需要至少一项参考素材。

三个模型均支持 4–30 秒、1080p 和可选音频。插件使用任务 ID 查询原请求，完成后取回视频。

[Higgsfield 官方 API 文档](https://open.higgsfield.ai/models/sand/magi-2/text-to-video/api-reference)

<!-- BEEFTV_PLUGIN_MANIFEST_START -->
## Manifest 完整接口定义

以下 JSON 与插件包内实际 `manifest.json` 逐字段一致，覆盖插件身份、权限、配置、鉴权、参数、校验、创建、Agent、查询、取消、结果下载、响应和 Agent 响应映射。`documentation` 字段的值就是当前完整文档；为避免文档在自身内部无限递归，JSON 中仅用等义占位文本表示正文。

```json
{
  "apiVersion": "beeftv.plugin/v2",
  "id": "higgsfield-magi-2",
  "name": "Higgsfield MAGI‑2",
  "version": "1.0.0",
  "description": "通过 Higgsfield 调用 MAGI‑2，支持文生视频、首尾帧和多素材参考。引用素材需要可由 Higgsfield 访问的 HTTPS 地址。",
  "permissions": [
    "generation.run",
    "media.read"
  ],
  "configuration": {
    "fields": [
      {
        "name": "apiKey",
        "type": "secret",
        "label": "API Key (ID:Secret)",
        "required": true
      }
    ]
  },
  "contributes": {
    "providers": [
      {
        "id": "higgsfield-magi-2",
        "label": "Higgsfield MAGI‑2",
        "baseUrl": "https://api.higgsfield.ai",
        "scopes": [
          "user.custom-channel",
          "canvas",
          "creation",
          "agent"
        ],
        "capabilities": [
          "video"
        ],
        "auth": {
          "type": "header",
          "field": "apiKey",
          "header": "Authorization",
          "prefix": "Key "
        },
        "requiresPublicMediaUrls": true,
        "mediaTransport": {
          "image": "url",
          "video": "url",
          "audio": "url"
        },
        "validations": [
          {
            "assert": {
              "$or": [
                {
                  "$eq": [
                    {
                      "$ref": "request.model"
                    },
                    "sand/magi-2/text-to-video"
                  ]
                },
                {
                  "$eq": [
                    {
                      "$ref": "request.model"
                    },
                    "sand/magi-2/image-to-video"
                  ]
                },
                {
                  "$eq": [
                    {
                      "$ref": "request.model"
                    },
                    "sand/magi-2/reference-to-video"
                  ]
                }
              ]
            },
            "message": "请选择 Higgsfield 的 MAGI‑2 模型。"
          },
          {
            "assert": {
              "$if": {
                "condition": {
                  "$eq": [
                    {
                      "$ref": "request.model"
                    },
                    "sand/magi-2/text-to-video"
                  ]
                },
                "then": {
                  "$eq": [
                    {
                      "$len": {
                        "$concatArrays": [
                          {
                            "$ref": "request.images"
                          },
                          {
                            "$ref": "request.videos"
                          },
                          {
                            "$ref": "request.audios"
                          }
                        ]
                      }
                    },
                    0
                  ]
                },
                "else": {
                  "$if": {
                    "condition": {
                      "$eq": [
                        {
                          "$ref": "request.model"
                        },
                        "sand/magi-2/image-to-video"
                      ]
                    },
                    "then": {
                      "$and": [
                        {
                          "$in": [
                            {
                              "$len": {
                                "$ref": "request.images"
                              }
                            },
                            [
                              1,
                              2
                            ]
                          ]
                        },
                        {
                          "$eq": [
                            {
                              "$len": {
                                "$concatArrays": [
                                  {
                                    "$ref": "request.images"
                                  },
                                  {
                                    "$ref": "request.videos"
                                  },
                                  {
                                    "$ref": "request.audios"
                                  }
                                ]
                              }
                            },
                            {
                              "$len": {
                                "$ref": "request.images"
                              }
                            }
                          ]
                        }
                      ]
                    },
                    "else": {
                      "$and": [
                        {
                          "$gt": [
                            {
                              "$len": {
                                "$concatArrays": [
                                  {
                                    "$ref": "request.images"
                                  },
                                  {
                                    "$ref": "request.videos"
                                  },
                                  {
                                    "$ref": "request.audios"
                                  }
                                ]
                              }
                            },
                            0
                          ]
                        },
                        {
                          "$lte": [
                            {
                              "$len": {
                                "$ref": "request.images"
                              }
                            },
                            10
                          ]
                        },
                        {
                          "$lte": [
                            {
                              "$len": {
                                "$ref": "request.videos"
                              }
                            },
                            5
                          ]
                        },
                        {
                          "$lte": [
                            {
                              "$len": {
                                "$ref": "request.audios"
                              }
                            },
                            5
                          ]
                        }
                      ]
                    }
                  }
                }
              }
            },
            "message": "文生视频无需素材；图生视频使用 1–2 张图；多参考模式需要至少一个素材，最多 10 张图、5 段视频和 5 段音频。"
          },
          {
            "assert": {
              "$or": [
                {
                  "$not": {
                    "$eq": [
                      {
                        "$ref": "request.model"
                      },
                      "sand/magi-2/text-to-video"
                    ]
                  }
                },
                {
                  "$gt": [
                    {
                      "$len": {
                        "$ref": "request.prompt"
                      }
                    },
                    0
                  ]
                }
              ]
            },
            "message": "请输入文生视频提示词。"
          }
        ],
        "create": {
          "method": "POST",
          "path": "/sand/magi-2/text-to-video",
          "pathTemplate": {
            "$if": {
              "condition": {
                "$eq": [
                  {
                    "$ref": "request.model"
                  },
                  "sand/magi-2/image-to-video"
                ]
              },
              "then": "/sand/magi-2/image-to-video",
              "else": {
                "$if": {
                  "condition": {
                    "$eq": [
                      {
                        "$ref": "request.model"
                      },
                      "sand/magi-2/reference-to-video"
                    ]
                  },
                  "then": "/sand/magi-2/reference-to-video",
                  "else": "/sand/magi-2/text-to-video"
                }
              }
            }
          },
          "body": {
            "prompt": {
              "$omitEmpty": {
                "$ref": "request.prompt"
              }
            },
            "duration": {
              "$if": {
                "condition": {
                  "$gt": [
                    {
                      "$ref": "request.output.duration"
                    },
                    0
                  ]
                },
                "then": {
                  "$ref": "request.output.duration"
                },
                "else": 5
              }
            },
            "aspect_ratio": {
              "$coalesce": [
                {
                  "$ref": "request.output.aspectRatio"
                },
                "16:9"
              ]
            },
            "resolution": "1080p",
            "generate_audio": {
              "$coalesce": [
                {
                  "$ref": "request.output.generateAudio"
                },
                {
                  "$ref": "request.generateAudio"
                }
              ]
            },
            "image_url": {
              "$omitEmpty": {
                "$if": {
                  "condition": {
                    "$eq": [
                      {
                        "$ref": "request.model"
                      },
                      "sand/magi-2/image-to-video"
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
                                      "first_frame",
                                      "start_frame"
                                    ]
                                  ]
                                }
                              }
                            },
                            "as": "media",
                            "in": {
                              "$ref": "media.url"
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
                                  "$eq": [
                                    {
                                      "$ref": "mediaIndex"
                                    },
                                    0
                                  ]
                                }
                              }
                            },
                            "as": "image",
                            "in": {
                              "$ref": "image.url"
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
            "end_image_url": {
              "$omitEmpty": {
                "$if": {
                  "condition": {
                    "$and": [
                      {
                        "$eq": [
                          {
                            "$ref": "request.model"
                          },
                          "sand/magi-2/image-to-video"
                        ]
                      },
                      {
                        "$eq": [
                          {
                            "$len": {
                              "$ref": "request.images"
                            }
                          },
                          2
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
                                      "last_frame",
                                      "end_frame"
                                    ]
                                  ]
                                }
                              }
                            },
                            "as": "media",
                            "in": {
                              "$ref": "media.url"
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
                                  "$eq": [
                                    {
                                      "$ref": "mediaIndex"
                                    },
                                    1
                                  ]
                                }
                              }
                            },
                            "as": "image",
                            "in": {
                              "$ref": "image.url"
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
            "image_urls": {
              "$omitEmpty": {
                "$if": {
                  "condition": {
                    "$eq": [
                      {
                        "$ref": "request.model"
                      },
                      "sand/magi-2/reference-to-video"
                    ]
                  },
                  "then": {
                    "$map": {
                      "from": {
                        "$sortByOrder": {
                          "$ref": "request.images"
                        }
                      },
                      "as": "media",
                      "in": {
                        "$ref": "media.url"
                      }
                    }
                  },
                  "else": null
                }
              }
            },
            "video_urls": {
              "$omitEmpty": {
                "$if": {
                  "condition": {
                    "$eq": [
                      {
                        "$ref": "request.model"
                      },
                      "sand/magi-2/reference-to-video"
                    ]
                  },
                  "then": {
                    "$map": {
                      "from": {
                        "$ref": "request.videos"
                      },
                      "as": "media",
                      "in": {
                        "$ref": "media.url"
                      }
                    }
                  },
                  "else": null
                }
              }
            },
            "audio_urls": {
              "$omitEmpty": {
                "$if": {
                  "condition": {
                    "$eq": [
                      {
                        "$ref": "request.model"
                      },
                      "sand/magi-2/reference-to-video"
                    ]
                  },
                  "then": {
                    "$map": {
                      "from": {
                        "$ref": "request.audios"
                      },
                      "as": "media",
                      "in": {
                        "$ref": "media.url"
                      }
                    }
                  },
                  "else": null
                }
              }
            }
          },
          "originPath": true
        },
        "poll": {
          "method": "GET",
          "path": "/requests/{{taskId}}/status",
          "originPath": true
        },
        "cancel": {
          "method": "POST",
          "path": "/requests/{{taskId}}/cancel",
          "originPath": true
        },
        "response": {
          "taskIdPaths": [
            "request_id"
          ],
          "status": {
            "$if": {
              "condition": {
                "$eq": [
                  {
                    "$ref": "response.status"
                  },
                  "nsfw"
                ]
              },
              "then": "failed",
              "else": {
                "$ref": "response.status"
              }
            }
          },
          "messagePaths": [
            "error.message",
            "detail",
            "message"
          ],
          "resultUrlPaths": [
            "video.url"
          ],
          "resultKind": "video",
          "resultEphemeral": true
        }
      }
    ]
  },
  "documentation": "<当前插件的完整 documentation，由 README.md 与 docs/interface.md 拼接而成；为避免 JSON 递归，此处不重复展开正文。>"
}
```
<!-- BEEFTV_PLUGIN_MANIFEST_END -->
