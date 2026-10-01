package plugins

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"infinite-canvas/backend/internal/protocol"
)

func (c *Runtime) readRegistry() ([]RegistryRecord, error) {
	data, err := os.ReadFile(c.registryPath)
	if errors.Is(err, os.ErrNotExist) {
		return []RegistryRecord{}, nil
	}
	if err != nil {
		return nil, err
	}
	if len(data) > protocol.PluginManifestMaxBytes*64 {
		return nil, fmt.Errorf("插件 registry 超过大小限制")
	}
	var records []RegistryRecord
	if err := json.Unmarshal(data, &records); err != nil {
		return nil, fmt.Errorf("读取插件 registry 失败：%w", err)
	}
	return records, nil
}

func (c *Runtime) writeRegistry(records []RegistryRecord) error {
	if hook := c.testFailWriteRegistry; hook != nil {
		if err := hook(); err != nil {
			return err
		}
	}
	data, err := json.MarshalIndent(records, "", "  ")
	if err != nil {
		return err
	}
	return writePluginFile(c.registryPath, data)
}

func blobFileName(hash string) string {
	hash = strings.TrimSpace(hash)
	if hash == "" {
		return ""
	}
	return hash + protocol.PluginPackageExtension
}

func referencedBlobNames(records []RegistryRecord) map[string]struct{} {
	refs := make(map[string]struct{}, len(records))
	for _, record := range records {
		name := filepath.Base(strings.TrimSpace(record.PackagePath))
		if name == "" || name == "." || name == string(filepath.Separator) {
			continue
		}
		refs[name] = struct{}{}
	}
	return refs
}

func (c *Runtime) liveBlobReferenced(name string) bool {
	name = filepath.Base(strings.TrimSpace(name))
	if name == "" || name == "." || name == string(filepath.Separator) {
		return false
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	for _, record := range c.plugins {
		if filepath.Base(strings.TrimSpace(record.PackagePath)) == name {
			return true
		}
	}
	return false
}

func (c *Runtime) discardBlobIfUnreferenced(name string) {
	name = filepath.Base(strings.TrimSpace(name))
	if name == "" || name == "." || name == string(filepath.Separator) {
		return
	}
	if c.liveBlobReferenced(name) {
		return
	}
	stored, err := c.readRegistry()
	if err != nil {
		return
	}
	if _, referenced := referencedBlobNames(stored)[name]; referenced {
		return
	}
	_ = os.Remove(filepath.Join(c.packageDir, name))
}

func materializeRecords(stored []RegistryRecord) (map[string]Record, *protocol.Registry, error) {
	plugins := make(map[string]Record, len(stored))
	for _, storedRecord := range stored {
		data := storedRecord.Raw
		if len(data) > protocolPluginMaxBytes {
			return nil, nil, fmt.Errorf("plugin %s exceeds %d bytes", storedRecord.ID, protocolPluginMaxBytes)
		}
		var manifest protocol.Manifest
		if err := json.Unmarshal(data, &manifest); err != nil {
			return nil, nil, fmt.Errorf("decode plugin %s: %w", storedRecord.ID, err)
		}
		metadata := manifest.Metadata
		if strings.TrimSpace(metadata.ID) == "" {
			return nil, nil, fmt.Errorf("plugin %s has no metadata id", storedRecord.ID)
		}
		if _, exists := plugins[metadata.ID]; exists {
			return nil, nil, fmt.Errorf("duplicate installed protocol %q", metadata.ID)
		}
		packageSHA256 := storedRecord.PackageSHA256
		if packageSHA256 == "" && strings.TrimSpace(storedRecord.PackagePath) == "" {
			packageSHA256 = pluginHash(data)
		}
		plugins[metadata.ID] = Record{Raw: append([]byte(nil), data...), Metadata: metadata, Source: storedRecord.Source, FileName: storedRecord.FileName, PackagePath: storedRecord.PackagePath, PackageSHA256: packageSHA256, SHA256: packageSHA256, InstalledAt: storedRecord.InstalledAt, UpdatedAt: storedRecord.UpdatedAt, Status: StatusInvalid}
	}
	registry, err := protocol.NewRegistry()
	if err != nil {
		return nil, nil, err
	}
	for id, record := range plugins {
		var manifest protocol.Manifest
		if err := json.Unmarshal(record.Raw, &manifest); err != nil {
			record.Error = err.Error()
			plugins[id] = record
			continue
		}
		adapters, loadErr := protocol.LoadInstalledProviders(record.Raw, nil)
		if loadErr != nil {
			record.Metadata.Enabled = false
			record.Metadata.UnavailableReason = loadErr.Error()
			record.Error = loadErr.Error()
			_ = registry.Register(protocol.UnavailableAdapter{Info: record.Metadata})
			plugins[id] = record
			continue
		}
		if !record.Metadata.Enabled {
			record.Status = StatusDisabled
			for _, adapter := range adapters {
				info := adapter.Metadata()
				info.Enabled = false
				_ = registry.Register(protocol.UnavailableAdapter{Info: info})
			}
			plugins[id] = record
			continue
		}
		registrationFailed := false
		for _, adapter := range adapters {
			if err := registry.Register(adapter); err != nil {
				record.Error = err.Error()
				registrationFailed = true
			}
		}
		if registrationFailed {
			plugins[id] = record
			continue
		}
		record.Status = StatusEnabled
		plugins[id] = record
	}
	return plugins, registry, nil
}

func writePluginFile(path string, data []byte) error {
	temporary, err := os.CreateTemp(filepath.Dir(path), ".plugin-*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryPath, path)
}

func pluginHash(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

func cloneRegistryRecords(records []RegistryRecord) []RegistryRecord {
	out := make([]RegistryRecord, len(records))
	for i, record := range records {
		out[i] = record
		if record.Raw != nil {
			out[i].Raw = append(json.RawMessage(nil), record.Raw...)
		}
	}
	return out
}
