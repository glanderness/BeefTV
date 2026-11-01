package app

import "infinite-canvas/backend/internal/generation"

func EnsureChatCompletionStreamUsageRequest(data []byte) ([]byte, error) {
	return generation.EnsureChatCompletionStreamUsageRequest(data)
}
