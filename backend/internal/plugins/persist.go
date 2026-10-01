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

func (c *Runtime) discardBlobIfUnreferenced(name string) {
	name = filepath.Base(strings.TrimSpace(name))
	if name == "" || name == "." || name == string(filepath.Separator) {
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

func (c *Runtime) restoreRegistry(previous []RegistryRecord) error {
	if err := c.writeRegistry(previous); err != nil {
		return err
	}
	return c.reload()
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
