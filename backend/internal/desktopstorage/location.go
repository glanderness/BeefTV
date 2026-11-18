package desktopstorage

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const locationFile = "storage-location.json"

var (
	ErrLocationRollbackFailed = errors.New("回滚存储目录设置指针失败")
	syncLocationDir           = syncDirectory
)

type Location struct {
	DataDir       string            `json:"dataDir"`
	PreviousDir   string            `json:"previousDir,omitempty"`
	PreviousFiles map[string]string `json:"previousFiles,omitempty"`
}

func DefaultRoot() (string, error) {
	root, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Clean(filepath.Join(root, "BeefTV")), nil
}

// The pointer stays in the system profile, independent of the selected data volume.
// A missing selected volume must never silently create an empty workspace.
func Resolve(root string) (string, error) {
	root = filepath.Clean(strings.TrimSpace(root))
	if root == "" || root == "." || !filepath.IsAbs(root) {
		return "", errors.New("存储目录设置无效")
	}
	body, err := readLocationFile(filepath.Join(root, locationFile))
	if errors.Is(err, os.ErrNotExist) {
		return root, nil
	}
	if err != nil {
		return "", fmt.Errorf("读取存储目录设置失败: %w", err)
	}
	var location Location
	if err := json.Unmarshal(bytes.TrimPrefix(body, []byte("\xef\xbb\xbf")), &location); err != nil {
		return "", fmt.Errorf("存储目录设置损坏: %w", err)
	}
	dataDir := filepath.Clean(strings.TrimSpace(location.DataDir))
	if dataDir == "" || dataDir == "." || !filepath.IsAbs(dataDir) || filepath.Dir(dataDir) == dataDir {
		return "", errors.New("存储目录设置无效")
	}
	if info, err := os.Stat(dataDir); err != nil || !info.IsDir() {
		return "", fmt.Errorf("存储目录无法访问，请连接对应磁盘后重试：%s", dataDir)
	}
	return dataDir, nil
}

func SameLocation(left, right string) bool {
	left = filepath.Clean(strings.TrimSpace(left))
	right = filepath.Clean(strings.TrimSpace(right))
	if left == "" || right == "" || left == "." || right == "." {
		return false
	}
	if pathsEqual(left, right) {
		return true
	}
	cLeft, err1 := canonical(left)
	cRight, err2 := canonical(right)
	return err1 == nil && err2 == nil && pathsEqual(cLeft, cRight)
}

func pathsEqual(left, right string) bool {
	if runtime.GOOS == "windows" {
		return strings.EqualFold(left, right)
	}
	return left == right
}

func Save(root, dataDir, previousDir string) error {
	return saveLocation(root, Location{DataDir: dataDir, PreviousDir: previousDir})
}

func SaveMigration(root, dataDir, previousDir string, files map[string]string) error {
	return saveLocation(root, Location{DataDir: dataDir, PreviousDir: previousDir, PreviousFiles: files})
}

func saveLocation(root string, location Location) error {
	root = filepath.Clean(strings.TrimSpace(root))
	location.DataDir = filepath.Clean(strings.TrimSpace(location.DataDir))
	if strings.TrimSpace(location.PreviousDir) != "" {
		location.PreviousDir = filepath.Clean(strings.TrimSpace(location.PreviousDir))
	} else {
		location.PreviousDir = ""
	}
	if root == "" || root == "." || !filepath.IsAbs(root) || location.DataDir == "" || location.DataDir == "." || !filepath.IsAbs(location.DataDir) || filepath.Dir(location.DataDir) == location.DataDir {
		return errors.New("存储目录设置无效")
	}
	if info, err := os.Stat(location.DataDir); err != nil || !info.IsDir() {
		return fmt.Errorf("存储目录无法访问，请连接对应磁盘后重试：%s", location.DataDir)
	}
	body, err := json.Marshal(location)
	if err != nil {
		return err
	}
	var decodedCheck Location
	if err := json.Unmarshal(body, &decodedCheck); err != nil || !SameLocation(decodedCheck.DataDir, location.DataDir) {
		return errors.New("存储目录设置校验失败")
	}
	if err := os.MkdirAll(root, 0700); err != nil {
		return err
	}
	targetPath := filepath.Join(root, locationFile)
	prevBytes, prevErr := readLocationFile(targetPath)
	hadPrev := prevErr == nil
	if prevErr != nil && !errors.Is(prevErr, os.ErrNotExist) {
		return fmt.Errorf("读取既有存储目录设置失败: %w", prevErr)
	}
	rollback := func() error {
		if !hadPrev {
			if rmErr := os.Remove(targetPath); rmErr != nil && !errors.Is(rmErr, os.ErrNotExist) {
				return rmErr
			}
			return nil
		}
		tmp, createErr := os.CreateTemp(root, ".storage-location-rollback-*")
		if createErr != nil {
			return createErr
		}
		tmpPath := tmp.Name()
		_, writeErr := tmp.Write(prevBytes)
		syncErr := tmp.Sync()
		closeErr := tmp.Close()
		if writeErr != nil || syncErr != nil || closeErr != nil {
			_ = os.Remove(tmpPath)
			return errors.Join(writeErr, syncErr, closeErr)
		}
		if repErr := replaceLocationFile(tmpPath, targetPath); repErr != nil {
			_ = os.Remove(tmpPath)
			return repErr
		}
		return syncLocationDir(root)
	}
	withRollback := func(cause error) error {
		if rbErr := rollback(); rbErr != nil {
			return fmt.Errorf("%w (%w: %v)", cause, ErrLocationRollbackFailed, rbErr)
		}
		return cause
	}
	file, err := os.CreateTemp(root, ".storage-location-*")
	if err != nil {
		return err
	}
	path := file.Name()
	defer os.Remove(path)
	if err = file.Chmod(0600); err == nil {
		_, err = file.Write(body)
	}
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err := replaceLocationFile(path, targetPath); err != nil {
		return err
	}
	if err := syncLocationDir(root); err != nil {
		return withRollback(err)
	}
	resolved, err := Resolve(root)
	if err != nil {
		return withRollback(fmt.Errorf("校验存储目录设置失败: %w", err))
	}
	if !SameLocation(resolved, location.DataDir) {
		return withRollback(fmt.Errorf("存储目录设置读回不一致: 读回 %s，期望 %s", resolved, location.DataDir))
	}
	return nil
}

func replaceLocationFile(tempPath, targetPath string) error {
	_ = os.Chmod(targetPath, 0600)
	for attempt := 0; ; attempt++ {
		err := os.Rename(tempPath, targetPath)
		if err == nil {
			return nil
		}
		if !retryableReplaceError(err) || attempt >= 5 {
			return err
		}
		_ = os.Chmod(targetPath, 0600)
		time.Sleep(time.Duration(attempt+1) * 40 * time.Millisecond)
	}
}

func canonical(path string) (string, error) {
	path = strings.TrimSpace(path)
	if !filepath.IsAbs(path) || filepath.Dir(filepath.Clean(path)) == filepath.Clean(path) {
		return "", errors.New("请选择磁盘中的文件夹，例如 D:\\BeefTV")
	}
	path = filepath.Clean(path)
	missing := []string{}
	for {
		resolved, err := filepath.EvalSymlinks(path)
		if err == nil {
			for i := len(missing) - 1; i >= 0; i-- {
				resolved = filepath.Join(resolved, missing[i])
			}
			return resolved, nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
		parent := filepath.Dir(path)
		if parent == path {
			return "", err
		}
		missing = append(missing, filepath.Base(path))
		path = parent
	}
}

func contains(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}
