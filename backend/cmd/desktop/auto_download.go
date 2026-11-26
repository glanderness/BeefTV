package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"infinite-canvas/backend/internal/bootstrap"
	"infinite-canvas/backend/internal/desktopstorage"
)

const (
	autoDownloadConfigFileName     = "auto-download.json"
	defaultAutoDownloadSubdirName  = "BeefTV"
	fallbackAutoDownloadProjectDir = "未命名项目"
	maxAutoDownloadProjectDirBytes = 100
)

type autoDownloadStoredConfig struct {
	CustomDirectory string `json:"customDirectory,omitempty"`
}

type AutoDownloadSettings struct {
	Directory        string `json:"directory"`
	DefaultDirectory string `json:"defaultDirectory"`
	CustomDirectory  string `json:"customDirectory,omitempty"`
	Available        bool   `json:"available"`
	Cancelled        bool   `json:"cancelled,omitempty"`
}

type AutoDownloadSaveResult struct {
	SavedPath string `json:"savedPath"`
	Directory string `json:"directory"`
}

func (a *DesktopApp) AutoDownloadSettings() (AutoDownloadSettings, error) {
	a.autoDownloadMu.Lock()
	defer a.autoDownloadMu.Unlock()
	return a.inspectAutoDownloadSettings()
}

func (a *DesktopApp) ChooseAutoDownloadDirectory() (AutoDownloadSettings, error) {
	ctx, err := a.dialogContext()
	if err != nil {
		return AutoDownloadSettings{}, err
	}
	if !a.migrationMu.TryLock() {
		return AutoDownloadSettings{}, errors.New("存储迁移正在进行，请稍后再更改自动下载目录")
	}
	defer a.migrationMu.Unlock()

	a.autoDownloadMu.Lock()
	defer a.autoDownloadMu.Unlock()

	current, inspectErr := a.inspectAutoDownloadSettings()
	defaultStartDir := ""
	if inspectErr == nil {
		defaultStartDir = current.Directory
	}
	chosen, err := a.promptAutoDownloadDirectory(ctx, defaultStartDir)
	if err != nil {
		return AutoDownloadSettings{}, err
	}
	trimmed := strings.TrimSpace(chosen)
	if trimmed == "" {
		if inspectErr != nil {
			return AutoDownloadSettings{}, inspectErr
		}
		current.Cancelled = true
		return current, nil
	}
	if err := ctx.Err(); err != nil {
		return AutoDownloadSettings{}, errors.New("应用已关闭，无法保存设置")
	}
	cleanDir, err := a.validateAutoDownloadCustomDirectory(trimmed)
	if err != nil {
		return AutoDownloadSettings{}, err
	}
	if err := a.writeAutoDownloadConfig(autoDownloadStoredConfig{CustomDirectory: cleanDir}); err != nil {
		return AutoDownloadSettings{}, err
	}
	return a.inspectAutoDownloadSettings()
}

func (a *DesktopApp) ResetAutoDownloadDirectory() (AutoDownloadSettings, error) {
	if !a.migrationMu.TryLock() {
		return AutoDownloadSettings{}, errors.New("存储迁移正在进行，请稍后再恢复默认目录")
	}
	defer a.migrationMu.Unlock()

	a.autoDownloadMu.Lock()
	defer a.autoDownloadMu.Unlock()

	if err := a.writeAutoDownloadConfig(autoDownloadStoredConfig{}); err != nil {
		return AutoDownloadSettings{}, err
	}
	return a.inspectAutoDownloadSettings()
}

func (a *DesktopApp) OpenAutoDownloadDirectory() error {
	if _, err := a.dialogContext(); err != nil {
		return err
	}
	a.autoDownloadMu.Lock()
	target, err := a.ensureAutoDownloadRootDirectory()
	a.autoDownloadMu.Unlock()
	if err != nil {
		return err
	}
	a.mu.RLock()
	openDir := a.openDirectory
	a.mu.RUnlock()
	return openDirectoryInSystemFileManager(target, openDir, "无法打开自动下载文件夹，请在存储设置中检查当前目录。")
}

