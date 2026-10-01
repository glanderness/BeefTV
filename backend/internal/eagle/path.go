package eagle

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

func originalPath(thumbnailPath string, itemID string, libraryPath string) (string, error) {
	thumbnailPath = filepath.Clean(filepath.FromSlash(thumbnailPath))
	libraryPath = filepath.Clean(filepath.FromSlash(libraryPath))
	if libraryPath == "." || !filepath.IsAbs(libraryPath) {
		return "", errors.New("Eagle 素材库路径无效，无法安全读取原文件")
	}
	itemDir := filepath.Join(libraryPath, "images", itemID+".info")
	rel, err := filepath.Rel(itemDir, thumbnailPath)
	if err != nil || rel == "." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || rel == ".." {
		return "", errors.New("Eagle 素材路径不在当前素材库内")
	}
	base := filepath.Base(thumbnailPath)
	stem := strings.TrimSuffix(base, filepath.Ext(base))
	stem = strings.TrimSuffix(stem, "_thumbnail")
	if ext := filepath.Ext(base); ext != "" {
		candidate := filepath.Join(itemDir, stem+ext)
		if stat, statErr := os.Stat(candidate); statErr == nil && !stat.IsDir() {
			return candidate, nil
		}
	}
	entries, err := os.ReadDir(itemDir)
	if err != nil {
		return "", errors.New("Eagle 原文件目录不存在")
	}
	candidates := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || strings.EqualFold(entry.Name(), "metadata.json") || strings.Contains(strings.ToLower(entry.Name()), "_thumbnail") {
			continue
		}
		candidates = append(candidates, filepath.Join(itemDir, entry.Name()))
	}
	if len(candidates) == 0 {
		return "", errors.New("Eagle 原始文件不存在")
	}
	sort.Strings(candidates)
	return candidates[0], nil
}

func thumbnailInsideLibrary(thumbnailPath string, itemID string, libraryPath string) (string, error) {
	thumbnailPath = filepath.Clean(filepath.FromSlash(thumbnailPath))
	itemDir := filepath.Join(filepath.Clean(filepath.FromSlash(libraryPath)), "images", itemID+".info")
	rel, err := filepath.Rel(itemDir, thumbnailPath)
	if err != nil || rel == "." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || rel == ".." {
		return "", errors.New("Eagle 缩略图路径不在当前素材库内")
	}
	return thumbnailPath, nil
}
