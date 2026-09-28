package depthruntime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

type Artifact struct {
	URLs         []string `json:"urls"`
	Size         int64    `json:"size"`
	SHA256       string   `json:"sha256"`
	Files        int      `json:"files,omitempty"`
	ExpandedSize int64    `json:"expandedSize,omitempty"`
}

type Progress struct {
	Downloaded int64
	Total      int64
	Source     string
}

func Download(ctx context.Context, artifact Artifact, target string, report func(Progress)) error {
	if len(artifact.URLs) == 0 || artifact.Size <= 0 || len(strings.TrimSpace(artifact.SHA256)) != 64 {
		return errors.New("深度组件下载描述无效")
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o750); err != nil {
		return err
	}
	temporary := target + ".download"
	var lastErr error
	for _, source := range artifact.URLs {
		for attempt := 0; attempt < 3; attempt++ {
			if err := downloadSource(ctx, source, temporary, artifact.Size, report); err != nil {
				lastErr = err
				continue
			}
			if err := verifyFile(temporary, artifact); err != nil {
				lastErr = err
				if info, statErr := os.Stat(temporary); statErr == nil && info.Size() < artifact.Size {
					continue
				}
				_ = os.Rename(temporary, target+".corrupt")
				break
			}
			if err := os.Rename(temporary, target); err != nil {
				return fmt.Errorf("发布深度组件失败: %w", err)
			}
			return nil
		}
	}
	return fmt.Errorf("深度组件下载失败: %w", lastErr)
}

func downloadSource(ctx context.Context, source string, temporary string, total int64, report func(Progress)) error {
	var offset int64
	if info, err := os.Stat(temporary); err == nil {
		offset = info.Size()
		if offset > total {
			offset = 0
		}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, source, nil)
	if err != nil {
		return err
	}
	if offset > 0 {
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-", offset))
	}
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK && response.StatusCode != http.StatusPartialContent {
		return fmt.Errorf("下载源返回 HTTP %d", response.StatusCode)
	}
	flags := os.O_CREATE | os.O_WRONLY
	if response.StatusCode == http.StatusPartialContent && offset > 0 {
		flags |= os.O_APPEND
	} else {
		offset = 0
		flags |= os.O_TRUNC
	}
	file, err := os.OpenFile(temporary, flags, 0o640)
	if err != nil {
		return err
	}
	defer file.Close()
	written := offset
	buffer := make([]byte, 256*1024)
	for {
		count, readErr := response.Body.Read(buffer)
		if count > 0 {
			if _, err := file.Write(buffer[:count]); err != nil {
				return err
			}
			written += int64(count)
			if report != nil {
				report(Progress{Downloaded: written, Total: total, Source: source})
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return readErr
		}
	}
	return file.Sync()
}

func verifyFile(path string, artifact Artifact) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if info.Size() != artifact.Size {
		return fmt.Errorf("下载大小不匹配: got %d want %d", info.Size(), artifact.Size)
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return err
	}
	if !strings.EqualFold(hex.EncodeToString(hash.Sum(nil)), artifact.SHA256) {
		return errors.New("SHA-256 校验失败")
	}
	return nil
}
