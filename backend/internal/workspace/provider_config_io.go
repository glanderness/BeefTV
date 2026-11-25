package workspace

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"infinite-canvas/backend/internal/localcrypto"
)

const (
	corruptPrimaryPrefix = LocalProviderConfigFile + ".corrupt."
	maxCorruptPrimaries  = 3
	maxReplaceRetries    = 5
)

var (
	renameConfigFile              = os.Rename
	isRetryableConfigReplaceError = retryableConfigReplaceError
	isConfigFileInUse             = configFileInUse
	isConfigPermissionError       = configPermissionError
	sleepConfigRetry              = time.Sleep
	nowConfigUTC                  = func() time.Time { return time.Now().UTC() }
)

// Caller holds s.mu; encryption-only migration preserves the CAS revision.
func (s *ProviderConfig) writeDocument(document ProviderStateDocument) error {
	canonical, err := s.encodeStoredDocument(document)
	if err != nil {
		return fmt.Errorf("编码本地模型配置失败: %w", err)
	}
	if err := os.MkdirAll(s.dataDir, 0o700); err != nil {
		return wrapConfigIOError("创建本地配置目录失败", err)
	}
	if err := os.Chmod(s.dataDir, 0o700); err != nil {
		return wrapConfigIOError("设置本地配置目录权限失败", err)
	}
	tmpName, err := writeTempConfigFile(s.dataDir, ".local-model-config-*", canonical)
	if err != nil {
		return err
	}
	defer os.Remove(tmpName)
	if err := s.rotateBackup(); err != nil {
		return err
	}
	if err := replaceConfigFile(tmpName, s.path()); err != nil {
		return wrapConfigIOError("替换本地模型配置失败", err)
	}
	if err := os.Chmod(s.path(), 0o600); err != nil {
		return wrapConfigIOError("设置本地配置权限失败", err)
	}
	if directory, err := os.Open(s.dataDir); err == nil {
		_ = directory.Sync()
		_ = directory.Close()
	}
	return nil
}

func (s *ProviderConfig) rotateBackup() error {
	source, err := os.ReadFile(s.path())
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return wrapConfigIOError("读取旧模型配置失败", err)
	}
	document, _, err := s.decodeStoredDocument(source)
	if err != nil {
		if isNonCorruptPrimaryDecodeError(err) {
			return err
		}
		// 主文件已损坏：不要用坏内容覆盖有效备份，先隔离原文件留证再由新写入恢复主文件。
		return s.quarantineCorruptPrimary(source)
	}
	canonical, err := s.encodeStoredDocument(document)
	if err != nil {
		return err
	}
	tmpName, err := writeTempConfigFile(s.dataDir, ".local-model-config-backup-*", canonical)
	if err != nil {
		return err
	}
	defer os.Remove(tmpName)
	if err := replaceConfigFile(tmpName, s.backupPath()); err != nil {
		return wrapConfigIOError("替换模型配置备份失败", err)
	}
	return nil
}

func (s *ProviderConfig) quarantineCorruptPrimary(source []byte) error {
	tmpName, err := writeTempConfigFile(s.dataDir, ".local-model-config-corrupt-*", source)
	if err != nil {
		return err
	}
	defer os.Remove(tmpName)
	target := s.nextCorruptPrimaryPath()
	if err := replaceConfigFile(tmpName, target); err != nil {
		return wrapConfigIOError("隔离损坏的本地模型配置失败", err)
	}
	_ = os.Chmod(target, 0o600)
	s.pruneCorruptPrimaries()
	return nil
}

func (s *ProviderConfig) nextCorruptPrimaryPath() string {
	stamp := nowConfigUTC().Format("20060102-150405.000000000")
	base := filepath.Join(s.dataDir, corruptPrimaryPrefix+stamp)
	if _, err := os.Stat(base); errors.Is(err, os.ErrNotExist) {
		return base
	}
	for index := 1; index < 1000; index++ {
		candidate := fmt.Sprintf("%s-%03d", base, index)
		if _, err := os.Stat(candidate); errors.Is(err, os.ErrNotExist) {
			return candidate
		}
	}
	return fmt.Sprintf("%s-%d", base, time.Now().UnixNano())
}

func (s *ProviderConfig) pruneCorruptPrimaries() {
	entries, err := os.ReadDir(s.dataDir)
	if err != nil {
		return
	}
	var names []string
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasPrefix(entry.Name(), corruptPrimaryPrefix) {
			names = append(names, entry.Name())
		}
	}
	if len(names) <= maxCorruptPrimaries {
		return
	}
	sort.Strings(names)
	for _, stale := range names[:len(names)-maxCorruptPrimaries] {
		_ = os.Remove(filepath.Join(s.dataDir, stale))
	}
}

