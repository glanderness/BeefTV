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

type blobMutation struct {
	previous    []RegistryRecord
	oldBlob     string
	newBlob     string
	createdBlob bool
}

type installOutcome struct {
	view View
	blobMutation
}

type uninstallOutcome struct {
	previous []RegistryRecord
	blob     string
}

func (c *Runtime) Install(data []byte, fileName string) (View, error) {
	if c == nil {
		return View{}, fmt.Errorf("插件运行时未初始化")
	}
	c.beginMutation()
	defer c.endMutation()
	outcome, err := c.installLocked(data, fileName)
	if err != nil {
		return View{}, err
	}
	c.commitInstall(outcome)
	return outcome.view, nil
}

func (c *Runtime) installLocked(data []byte, fileName string) (installOutcome, error) {
	if len(data) == 0 || len(data) > protocol.PluginPackageMaxBytes {
		return installOutcome{}, fmt.Errorf("plugin package must be between 1 and %d bytes", protocol.PluginPackageMaxBytes)
	}
	pkg, err := protocol.ParsePluginPackage(data)
	if err != nil {
		return installOutcome{}, err
	}
	manifest := pkg.Manifest
	if strings.HasPrefix(strings.TrimSpace(manifest.Runtime.Backend), "host:") {
		return installOutcome{}, errors.New("上传插件不能使用宿主内置执行器")
	}
	if _, err := protocol.LoadInstalledProviders(pkg.ManifestRaw, nil); err != nil {
		return installOutcome{}, err
	}
	c.mu.RLock()
	existing, exists := c.plugins[manifest.Metadata.ID]
	c.mu.RUnlock()
	if exists && IsBuiltInSource(existing.Source) {
		return installOutcome{}, fmt.Errorf("内置插件 %q 不能通过上传覆盖", manifest.Metadata.ID)
	}
	manifest.Metadata.Enabled = !exists || existing.Metadata.Enabled
	manifestData, err := json.Marshal(manifest)
	if err != nil {
		return installOutcome{}, err
	}
	hash := pluginHash(data)
	packageName := filepath.Base(strings.TrimSpace(fileName))
	if packageName == "." || packageName == "" || packageName == string(filepath.Separator) {
		packageName = manifest.Metadata.ID + protocol.PluginPackageExtension
	}
	blobName := blobFileName(hash)
	packagePath := filepath.Join(c.packageDir, blobName)
	_, statErr := os.Stat(packagePath)
	createdBlob := errors.Is(statErr, os.ErrNotExist)
	if err := writePluginFile(packagePath, data); err != nil {
		return installOutcome{}, fmt.Errorf("保存插件包失败：%w", err)
	}
	stored, err := c.readRegistry()
	if err != nil {
		if createdBlob {
			c.discardBlobIfUnreferenced(blobName)
		}
		return installOutcome{}, err
	}
	previousStored := cloneRegistryRecords(stored)
	now := time.Now().UTC()
	newRecord := RegistryRecord{ID: manifest.Metadata.ID, Raw: manifestData, Source: OriginUploaded, FileName: packageName, PackagePath: blobName, PackageSHA256: hash, InstalledAt: now, UpdatedAt: now}
	if exists {
		newRecord.InstalledAt = existing.InstalledAt
		replaced := false
		for index := range stored {
			if stored[index].ID == manifest.Metadata.ID {
				stored[index] = newRecord
				replaced = true
				break
			}
		}
		if !replaced {
			stored = append(stored, newRecord)
		}
	} else {
		stored = append(stored, newRecord)
	}
	if err := c.writeRegistry(stored); err != nil {
		if createdBlob {
			c.discardBlobIfUnreferenced(blobName)
		}
		return installOutcome{}, fmt.Errorf("保存插件失败：%w", err)
	}
	outcome := installOutcome{
		blobMutation: blobMutation{
			previous:    previousStored,
			oldBlob:     existing.PackagePath,
			newBlob:     blobName,
			createdBlob: createdBlob,
		},
	}
	if err := c.reload(); err != nil {
		if rb := c.rollbackInstall(outcome); rb != nil {
			return installOutcome{}, joinMutationError(err, rb)
		}
		return installOutcome{}, err
	}
	for _, item := range c.List() {
		if item.Manifest.ID == manifest.Metadata.ID {
			outcome.view = item
			return outcome, nil
		}
	}
	if rb := c.rollbackInstall(outcome); rb != nil {
		return installOutcome{}, joinMutationError(errors.New("插件保存后未加载"), rb)
	}
	return installOutcome{}, errors.New("插件保存后未加载")
}

