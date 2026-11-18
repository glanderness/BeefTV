package plugins

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/protocol"
)

const builtinBlobsSubdir = ".builtin-blobs"

func isManagedBuiltinPluginID(id string) bool {
	return isBundledBuiltinPlugin(id) || validCuratedBuiltinID(id)
}

func builtinBlobParentDir(dataDir, id string) (string, bool) {
	if strings.TrimSpace(dataDir) == "" || !isManagedBuiltinPluginID(id) {
		return "", false
	}
	abs, err := filepath.Abs(filepath.Join(dataDir, "plugins", builtinBlobsSubdir, id))
	if err != nil {
		return "", false
	}
	return abs, true
}

func sameCleanDir(a, b string) bool {
	if strings.TrimSpace(a) == "" || strings.TrimSpace(b) == "" {
		return false
	}
	absA, errA := filepath.Abs(a)
	absB, errB := filepath.Abs(b)
	if errA != nil || errB != nil {
		return false
	}
	if realA, err := filepath.EvalSymlinks(absA); err == nil {
		absA = realA
	}
	if realB, err := filepath.EvalSymlinks(absB); err == nil {
		absB = realB
	}
	return absA == absB
}

func treeContainsSymlink(root string) bool {
	if strings.TrimSpace(root) == "" {
		return false
	}
	info, err := os.Lstat(root)
	if err != nil || info.Mode()&fs.ModeSymlink != 0 {
		return true
	}
	foundSymlink := false
	_ = filepath.WalkDir(root, func(_ string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			foundSymlink = true
			return fs.SkipAll
		}
		if d.Type()&fs.ModeSymlink != 0 {
			foundSymlink = true
			return fs.SkipAll
		}
		return nil
	})
	return foundSymlink
}

func makeTreeReadOnly(root string) {
	if strings.TrimSpace(root) == "" {
		return
	}
	_ = filepath.WalkDir(root, func(target string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || d.Type()&fs.ModeSymlink != 0 {
			return nil
		}
		info, statErr := os.Lstat(target)
		if statErr != nil || info.Mode()&fs.ModeSymlink != 0 {
			return nil
		}
		mode := os.FileMode(0o444)
		if info.Mode()&0o111 != 0 {
			mode = 0o555
		}
		_ = os.Chmod(target, mode)
		return nil
	})
}

func removeReadOnlyTree(root string) {
	if strings.TrimSpace(root) == "" {
		return
	}
	rootInfo, err := os.Lstat(root)
	if err != nil {
		return
	}
	if rootInfo.Mode()&fs.ModeSymlink != 0 {
		_ = os.Remove(root)
		return
	}
	_ = filepath.WalkDir(root, func(target string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil || d.Type()&fs.ModeSymlink != 0 {
			return nil
		}
		if d.IsDir() {
			_ = os.Chmod(target, 0o700)
		} else {
			_ = os.Chmod(target, 0o600)
		}
		return nil
	})
	_ = os.RemoveAll(root)
}

func stageHotUpdatedBuiltinBlob(dataDir, id, stageDir, relRoot, expectedSHA string) (protocol.PluginPackage, func(), error) {
	wantSHA := strings.ToLower(strings.TrimSpace(expectedSHA))
	if !validPackageSHA256(wantSHA) {
		return protocol.PluginPackage{}, nil, fmt.Errorf("无效的内置插件热更新校验值")
	}
	if treeContainsSymlink(stageDir) {
		return protocol.PluginPackage{}, nil, fmt.Errorf("内置插件 %q 热更新包不允许包含符号链接", id)
	}
	blobParent, ok := builtinBlobParentDir(dataDir, id)
	if !ok {
		return protocol.PluginPackage{}, nil, fmt.Errorf("不支持热更新内置插件 %q", id)
	}
	if err := os.MkdirAll(blobParent, 0o755); err != nil {
		return protocol.PluginPackage{}, nil, fmt.Errorf("创建内置插件内容寻址目录失败：%w", err)
	}
	blobRoot := filepath.Join(blobParent, wantSHA)
	removeReadOnlyTree(blobRoot)
	if err := os.Rename(stageDir, blobRoot); err != nil {
		return protocol.PluginPackage{}, nil, fmt.Errorf("启用内置插件热更新目录失败：%w", err)
	}
	cleanup := func() { removeReadOnlyTree(blobRoot) }
	installed, err := protocol.ParsePluginPackageDir(filepath.Join(blobRoot, relRoot))
	if err != nil {
		cleanup()
		return protocol.PluginPackage{}, nil, err
	}
	if installed.Manifest.Metadata.ID != id || strings.ToLower(installed.SHA256) != wantSHA {
		cleanup()
		return protocol.PluginPackage{}, nil, fmt.Errorf("内置插件 %q 热更新内容校验不一致", id)
	}
	makeTreeReadOnly(blobRoot)
	return installed, cleanup, nil
}

