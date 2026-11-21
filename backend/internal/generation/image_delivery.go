package generation

import (
	"fmt"
	"net/http"
	"strings"
)

// ValidateImageArtifact rejects error documents returned with a successful HTTP
// status, regardless of whether bytes arrived during generation or later delivery.
func ValidateImageArtifact(data []byte, mimeType string) error {
	detected := strings.ToLower(strings.TrimSpace(strings.Split(http.DetectContentType(data), ";")[0]))
	mimeType = strings.ToLower(NormalizedMediaMIMEType(mimeType, data))
	if len(data) == 0 || strings.Contains(detected, "json") || strings.HasPrefix(detected, "text/") || !strings.HasPrefix(mimeType, "image/") {
		return fmt.Errorf("图片结果无效：%s", defaultString(detected, mimeType))
	}
	return nil
}