// SaveAutoDownloadedMedia streams an owned workspace resource straight into the
// configured auto-download root under a sanitized per-project subdirectory.
// The frontend never supplies an arbitrary filesystem destination path.
func (a *DesktopApp) SaveAutoDownloadedMedia(fileName string, resourceID string, projectName string) (AutoDownloadSaveResult, error) {
	id := strings.TrimSpace(resourceID)
	if id == "" {
		return AutoDownloadSaveResult{}, errors.New("没有可导出的本机文件")
	}

	a.autoDownloadMu.Lock()
	rootDir, err := a.ensureAutoDownloadRootDirectory()
	var projectDir string
	if err == nil {
		projectDir, err = ensureAutoDownloadProjectDirectory(rootDir, projectName)
	}
	a.autoDownloadMu.Unlock()
	if err != nil {
		return AutoDownloadSaveResult{}, err
	}

	sanitized := bootstrap.SanitizeSaveFileName(fileName)
	for suffix := 0; suffix < maxBatchCollisionTries; suffix++ {
		candidate := sanitized
		if suffix > 0 {
			candidate = bootstrap.AppendUniqueSaveFileSuffix(sanitized, suffix)
		}
		dest := filepath.Join(projectDir, candidate)
		if filepath.Dir(dest) != projectDir {
			return AutoDownloadSaveResult{}, errors.New("无法写入自动下载目录")
		}
		writeErr := a.copyMediaExclusive(id, dest)
		if errors.Is(writeErr, os.ErrExist) {
			continue
		}
		if writeErr != nil {
			return AutoDownloadSaveResult{}, writeErr
		}
		return AutoDownloadSaveResult{SavedPath: dest, Directory: projectDir}, nil
	}
	return AutoDownloadSaveResult{}, errors.New("目标文件夹内同名文件过多，请更换自动下载目录")
}

func (a *DesktopApp) inspectAutoDownloadSettings() (AutoDownloadSettings, error) {
	cfg, err := a.readAutoDownloadConfig()
	if err != nil {
		return AutoDownloadSettings{}, err
	}
	baseDownloads := a.targetDownloadsDir()
	defaultDir := ""
	if baseDownloads != "" {
		defaultDir = filepath.Join(filepath.Clean(baseDownloads), defaultAutoDownloadSubdirName)
	}
	customDir := strings.TrimSpace(cfg.CustomDirectory)
	if customDir != "" {
		cleanCustom := filepath.Clean(customDir)
		available := false
		if info, statErr := os.Stat(cleanCustom); statErr == nil && info.IsDir() {
			available = !a.overlapsWorkspaceDataDir(cleanCustom)
		}
		return AutoDownloadSettings{
			Directory:        cleanCustom,
			DefaultDirectory: defaultDir,
			CustomDirectory:  cleanCustom,
			Available:        available,
		}, nil
	}
	available := false
	if baseDownloads != "" {
		if info, statErr := os.Stat(baseDownloads); statErr == nil && info.IsDir() {
			defaultSubdirOK := true
			if subInfo, subErr := os.Lstat(defaultDir); subErr == nil {
				defaultSubdirOK = subInfo.IsDir() && subInfo.Mode()&os.ModeSymlink == 0
			} else if !errors.Is(subErr, os.ErrNotExist) {
				defaultSubdirOK = false
			}
			available = defaultSubdirOK && !a.overlapsWorkspaceDataDir(defaultDir)
		}
	}
	return AutoDownloadSettings{
		Directory:        defaultDir,
		DefaultDirectory: defaultDir,
		Available:        available,
	}, nil
}

