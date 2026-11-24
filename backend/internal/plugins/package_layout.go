package plugins

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"infinite-canvas/backend/internal/protocol"
)

// promoteStagedPackageRoot 把 npm install --prefix 安装在 stageDir/node_modules/<name>
// 下的插件包内容提升到新的干净根目录，并保留其余运行时依赖到 <root>/node_modules/。
// 如果 stagedRoot 已经是 stageDir 本身，则原样返回。
func promoteStagedPackageRoot(stageDir, stagedRoot string) (string, error) {
	relRoot, err := filepath.Rel(stageDir, stagedRoot)
	if err != nil {
		return "", err
	}
	cleanRel := filepath.Clean(relRoot)
	if cleanRel == "." {
		return stageDir, nil
	}
	if strings.HasPrefix(cleanRel, "..") || filepath.IsAbs(cleanRel) {
		return "", fmt.Errorf("插件暂存目录路径非法：%s", relRoot)
	}

	promotedDir := filepath.Join(stageDir, ".promoted-root")
	_ = os.RemoveAll(promotedDir)
	if err := os.Rename(stagedRoot, promotedDir); err != nil {
		return "", fmt.Errorf("提升插件包根目录失败：%w", err)
	}

	// 若原包是 scoped 包（node_modules/@scope/pkg），尝试移除变空的 @scope 目录。
	hoistedNM := filepath.Join(stageDir, "node_modules")
	parent := filepath.Dir(stagedRoot)
	for parent != stageDir && parent != hoistedNM && strings.HasPrefix(parent, hoistedNM+string(os.PathSeparator)) {
		_ = os.Remove(parent)
		parent = filepath.Dir(parent)
	}

	if info, err := os.Stat(hoistedNM); err == nil && info.IsDir() {
		if err := mergeHoistedNodeModules(hoistedNM, filepath.Join(promotedDir, "node_modules")); err != nil {
			return "", fmt.Errorf("迁移插件运行时依赖失败：%w", err)
		}
	}
	return promotedDir, nil
}

// mergeHoistedNodeModules 将提升在暂存区顶层的依赖搬入插件根目录的 node_modules。
// 包内自带的嵌套依赖优先保留，不覆盖同名依赖。
func mergeHoistedNodeModules(srcNM, dstNM string) error {
	entries, err := os.ReadDir(srcNM)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		name := entry.Name()
		if name == ".package-lock.json" {
			continue
		}
		srcPath := filepath.Join(srcNM, name)
		dstPath := filepath.Join(dstNM, name)
		if strings.HasPrefix(name, "@") && entry.IsDir() {
			if err := mergeHoistedNodeModules(srcPath, dstPath); err != nil {
				return err
			}
			continue
		}
		if _, err := os.Lstat(dstPath); err == nil {
			continue
		} else if !os.IsNotExist(err) {
			return err
		}
		if err := os.MkdirAll(dstNM, 0o755); err != nil {
			return err
		}
		if err := os.Rename(srcPath, dstPath); err != nil {
			return err
		}
	}
	return nil
}

