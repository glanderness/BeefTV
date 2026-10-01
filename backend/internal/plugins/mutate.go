package plugins

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"infinite-canvas/backend/internal/protocol"
)

func (c *Runtime) Install(data []byte, fileName string) (View, error) {
	if c == nil {
		return View{}, fmt.Errorf("插件运行时未初始化")
	}
	c.mutationMu.Lock()
	defer c.mutationMu.Unlock()
	if len(data) == 0 || len(data) > protocol.PluginPackageMaxBytes {
		return View{}, fmt.Errorf("plugin package must be between 1 and %d bytes", protocol.PluginPackageMaxBytes)
	}
	pkg, err := protocol.ParsePluginPackage(data)
	if err != nil {
		return View{}, err
	}
	manifest := pkg.Manifest
	if strings.HasPrefix(strings.TrimSpace(manifest.Runtime.Backend), "host:") {
		return View{}, errors.New("上传插件不能使用宿主内置执行器")
	}
	if _, err := protocol.LoadInstalledProviders(pkg.ManifestRaw, nil); err != nil {
		return View{}, err
	}
	c.mu.RLock()
	existing, exists := c.plugins[manifest.Metadata.ID]
	c.mu.RUnlock()
	if exists && IsBuiltInSource(existing.Source) {
		return View{}, fmt.Errorf("内置插件 %q 不能通过上传覆盖", manifest.Metadata.ID)
	}
	manifest.Metadata.Enabled = !exists || existing.Metadata.Enabled
	manifestData, err := json.Marshal(manifest)
	if err != nil {
		return View{}, err
	}
	hash := pluginHash(data)
	packageName := filepath.Base(strings.TrimSpace(fileName))
	if packageName == "." || packageName == "" || packageName == string(filepath.Separator) {
		packageName = manifest.Metadata.ID + protocol.PluginPackageExtension
	}
	packagePath := filepath.Join(c.packageDir, hash+protocol.PluginPackageExtension)
	if err := writePluginFile(packagePath, data); err != nil {
		return View{}, fmt.Errorf("保存插件包失败：%w", err)
	}
	stored, err := c.readRegistry()
	if err != nil {
		_ = os.Remove(packagePath)
		return View{}, err
	}
	previousStored := cloneRegistryRecords(stored)
	now := time.Now().UTC()
	newRecord := RegistryRecord{ID: manifest.Metadata.ID, Raw: manifestData, Source: OriginUploaded, FileName: packageName, PackagePath: filepath.Base(packagePath), PackageSHA256: hash, InstalledAt: now, UpdatedAt: now}
	if exists {
		newRecord.InstalledAt = existing.InstalledAt
		for index := range stored {
			if stored[index].ID == manifest.Metadata.ID {
				stored[index] = newRecord
				break
			}
		}
	} else {
		stored = append(stored, newRecord)
	}
	if err := c.writeRegistry(stored); err != nil {
		_ = os.Remove(packagePath)
		return View{}, fmt.Errorf("保存插件失败：%w", err)
	}
	if err := c.reload(); err != nil {
		_ = c.writeRegistry(previousStored)
		_ = c.reload()
		_ = os.Remove(packagePath)
		return View{}, err
	}
	if exists && existing.PackagePath != "" && existing.PackagePath != filepath.Base(packagePath) {
		_ = os.Remove(filepath.Join(c.packageDir, filepath.Base(existing.PackagePath)))
	}
	for _, item := range c.List() {
		if item.Manifest.ID == manifest.Metadata.ID {
			return item, nil
		}
	}
	return View{}, errors.New("插件保存后未加载")
}

func (c *Runtime) SetEnabled(id string, enabled bool) (View, error) {
	if c == nil {
		return View{}, fmt.Errorf("插件运行时未初始化")
	}
	c.mutationMu.Lock()
	defer c.mutationMu.Unlock()
	c.mu.RLock()
	record, ok := c.plugins[strings.TrimSpace(id)]
	c.mu.RUnlock()
	if !ok {
		return View{}, fmt.Errorf("插件 %q 不存在", id)
	}
	var manifest protocol.Manifest
	if err := json.Unmarshal(record.Raw, &manifest); err != nil {
		return View{}, err
	}
	manifest.Metadata.Enabled = enabled
	data, err := json.Marshal(manifest)
	if err != nil {
		return View{}, err
	}
	stored, err := c.readRegistry()
	if err != nil {
		return View{}, err
	}
	previousStored := cloneRegistryRecords(stored)
	for index := range stored {
		if stored[index].ID == record.Metadata.ID {
			stored[index].Raw = data
			stored[index].UpdatedAt = time.Now().UTC()
		}
	}
	if err := c.writeRegistry(stored); err != nil {
		return View{}, err
	}
	if err := c.reload(); err != nil {
		_ = c.writeRegistry(previousStored)
		_ = c.reload()
		return View{}, err
	}
	for _, item := range c.List() {
		if item.Manifest.ID == manifest.Metadata.ID {
			return item, nil
		}
	}
	return View{}, errors.New("插件状态更新后未加载")
}

func (c *Runtime) Uninstall(id string) error {
	if c == nil {
		return fmt.Errorf("插件运行时未初始化")
	}
	c.mutationMu.Lock()
	defer c.mutationMu.Unlock()
	c.mu.RLock()
	record, ok := c.plugins[strings.TrimSpace(id)]
	c.mu.RUnlock()
	if !ok {
		return fmt.Errorf("插件 %q 不存在", id)
	}
	if IsBuiltInSource(record.Source) {
		return fmt.Errorf("内置插件 %q 不能卸载，可停用该插件", id)
	}
	stored, err := c.readRegistry()
	if err != nil {
		return err
	}
	previousStored := cloneRegistryRecords(stored)
	filtered := make([]RegistryRecord, 0, len(stored))
	for _, item := range stored {
		if item.ID != record.Metadata.ID {
			filtered = append(filtered, item)
		}
	}
	if err := c.writeRegistry(filtered); err != nil {
		return err
	}
	if err := c.reload(); err != nil {
		_ = c.writeRegistry(previousStored)
		_ = c.reload()
		return err
	}
	if record.PackagePath != "" {
		_ = os.Remove(filepath.Join(c.packageDir, filepath.Base(record.PackagePath)))
	}
	return nil
}