func (c *Runtime) commitInstall(outcome installOutcome) {
	if outcome.oldBlob == "" || outcome.oldBlob == outcome.newBlob {
		return
	}
	c.discardBlobIfUnreferenced(outcome.oldBlob)
}

func (c *Runtime) rollbackInstall(outcome installOutcome) error {
	err := c.restoreRegistry(outcome.previous)
	if outcome.createdBlob {
		c.discardBlobIfUnreferenced(outcome.newBlob)
	}
	return err
}

func (c *Runtime) SetEnabled(id string, enabled bool) (View, error) {
	if c == nil {
		return View{}, fmt.Errorf("插件运行时未初始化")
	}
	c.beginMutation()
	defer c.endMutation()
	return c.setEnabledLocked(id, enabled)
}

func (c *Runtime) setEnabledLocked(id string, enabled bool) (View, error) {
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
		if rb := c.restoreRegistry(previousStored); rb != nil {
			return View{}, joinMutationError(err, rb)
		}
		return View{}, err
	}
	for _, item := range c.List() {
		if item.Manifest.ID == manifest.Metadata.ID {
			return item, nil
		}
	}
	if rb := c.restoreRegistry(previousStored); rb != nil {
		return View{}, joinMutationError(errors.New("插件状态更新后未加载"), rb)
	}
	return View{}, errors.New("插件状态更新后未加载")
}

func (c *Runtime) Uninstall(id string) error {
	if c == nil {
		return fmt.Errorf("插件运行时未初始化")
	}
	c.beginMutation()
	defer c.endMutation()
	outcome, err := c.uninstallLocked(id)
	if err != nil {
		return err
	}
	c.commitUninstall(outcome)
	return nil
}

func (c *Runtime) uninstallLocked(id string) (uninstallOutcome, error) {
	c.mu.RLock()
	record, ok := c.plugins[strings.TrimSpace(id)]
	c.mu.RUnlock()
	if !ok {
		return uninstallOutcome{}, fmt.Errorf("插件 %q 不存在", id)
	}
	if IsBuiltInSource(record.Source) {
		return uninstallOutcome{}, fmt.Errorf("内置插件 %q 不能卸载，可停用该插件", id)
	}
	stored, err := c.readRegistry()
	if err != nil {
		return uninstallOutcome{}, err
	}
	previousStored := cloneRegistryRecords(stored)
	filtered := make([]RegistryRecord, 0, len(stored))
	for _, item := range stored {
		if item.ID != record.Metadata.ID {
			filtered = append(filtered, item)
		}
	}
	if err := c.writeRegistry(filtered); err != nil {
		return uninstallOutcome{}, err
	}
	outcome := uninstallOutcome{previous: previousStored, blob: record.PackagePath}
	if err := c.reload(); err != nil {
		if rb := c.rollbackUninstall(outcome); rb != nil {
			return uninstallOutcome{}, joinMutationError(err, rb)
		}
		return uninstallOutcome{}, err
	}
	return outcome, nil
}

func (c *Runtime) commitUninstall(outcome uninstallOutcome) {
	c.discardBlobIfUnreferenced(outcome.blob)
}

func (c *Runtime) rollbackUninstall(outcome uninstallOutcome) error {
	return c.restoreRegistry(outcome.previous)
}