// migrateNestedPackageDir upgrades legacy npm-prefix plugin installs whose stored
// PackageDir points inside `<dataDir>/plugins/<expectedID>/node_modules/<pkg>`
// to live directly at `<dataDir>/plugins/<expectedID>`, self-healing crash windows
// and rolling back cleanly on any filesystem or manifest validation error.
func migrateNestedPackageDir(dataDir, expectedID, packageDir string) (string, bool, error) {
	dataDir = filepath.Clean(strings.TrimSpace(dataDir))
	expectedID = strings.TrimSpace(expectedID)
	cleaned := filepath.Clean(strings.TrimSpace(packageDir))
	if dataDir == "" || dataDir == "." || expectedID == "" || cleaned == "" || cleaned == "." {
		return packageDir, false, nil
	}
	if expectedID == "." || expectedID == ".." || strings.HasPrefix(expectedID, ".") || filepath.Base(expectedID) != expectedID || strings.ContainsAny(expectedID, `/\`) {
		return packageDir, false, nil
	}
	pluginsRoot := filepath.Join(dataDir, "plugins")
	expectedRoot := filepath.Join(pluginsRoot, expectedID)
	if relRoot, err := filepath.Rel(pluginsRoot, expectedRoot); err != nil || relRoot != expectedID || strings.HasPrefix(relRoot, "..") {
		return packageDir, false, nil
	}
	nestedBase := filepath.Join(expectedRoot, "node_modules")
	relUnderNM, err := filepath.Rel(nestedBase, cleaned)
	if err != nil || relUnderNM == "." || relUnderNM == ".." || strings.HasPrefix(relUnderNM, ".."+string(os.PathSeparator)) {
		return packageDir, false, nil
	}

	// Leading-dot namespace cannot collide with any valid plugin ID.
	backupDir := filepath.Join(pluginsRoot, ".migrating-layout-"+expectedID)
	stagedNested := filepath.Join(backupDir, "node_modules", relUnderNM)
	promotedDir := filepath.Join(backupDir, ".promoted-root")

	// Crash-window self-heal #1: files were already promoted to expectedRoot, only the stored
	// registry record still points to the legacy nested node_modules/<pkg> path.
	if pkg, err := protocol.ParsePluginPackageDir(expectedRoot); err == nil && pkg.Manifest.Metadata.ID == expectedID {
		_ = os.RemoveAll(backupDir)
		return expectedRoot, true, nil
	}

	// Crash-window self-heal #2: process crashed mid-migration after moving expectedRoot
	// to backupDir and before placing the promoted root back at expectedRoot.
	if _, rootErr := os.Stat(expectedRoot); os.IsNotExist(rootErr) {
		if info, bakErr := os.Stat(backupDir); bakErr == nil && info.IsDir() {
			if pkg, parseErr := protocol.ParsePluginPackageDir(promotedDir); parseErr == nil && pkg.Manifest.Metadata.ID == expectedID {
				if err := os.Rename(promotedDir, expectedRoot); err != nil {
					return packageDir, false, fmt.Errorf("恢复已提升插件目录失败：%w", err)
				}
				_ = os.RemoveAll(backupDir)
				return expectedRoot, true, nil
			}
			// Restore unfinished promotion back to expectedRoot so the migration below can run cleanly.
			if _, promErr := os.Stat(promotedDir); promErr == nil {
				if err := os.MkdirAll(filepath.Dir(stagedNested), 0o755); err != nil {
					return packageDir, false, fmt.Errorf("恢复中断迁移目录失败：%w", err)
				}
				if err := os.Rename(promotedDir, stagedNested); err != nil {
					return packageDir, false, fmt.Errorf("恢复中断迁移包失败：%w", err)
				}
			}
			if err := os.Rename(backupDir, expectedRoot); err != nil {
				return packageDir, false, fmt.Errorf("恢复迁移备份目录失败：%w", err)
			}
		}
	}

	if info, err := os.Stat(cleaned); err != nil || !info.IsDir() {
		return packageDir, false, nil
	}

	if err := os.RemoveAll(backupDir); err != nil {
		return packageDir, false, err
	}
	if err := os.Rename(expectedRoot, backupDir); err != nil {
		return packageDir, false, err
	}
	rollback := func(cause error) error {
		var rollbackErrs []error
		if _, err := os.Stat(promotedDir); err == nil {
			if mkErr := os.MkdirAll(filepath.Dir(stagedNested), 0o755); mkErr != nil {
				rollbackErrs = append(rollbackErrs, mkErr)
			} else if rnErr := os.Rename(promotedDir, stagedNested); rnErr != nil {
				rollbackErrs = append(rollbackErrs, rnErr)
			}
		}
		if rnErr := os.Rename(backupDir, expectedRoot); rnErr != nil {
			rollbackErrs = append(rollbackErrs, rnErr)
		}
		if len(rollbackErrs) > 0 {
			return errors.Join(cause, fmt.Errorf("迁移回滚失败：%w", errors.Join(rollbackErrs...)))
		}
		return cause
	}

	promoted, err := promoteStagedPackageRoot(backupDir, stagedNested)
	if err != nil {
		return packageDir, false, rollback(err)
	}
	pkg, err := protocol.ParsePluginPackageDir(promoted)
	if err != nil || pkg.Manifest.Metadata.ID != expectedID {
		cause := err
		if cause == nil {
			cause = fmt.Errorf("迁移后插件包 ID 不匹配：got %q, want %q", pkg.Manifest.Metadata.ID, expectedID)
		} else {
			cause = fmt.Errorf("迁移后插件包校验失败：%w", cause)
		}
		return packageDir, false, rollback(cause)
	}
	if err := os.Rename(promoted, expectedRoot); err != nil {
		return packageDir, false, rollback(err)
	}
	_ = os.RemoveAll(backupDir)
	return expectedRoot, true, nil
}