func (a *DesktopApp) ensureAutoDownloadRootDirectory() (string, error) {
	cfg, err := a.readAutoDownloadConfig()
	if err != nil {
		return "", err
	}
	customDir := strings.TrimSpace(cfg.CustomDirectory)
	if customDir != "" {
		cleanCustom := filepath.Clean(customDir)
		if !filepath.IsAbs(cleanCustom) {
			return "", errors.New("自动下载目录无效，请在存储设置中重新选择")
		}
		info, statErr := os.Lstat(cleanCustom)
		if statErr != nil {
			return "", errors.New("自动下载目录当前不可用，请检查磁盘连接或在存储设置中重新选择")
		}
		if info.Mode()&os.ModeSymlink != 0 {
			resolved, evalErr := os.Stat(cleanCustom)
			if evalErr != nil || !resolved.IsDir() {
				return "", errors.New("自动下载目录当前不可用，请检查磁盘连接或在存储设置中重新选择")
			}
		} else if !info.IsDir() {
			return "", errors.New("自动下载目录当前不可用，请在存储设置中重新选择文件夹")
		}
		if a.overlapsWorkspaceDataDir(cleanCustom) {
			return "", errors.New("自动下载目录不能与工作区数据目录重叠，请在存储设置中重新选择")
		}
		return cleanCustom, nil
	}

	baseDownloads := strings.TrimSpace(a.targetDownloadsDir())
	if baseDownloads == "" {
		return "", errors.New("未找到系统默认下载目录，请在存储设置中手动指定自动下载目录")
	}
	cleanBase := filepath.Clean(baseDownloads)
	baseInfo, err := os.Stat(cleanBase)
	if err != nil || !baseInfo.IsDir() {
		return "", errors.New("系统默认下载目录不可用，请在存储设置中手动指定自动下载目录")
	}
	defaultDir := filepath.Join(cleanBase, defaultAutoDownloadSubdirName)
	if a.overlapsWorkspaceDataDir(defaultDir) {
		return "", errors.New("默认自动下载目录与工作区数据目录重叠，请在存储设置中重新选择")
	}
	if err := ensureSingleSafeSubdir(cleanBase, defaultDir); err != nil {
		return "", err
	}
	return defaultDir, nil
}

func ensureAutoDownloadProjectDirectory(rootDir string, projectName string) (string, error) {
	folder := sanitizeAutoDownloadProjectFolder(projectName)
	projectDir := filepath.Join(rootDir, folder)
	if filepath.Dir(projectDir) != rootDir {
		return "", errors.New("无法创建项目素材文件夹")
	}
	if err := ensureSingleSafeSubdir(rootDir, projectDir); err != nil {
		return "", err
	}
	return projectDir, nil
}

func ensureSingleSafeSubdir(parentDir string, childDir string) error {
	if filepath.Dir(childDir) != parentDir {
		return errors.New("无法创建目标文件夹")
	}
	info, err := os.Lstat(childDir)
	if err == nil {
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return errors.New("目标路径已存在非文件夹项目，无法保存自动下载文件")
		}
		return nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return errors.New("无法访问自动下载目标文件夹")
	}
	if mkErr := os.Mkdir(childDir, 0o755); mkErr != nil {
		if errors.Is(mkErr, os.ErrExist) {
			recheck, statErr := os.Lstat(childDir)
			if statErr == nil && recheck.IsDir() && recheck.Mode()&os.ModeSymlink == 0 {
				return nil
			}
		}
		return errors.New("无法创建自动下载目标文件夹")
	}
	return nil
}

func sanitizeAutoDownloadProjectFolder(projectName string) string {
	raw := strings.TrimSpace(strings.ReplaceAll(projectName, "\x00", ""))
	if raw == "" {
		return fallbackAutoDownloadProjectDir
	}
	var builder strings.Builder
	for _, r := range raw {
		if r < 32 || strings.ContainsRune(`\/:*?"<>|`, r) {
			builder.WriteByte('_')
			continue
		}
		builder.WriteRune(r)
	}
	cleaned := strings.Trim(builder.String(), " .")
	if cleaned == "" || cleaned == "." || cleaned == ".." {
		return fallbackAutoDownloadProjectDir
	}
	cleaned = truncateFolderUTF8Bytes(cleaned, maxAutoDownloadProjectDirBytes)
	cleaned = strings.Trim(cleaned, " .")
	if cleaned == "" || cleaned == "." || cleaned == ".." {
		return fallbackAutoDownloadProjectDir
	}
	// Delegate Windows reserved device name filtering to the shared sanitizer.
	sanitized := bootstrap.SanitizeSaveFileNameWithFallbackStem(cleaned, fallbackAutoDownloadProjectDir)
	if sanitized == "" || sanitized == "." || sanitized == ".." {
		return fallbackAutoDownloadProjectDir
	}
	return sanitized
}

func truncateFolderUTF8Bytes(value string, maxBytes int) string {
	if maxBytes <= 0 || len(value) <= maxBytes {
		return value
	}
	for maxBytes > 0 && !utf8.RuneStart(value[maxBytes]) {
		maxBytes--
	}
	return value[:maxBytes]
}

