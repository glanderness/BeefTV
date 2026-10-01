package creation

import (
	"encoding/json"
	"strings"

	"infinite-canvas/backend/internal/kernel"
)

type MediaRef struct {
	StorageKey string
	DataURL    string
	URL        string
}

func ValidateProtocolPlaceholders(refs []MediaRef, requests any) error {
	_, err := ResolveProtocolPlaceholders(refs, requests, false)
	return err
}

func ResolveProtocolPlaceholders(refs []MediaRef, requests any, hydrate bool) (any, error) {
	if requests == nil {
		return requests, nil
	}
	if hydrate {
		encoded, err := json.Marshal(requests)
		if err != nil {
			return nil, err
		}
		if !strings.Contains(string(encoded), `"resource:`) {
			return requests, nil
		}
	}
	references := map[string]string{}
	for _, media := range refs {
		if !strings.HasPrefix(media.StorageKey, "resource:") {
			return nil, kernel.BadAuthRequest("规划图片必须引用当前账号资源")
		}
		value := media.StorageKey
		if hydrate {
			value = kernel.FirstNonEmpty(media.DataURL, media.URL)
			if value == "" {
				return nil, kernel.BadAuthRequest("规划图片尚未读取成功")
			}
		}
		references[media.StorageKey] = value
	}
	b, err := json.Marshal(requests)
	if err != nil {
		return nil, err
	}
	var root any
	if err = json.Unmarshal(b, &root); err != nil {
		return nil, err
	}
	var visit func(any) (any, error)
	visit = func(value any) (any, error) {
		switch typed := value.(type) {
		case string:
			if strings.HasPrefix(typed, "resource:") {
				resolved, ok := references[typed]
				if !ok {
					return nil, kernel.BadAuthRequest("模型协议引用了未获准的图片")
				}
				return resolved, nil
			}
			return typed, nil
		case []any:
			for i, child := range typed {
				next, e := visit(child)
				if e != nil {
					return nil, e
				}
				typed[i] = next
			}
			return typed, nil
		case map[string]any:
			if !hydrate {
				var imageRef any
				switch typed["type"] {
				case "image_url":
					imageRef = typed["image_url"]
				case "input_image":
					imageRef = typed["image_url"]
				case "image":
					source, _ := typed["source"].(map[string]any)
					if source["type"] != "url" {
						return nil, kernel.BadAuthRequest("规划图片必须使用资源占位")
					}
					imageRef = source["url"]
				}
				if object, ok := imageRef.(map[string]any); ok {
					imageRef = object["url"]
				}
				if imageRef != nil {
					ref, ok := imageRef.(string)
					if !ok || references[ref] == "" {
						return nil, kernel.BadAuthRequest("规划图片不在获准资源清单")
					}
				}
				if raw, ok := typed["fileData"].(map[string]any); ok {
					ref, _ := raw["fileUri"].(string)
					if references[ref] == "" {
						return nil, kernel.BadAuthRequest("规划图片不在获准资源清单")
					}
				}
				if typed["inlineData"] != nil {
					return nil, kernel.BadAuthRequest("规划图片不能持久化内嵌数据")
				}
			}
			if hydrate && typed["type"] == "url" {
				if ref, ok := typed["url"].(string); ok && strings.HasPrefix(ref, "resource:") {
					data, ok := references[ref]
					if !ok {
						return nil, kernel.BadAuthRequest("模型图片未获准")
					}
					mime, payload, ok := splitDataURL(data)
					if !ok {
						return nil, kernel.BadAuthRequest("模型图片需要可读取的图片数据")
					}
					return map[string]any{"type": "base64", "media_type": mime, "data": payload}, nil
				}
			}
			if hydrate {
				if raw, ok := typed["fileData"].(map[string]any); ok {
					if ref, ok := raw["fileUri"].(string); ok && strings.HasPrefix(ref, "resource:") {
						data, ok := references[ref]
						if !ok {
							return nil, kernel.BadAuthRequest("模型图片未获准")
						}
						mime, payload, ok := splitDataURL(data)
						if !ok {
							return nil, kernel.BadAuthRequest("模型图片需要可读取的图片数据")
						}
						delete(typed, "fileData")
						typed["inlineData"] = map[string]any{"mimeType": mime, "data": payload}
					}
				}
			}
			for key, child := range typed {
				next, e := visit(child)
				if e != nil {
					return nil, e
				}
				typed[key] = next
			}
			return typed, nil
		}
		return value, nil
	}
	return visit(root)
}

func splitDataURL(value string) (string, string, bool) {
	if !strings.HasPrefix(value, "data:") {
		return "", "", false
	}
	parts := strings.SplitN(strings.TrimPrefix(value, "data:"), ";base64,", 2)
	if len(parts) != 2 || !strings.HasPrefix(parts[0], "image/") {
		return "", "", false
	}
	return parts[0], parts[1], true
}

func validatePreparedProtocol(taskInputJSON string) error {
	var probe struct {
		ReferenceImages []struct {
			StorageKey string `json:"storageKey"`
			DataURL    string `json:"dataUrl"`
			URL        string `json:"url"`
		} `json:"referenceImages"`
		AgentRequests json.RawMessage `json:"agentRequests"`
	}
	if err := json.Unmarshal([]byte(taskInputJSON), &probe); err != nil {
		return err
	}
	if len(probe.AgentRequests) == 0 || string(probe.AgentRequests) == "null" {
		return nil
	}
	refs := make([]MediaRef, 0, len(probe.ReferenceImages))
	for _, media := range probe.ReferenceImages {
		refs = append(refs, MediaRef{StorageKey: media.StorageKey, DataURL: media.DataURL, URL: media.URL})
	}
	var requests any
	if err := json.Unmarshal(probe.AgentRequests, &requests); err != nil {
		return err
	}
	return ValidateProtocolPlaceholders(refs, requests)
}

func preparedImageCount(taskInputJSON string) int {
	var probe struct {
		ReferenceImages []json.RawMessage `json:"referenceImages"`
	}
	if err := json.Unmarshal([]byte(taskInputJSON), &probe); err != nil {
		return 0
	}
	return len(probe.ReferenceImages)
}
