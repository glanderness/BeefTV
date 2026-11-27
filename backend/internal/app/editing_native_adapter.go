package app

import (
	"context"
	"fmt"
	"io"

	"infinite-canvas/backend/internal/editing"
)

func (s *Service) nativeRenderer(userID string) *editing.Renderer {
	return &editing.Renderer{Sources: editing.NewMIMEOpener(func(_ context.Context, sourceID string) (io.ReadCloser, string, error) {
		if s == nil {
			return nil, "", fmt.Errorf("无法读取时间线引用的媒体，可能已被删除")
		}
		res, reader, err := s.OpenResource(userID, sourceID)
		if err != nil || reader == nil {
			return nil, "", fmt.Errorf("无法读取时间线引用的媒体，可能已被删除")
		}
		if res == nil {
			return reader, "", nil
		}
		return reader, res.MimeType, nil
	})}
}