func (a *DesktopApp) promptAutoDownloadDirectory(ctx context.Context, currentDir string) (string, error) {
	a.mu.RLock()
	choose := a.chooseAutoDownloadDir
	a.mu.RUnlock()
	if choose != nil {
		return choose(ctx)
	}
	options := wailsruntime.OpenDialogOptions{
		Title:                "选择自动下载保存文件夹",
		CanCreateDirectories: true,
	}
	if currentDir != "" {
		if info, err := os.Stat(currentDir); err == nil && info.IsDir() {
			options.DefaultDirectory = currentDir
		} else if parent := filepath.Dir(currentDir); parent != "" {
			if pInfo, pErr := os.Stat(parent); pErr == nil && pInfo.IsDir() {
				options.DefaultDirectory = parent
			}
		}
	}
	if options.DefaultDirectory == "" {
		if downloadsDir := a.targetDownloadsDir(); downloadsDir != "" {
			options.DefaultDirectory = downloadsDir
		}
	}
	return wailsruntime.OpenDirectoryDialog(ctx, options)
}

func (a *DesktopApp) validateAutoDownloadCustomDirectory(rawPath string) (string, error) {
	cleanDir := filepath.Clean(strings.TrimSpace(rawPath))
	if cleanDir == "" || cleanDir == "." || !filepath.IsAbs(cleanDir) {
		return "", errors.New("请选择有效的文件夹路径")
	}
	if filepath.Dir(cleanDir) == cleanDir {
		return "", errors.New("不能直接使用磁盘根目录，请在其下新建或选择一个子文件夹")
	}
	info, err := os.Stat(cleanDir)
	if err != nil || !info.IsDir() {
		return "", errors.New("所选保存文件夹不可用")
	}
	if a.overlapsWorkspaceDataDir(cleanDir) {
		return "", errors.New("自动下载目录不能与工作区数据目录重叠，请选择其他文件夹")
	}
	return cleanDir, nil
}

func (a *DesktopApp) overlapsWorkspaceDataDir(target string) bool {
	a.mu.RLock()
	dataDir := strings.TrimSpace(a.dataDir)
	a.mu.RUnlock()
	if dataDir == "" {
		return false
	}
	overlaps, err := desktopstorage.Overlaps(dataDir, target)
	return err != nil || overlaps
}

func (a *DesktopApp) autoDownloadConfigPath() (string, error) {
	a.mu.RLock()
	dataDir := strings.TrimSpace(a.dataDir)
	a.mu.RUnlock()
	if dataDir == "" {
		return "", errors.New("工作区目录尚未就绪")
	}
	return filepath.Join(filepath.Clean(dataDir), autoDownloadConfigFileName), nil
}

func (a *DesktopApp) readAutoDownloadConfig() (autoDownloadStoredConfig, error) {
	path, err := a.autoDownloadConfigPath()
	if err != nil {
		return autoDownloadStoredConfig{}, err
	}
	body, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return autoDownloadStoredConfig{}, nil
	}
	if err != nil {
		return autoDownloadStoredConfig{}, errors.New("无法读取自动下载目录设置")
	}
	var cfg autoDownloadStoredConfig
	if err := json.Unmarshal(body, &cfg); err != nil {
		return autoDownloadStoredConfig{}, errors.New("自动下载目录设置文件已损坏，请重新选择或恢复默认")
	}
	return cfg, nil
}

func (a *DesktopApp) writeAutoDownloadConfig(cfg autoDownloadStoredConfig) error {
	path, err := a.autoDownloadConfigPath()
	if err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return errors.New("无法保存自动下载目录设置")
	}
	if strings.TrimSpace(cfg.CustomDirectory) == "" {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return errors.New("无法恢复默认自动下载目录")
		}
		return nil
	}
	encoded, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return errors.New("无法编码自动下载目录设置")
	}
	tmp, err := os.CreateTemp(dir, ".auto-download-cfg-*")
	if err != nil {
		return errors.New("无法保存自动下载目录设置")
	}
	tmpPath := tmp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = tmp.Close()
			_ = os.Remove(tmpPath)
		}
	}()
	if _, err := tmp.Write(encoded); err != nil {
		return errors.New("无法写入自动下载目录设置")
	}
	if err := tmp.Chmod(0o600); err != nil {
		// Best-effort on filesystems that ignore POSIX modes.
	}
	if err := tmp.Sync(); err != nil {
		return errors.New("无法写入自动下载目录设置")
	}
	if err := tmp.Close(); err != nil {
		return errors.New("无法写入自动下载目录设置")
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return errors.New("无法更新自动下载目录设置")
	}
	cleanup = false
	return nil
}