func writeTempConfigFile(dir, pattern string, content []byte) (string, error) {
	tmp, err := os.CreateTemp(dir, pattern)
	if err != nil {
		return "", wrapConfigIOError("创建本地配置临时文件失败", err)
	}
	tmpName := tmp.Name()
	cleanup := func() {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
	}
	if err := tmp.Chmod(0o600); err != nil {
		cleanup()
		return "", wrapConfigIOError("设置本地配置权限失败", err)
	}
	if _, err := tmp.Write(content); err != nil {
		cleanup()
		return "", wrapConfigIOError("写入本地模型配置失败", err)
	}
	if err := tmp.Sync(); err != nil {
		cleanup()
		return "", wrapConfigIOError("同步本地模型配置失败", err)
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		return "", wrapConfigIOError("关闭本地模型配置失败", err)
	}
	return tmpName, nil
}

func replaceConfigFile(tempPath, targetPath string) error {
	_ = os.Chmod(targetPath, 0o600)
	for attempt := 0; ; attempt++ {
		err := renameConfigFile(tempPath, targetPath)
		if err == nil {
			return nil
		}
		if !isRetryableConfigReplaceError(err) {
			return err
		}
		if attempt >= maxReplaceRetries {
			// Windows 上目标文件被占用时 os.Rename 可能持续返回 ERROR_ACCESS_DENIED；
			// 仅对经过重试仍失败的 rename 路径归类为可重试占用，避免误报成目录权限错误。
			return fmt.Errorf("%w: %w", ErrProviderConfigLocked, err)
		}
		_ = os.Chmod(targetPath, 0o600)
		sleepConfigRetry(time.Duration(attempt+1) * 40 * time.Millisecond)
	}
}

func wrapConfigIOError(prefix string, err error) error {
	if err == nil {
		return nil
	}
	switch {
	case errors.Is(err, ErrProviderConfigLocked):
		return fmt.Errorf("%s: %w", prefix, err)
	case isConfigFileInUse(err):
		return fmt.Errorf("%s: %w: %w", prefix, ErrProviderConfigLocked, err)
	case errors.Is(err, ErrProviderConfigPermission):
		return fmt.Errorf("%s: %w", prefix, err)
	case isConfigPermissionError(err):
		return fmt.Errorf("%s: %w: %w", prefix, ErrProviderConfigPermission, err)
	default:
		return fmt.Errorf("%s: %w", prefix, err)
	}
}

func wrapConfigKeyError(prefix string, err error) error {
	if err == nil {
		return nil
	}
	switch {
	case errors.Is(err, ErrProviderConfigLocked):
		return fmt.Errorf("%s: %w", prefix, err)
	case isConfigFileInUse(err):
		return fmt.Errorf("%s: %w: %w", prefix, ErrProviderConfigLocked, err)
	case errors.Is(err, ErrProviderConfigPermission):
		return fmt.Errorf("%s: %w", prefix, err)
	case isConfigPermissionError(err):
		return fmt.Errorf("%s: %w: %w", prefix, ErrProviderConfigPermission, err)
	case errors.Is(err, ErrProviderConfigKeyUnavailable):
		return fmt.Errorf("%s: %w", prefix, err)
	default:
		return fmt.Errorf("%s: %w: %w", prefix, ErrProviderConfigKeyUnavailable, err)
	}
}

func isNonCorruptBackupDecodeError(err error) bool {
	return errors.Is(err, ErrProviderConfigKeyUnavailable) ||
		errors.Is(err, ErrProviderConfigLocked) ||
		errors.Is(err, ErrProviderConfigPermission)
}

func isNonCorruptPrimaryDecodeError(err error) bool {
	return errors.Is(err, ErrProviderConfigLocked) ||
		errors.Is(err, ErrProviderConfigPermission) ||
		(errors.Is(err, ErrProviderConfigKeyUnavailable) && !errors.Is(err, localcrypto.ErrDecryptFailed))
}

func wrapCorruptConfigError(prefix string, err error) error {
	if err == nil {
		return fmt.Errorf("%s: %w", prefix, ErrMalformedProviderConfig)
	}
	if errors.Is(err, ErrProviderConfigKeyUnavailable) || errors.Is(err, ErrMalformedProviderConfig) {
		return fmt.Errorf("%s: %w", prefix, err)
	}
	return fmt.Errorf("%s: %w: %w", prefix, ErrMalformedProviderConfig, err)
}
