package plugins

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"infinite-canvas/backend/internal/protocol"
)

// Official packages are immutable inputs shipped with the application. Cache
// their validated envelopes so multiple runtime instances do not repeatedly
// parse the same archives during startup. Uploaded packages are intentionally
// parsed through the uncached path.
var officialPluginPackageCache = struct {
	sync.RWMutex
	items map[string]protocol.PluginPackage
}{items: make(map[string]protocol.PluginPackage)}

func parseOfficialPluginPackage(data []byte) (protocol.PluginPackage, error) {
	key := pluginHash(data)
	officialPluginPackageCache.RLock()
	if pkg, ok := officialPluginPackageCache.items[key]; ok {
		officialPluginPackageCache.RUnlock()
		return pkg, nil
	}
	officialPluginPackageCache.RUnlock()
	pkg, err := protocol.ParsePluginPackage(data)
	if err != nil {
		return protocol.PluginPackage{}, err
	}
	officialPluginPackageCache.Lock()
	officialPluginPackageCache.items[key] = pkg
	officialPluginPackageCache.Unlock()
	return pkg, nil
}

func (c *Runtime) bootstrapBuiltInPlugins() error {
	stored, err := c.readRegistry()
	if err != nil {
		return err
	}
	byID := make(map[string]RegistryRecord, len(stored))
	for _, record := range stored {
		byID[record.ID] = record
	}
	officialDir, err := officialPluginPackageDir()
	if err != nil {
		return err
	}
	entries, err := os.ReadDir(officialDir)
	if err != nil {
		return fmt.Errorf("读取官方插件目录失败：%w", err)
	}
	builtInIDs := make(map[string]struct{}, len(entries)+2)
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(strings.ToLower(entry.Name()), protocol.PluginPackageExtension) {
			continue
		}
		packageData, err := os.ReadFile(filepath.Join(officialDir, entry.Name()))
		if err != nil {
			return fmt.Errorf("读取官方插件包 %s：%w", entry.Name(), err)
		}
		pkg, err := parseOfficialPluginPackage(packageData)
		if err != nil {
			return fmt.Errorf("校验官方插件包 %s：%w", entry.Name(), err)
		}
		if strings.HasPrefix(strings.TrimSpace(pkg.Manifest.Runtime.Backend), "host:") {
			return fmt.Errorf("官方插件 %q 不能依赖 host 执行器", pkg.Manifest.Metadata.ID)
		}
		if _, err := protocol.LoadInstalledProviders(pkg.ManifestRaw, nil); err != nil {
			return fmt.Errorf("加载官方插件 %q：%w", pkg.Manifest.Metadata.ID, err)
		}
		id := pkg.Manifest.Metadata.ID
		if _, duplicate := builtInIDs[id]; duplicate {
			return fmt.Errorf("官方插件 ID %q 重复", id)
		}
		builtInIDs[id] = struct{}{}
		manifest := pkg.Manifest
		record := byID[id]
		if len(record.Raw) > 0 {
			var previous protocol.Manifest
			if err := json.Unmarshal(record.Raw, &previous); err == nil {
				manifest.Metadata.Enabled = previous.Metadata.Enabled
			}
		}
		manifestData, err := json.Marshal(manifest)
		if err != nil {
			return fmt.Errorf("编码官方插件 %q：%w", id, err)
		}
		hash := pluginHash(packageData)
		packageName := hash + protocol.PluginPackageExtension
		if err := writePluginFile(filepath.Join(c.packageDir, packageName), packageData); err != nil {
			return fmt.Errorf("缓存官方插件 %q：%w", id, err)
		}
		now := time.Now().UTC()
		if record.InstalledAt.IsZero() {
			record.InstalledAt = now
		}
		source := OriginOfficial
		record.ID, record.Raw, record.Source, record.FileName = id, manifestData, source, entry.Name()
		record.PackagePath, record.PackageSHA256, record.UpdatedAt = packageName, hash, now
		byID[id] = record
	}
	bundledManifests := BundledWorkflowManifests()
	for _, bundled := range bundledManifests {
		builtInIDs[bundled.Metadata.ID] = struct{}{}
		data, err := json.Marshal(bundled)
		if err != nil {
			return fmt.Errorf("encode built-in plugin %s: %w", bundled.Metadata.ID, err)
		}
		record := byID[bundled.Metadata.ID]
		if len(record.Raw) > 0 {
			var installed protocol.Manifest
			if err := json.Unmarshal(record.Raw, &installed); err != nil {
				return fmt.Errorf("decode built-in plugin %s: %w", bundled.Metadata.ID, err)
			}
			bundled.Metadata.Enabled = installed.Metadata.Enabled
			data, err = json.Marshal(bundled)
			if err != nil {
				return fmt.Errorf("encode built-in plugin %s: %w", bundled.Metadata.ID, err)
			}
		}
		now := time.Now().UTC()
		if record.InstalledAt.IsZero() {
			record.InstalledAt = now
		}
		source := OriginOfficial
		record.UpdatedAt = now
		record.ID, record.Raw, record.Source, record.PackagePath = bundled.Metadata.ID, data, source, ""
		byID[bundled.Metadata.ID] = record
	}
	result := make([]RegistryRecord, 0, len(byID))
	for _, record := range byID {
		if IsBuiltInSource(record.Source) {
			if _, exists := builtInIDs[record.ID]; !exists {
				// Built-in records are reconciled from repository packages and host
				// manifests on every startup, so removed plugins cannot survive stale.
				continue
			}
		}
		result = append(result, record)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
	return c.writeRegistry(result)
}
