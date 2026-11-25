package plugins

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
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