// pruneOtherBuiltinBlobs 清理不再使用的旧热更新目录；keepExtra 设为 1 时保留最近一版，
// 防止正在加载旧版相对模块（如 ./presets.js）的浏览器标签页在切换瞬间收到 404。
func pruneOtherBuiltinBlobs(dataDir, id, keepSHA string, keepExtra int) {
	blobParent, ok := builtinBlobParentDir(dataDir, id)
	if !ok {
		return
	}
	entries, err := os.ReadDir(blobParent)
	if err != nil {
		return
	}
	keep := strings.ToLower(strings.TrimSpace(keepSHA))
	type candidate struct {
		name    string
		modTime time.Time
	}
	var others []candidate
	for _, entry := range entries {
		if strings.ToLower(entry.Name()) == keep {
			continue
		}
		var modTime time.Time
		if info, infoErr := entry.Info(); infoErr == nil {
			modTime = info.ModTime()
		}
		others = append(others, candidate{name: entry.Name(), modTime: modTime})
	}
	sort.Slice(others, func(i, j int) bool { return others[i].modTime.After(others[j].modTime) })
	for idx, item := range others {
		if idx < keepExtra {
			continue
		}
		removeReadOnlyTree(filepath.Join(blobParent, item.name))
	}
}

func verifyHotUpdatedBuiltinDir(dataDir, id, recordedDir, expectedSHA string) (protocol.PluginPackage, bool) {
	wantSHA := strings.ToLower(strings.TrimSpace(expectedSHA))
	if strings.TrimSpace(recordedDir) == "" || !validPackageSHA256(wantSHA) {
		return protocol.PluginPackage{}, false
	}
	blobParent, ok := builtinBlobParentDir(dataDir, id)
	if !ok {
		return protocol.PluginPackage{}, false
	}
	blobRoot := filepath.Join(blobParent, wantSHA)
	realBlobRoot, err := filepath.EvalSymlinks(blobRoot)
	if err != nil {
		return protocol.PluginPackage{}, false
	}
	realRecorded, err := filepath.EvalSymlinks(recordedDir)
	if err != nil {
		return protocol.PluginPackage{}, false
	}
	rel, err := filepath.Rel(realBlobRoot, realRecorded)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return protocol.PluginPackage{}, false
	}
	if treeContainsSymlink(realBlobRoot) {
		return protocol.PluginPackage{}, false
	}
	pkg, err := protocol.ParsePluginPackageDir(realRecorded)
	if err != nil || pkg.Manifest.Metadata.ID != id || strings.ToLower(pkg.SHA256) != wantSHA {
		return protocol.PluginPackage{}, false
	}
	if protocol.CheckPackageManifestWriting(realRecorded) != nil {
		return protocol.PluginPackage{}, false
	}
	if _, loadErr := protocol.LoadInstalledProviders(pkg.ManifestRaw); loadErr != nil {
		return protocol.PluginPackage{}, false
	}
	return pkg, true
}

func resolveBuiltinDirByRevision(dataDir, id, revision string) (string, bool) {
	wantSHA := strings.ToLower(strings.TrimSpace(revision))
	if !isManagedBuiltinPluginID(id) || !validPackageSHA256(wantSHA) {
		return "", false
	}
	if shippedDir, ok := BundledSampleDir(id); ok {
		if shippedPkg, err := protocol.ParsePluginPackageDir(shippedDir); err == nil && strings.ToLower(shippedPkg.SHA256) == wantSHA {
			return shippedPkg.RootDir, true
		}
	}
	blobParent, ok := builtinBlobParentDir(dataDir, id)
	if !ok {
		return "", false
	}
	blobRoot := filepath.Join(blobParent, wantSHA)
	for _, candidate := range []string{filepath.Join(blobRoot, "node_modules", id), blobRoot} {
		if pkg, valid := verifyHotUpdatedBuiltinDir(dataDir, id, candidate, wantSHA); valid {
			return pkg.RootDir, true
		}
	}
	return "", false
}

func isHotUpdatedBuiltinRecord(dataDir, id string, record Record) bool {
	if !isManagedBuiltinPluginID(id) || !IsBuiltInSource(record.Source) || strings.TrimSpace(record.PackageDir) == "" {
		return false
	}
	if shippedDir, ok := BundledSampleDir(id); ok && sameCleanDir(record.PackageDir, shippedDir) {
		return false
	}
	blobParent, ok := builtinBlobParentDir(dataDir, id)
	if !ok {
		return true
	}
	if realParent, err := filepath.EvalSymlinks(blobParent); err == nil {
		blobParent = realParent
	}
	absDir, err := filepath.Abs(record.PackageDir)
	if err != nil {
		return true
	}
	if realDir, err := filepath.EvalSymlinks(absDir); err == nil {
		absDir = realDir
	}
	rel, relErr := filepath.Rel(blobParent, absDir)
	return relErr == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func (c *Runtime) reconcileDynamicBuiltinOnBoot(record RegistryRecord) (RegistryRecord, bool) {
	if c == nil || !IsBuiltInSource(record.Source) || !validCuratedBuiltinID(record.ID) || isBundledBuiltinPlugin(record.ID) {
		return RegistryRecord{}, false
	}
	hotPkg, ok := verifyHotUpdatedBuiltinDir(c.dataDir, record.ID, record.PackageDir, record.PackageSHA256)
	if !ok {
		c.cleanupBuiltinBlobsOnBoot(record.ID, "", false)
		// 本地动态包目录缺失或损坏时保留声明式协议定义并标记待修复，使已存渠道不断流且下一次合作伙伴同步自动重装修复。
		var manifest protocol.Manifest
		if len(record.Raw) > 0 && json.Unmarshal(record.Raw, &manifest) == nil && manifest.Metadata.ID == record.ID {
			record.Source = OriginOfficial
			record.PackageDir = ""
			record.LoadError = firstNonBlank(record.LoadError, "官方合作伙伴扩展本地文件缺失或校验不一致，等待自动修复")
			record.LoadErrorStage = "activate"
			return record, true
		}
		return RegistryRecord{}, false
	}
	manifest := hotPkg.Manifest
	if len(record.Raw) > 0 {
		var previous protocol.Manifest
		if err := json.Unmarshal(record.Raw, &previous); err == nil {
			manifest.Metadata.Enabled = previous.Metadata.Enabled
		}
	}
	manifestData, err := json.Marshal(manifest)
	if err != nil {
		return RegistryRecord{}, false
	}
	now := time.Now().UTC()
	next := RegistryRecord{
		ID:              record.ID,
		Raw:             manifestData,
		Source:          OriginOfficial,
		PackageDir:      hotPkg.RootDir,
		PackageSpec:     firstNonBlank(record.PackageSpec, hotPkg.PackageName, record.ID),
		PackageSHA256:   hotPkg.SHA256,
		ArchiveSHA256:   record.ArchiveSHA256,
		PartnerPresetID: record.PartnerPresetID,
		SkillDirs:       hotPkg.SkillDirs,
		InstalledAt:     now,
		UpdatedAt:       now,
	}
	next.LoadError, next.LoadErrorStage = retainedLoadError(record, next)
	if !record.InstalledAt.IsZero() {
		next.InstalledAt = record.InstalledAt
	}
	if !registryRecordContentChanged(record, next) {
		next.UpdatedAt = record.UpdatedAt
	}
	c.cleanupBuiltinBlobsOnBoot(record.ID, hotPkg.SHA256, true)
	return next, true
}

func (c *Runtime) preferHotUpdatedBuiltinOnBoot(id string, record RegistryRecord, shipped protocol.PluginPackage) (pkg protocol.PluginPackage, adoptedHot bool, recordStillValid bool) {
	if c == nil || !IsBuiltInSource(record.Source) || strings.TrimSpace(record.PackageSpec) != id || strings.TrimSpace(record.LoadError) != "" {
		return shipped, false, false
	}
	if sameCleanDir(record.PackageDir, shipped.RootDir) {
		return shipped, false, true
	}
	hotPkg, ok := verifyHotUpdatedBuiltinDir(c.dataDir, id, record.PackageDir, record.PackageSHA256)
	if !ok {
		return shipped, false, false
	}
	if newerVersion(hotPkg.Manifest.Metadata.Version, shipped.Manifest.Metadata.Version) {
		return hotPkg, true, true
	}
	return shipped, false, true
}

func (c *Runtime) cleanupBuiltinBlobsOnBoot(id, activeSHA string, keepActive bool) {
	if c == nil {
		return
	}
	if keepActive {
		pruneOtherBuiltinBlobs(c.dataDir, id, activeSHA, 0)
		return
	}
	if blobParent, ok := builtinBlobParentDir(c.dataDir, id); ok {
		removeReadOnlyTree(blobParent)
	}
}

func (c *Runtime) rollbackHotUpdatedBuiltin(id string) (View, bool, error) {
	if c == nil {
		return View{}, false, fmt.Errorf("插件运行时未初始化")
	}
	c.beginMutation()
	defer c.endMutation()
	c.mu.RLock()
	record, ok := c.plugins[strings.TrimSpace(id)]
	c.mu.RUnlock()
	if !ok || !isHotUpdatedBuiltinRecord(c.dataDir, record.Metadata.ID, record) {
		return View{}, false, nil
	}
	view, err := c.rollbackHotUpdatedBuiltinLocked(record.Metadata.ID, record)
	if err != nil {
		return View{}, false, err
	}
	return view, true, nil
}

func (c *Runtime) rollbackHotUpdatedBuiltinLocked(id string, existing Record) (View, error) {
	shippedRoot, ok := BundledSampleDir(id)
	if !ok {
		return c.quarantineDynamicBuiltinLocked(id, existing, "官方合作伙伴扩展校验异常，已自动停用")
	}
	shipped, err := protocol.ParsePluginPackageDir(shippedRoot)
	if err != nil {
		return View{}, err
	}
	manifest := shipped.Manifest
	manifest.Metadata.Enabled = existing.Metadata.Enabled
	manifestData, err := json.Marshal(manifest)
	if err != nil {
		return View{}, err
	}
	stored, err := c.currentRecords()
	if err != nil {
		return View{}, err
	}
	now := time.Now().UTC()
	for index := range stored {
		if stored[index].ID == id {
			stored[index] = RegistryRecord{
				ID:            id,
				Raw:           manifestData,
				Source:        OriginOfficial,
				PackageDir:    shipped.RootDir,
				PackageSpec:   shipped.PackageName,
				PackageSHA256: shipped.SHA256,
				SkillDirs:     shipped.SkillDirs,
				LoadError:     "",
				InstalledAt:   stored[index].InstalledAt,
				UpdatedAt:     now,
			}
			break
		}
	}
	pluginsMap, registry, err := c.build(stored)
	if err != nil {
		return View{}, err
	}
	view, err := viewFromPlugins(pluginsMap, id)
	if err != nil {
		return View{}, err
	}
	stage := stagedMutation{
		previousLive: c.captureLive(),
		nextDisk:     stored,
		nextPlugins:  pluginsMap,
		nextRegistry: registry,
		view:         view,
	}
	extras := persistExtras{}
	if c.store != nil {
		extras.platform = &model.PluginPlatformState{PluginID: id, Available: view.Status == StatusEnabled, CreatedAt: now, UpdatedAt: now}
	}
	if err := c.commitAndPublish(&stage, extras); err != nil {
		c.abortUncommitted(&stage)
		return View{}, err
	}
	if blobParent, ok := builtinBlobParentDir(c.dataDir, id); ok {
		removeReadOnlyTree(blobParent)
	}
	return stage.view, nil
}

func (c *Runtime) quarantineDynamicBuiltinLocked(id string, existing Record, reason string) (View, error) {
	var manifest protocol.Manifest
	if err := json.Unmarshal(existing.Raw, &manifest); err != nil {
		return View{}, err
	}
	manifest.Metadata.Enabled = existing.Metadata.Enabled
	manifestData, err := json.Marshal(manifest)
	if err != nil {
		return View{}, err
	}
	stored, err := c.currentRecords()
	if err != nil {
		return View{}, err
	}
	now := time.Now().UTC()
	errMsg := firstNonBlank(reason, "官方合作伙伴扩展本地文件校验异常，已隔离客户端脚本并等待自动修复")
	for index := range stored {
		if stored[index].ID == id {
			stored[index].Raw = manifestData
			stored[index].PackageDir = ""
			stored[index].LoadError = errMsg
			stored[index].LoadErrorStage = "activate"
			stored[index].UpdatedAt = now
			break
		}
	}
	pluginsMap, registry, err := c.build(stored)
	if err != nil {
		return View{}, err
	}
	view, err := viewFromPlugins(pluginsMap, id)
	if err != nil {
		return View{}, err
	}
	stage := stagedMutation{
		previousLive: c.captureLive(),
		nextDisk:     stored,
		nextPlugins:  pluginsMap,
		nextRegistry: registry,
		view:         view,
	}
	extras := persistExtras{}
	if c.store != nil {
		extras.platform = &model.PluginPlatformState{PluginID: id, Available: existing.Metadata.Enabled, CreatedAt: now, UpdatedAt: now}
	}
	if err := c.commitAndPublish(&stage, extras); err != nil {
		c.abortUncommitted(&stage)
		return View{}, err
	}
	if blobParent, ok := builtinBlobParentDir(c.dataDir, id); ok {
		removeReadOnlyTree(blobParent)
	}
	return stage.view, nil
}
