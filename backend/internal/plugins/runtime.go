package plugins

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/protocol"
)

const protocolPluginMaxBytes = protocol.PluginManifestMaxBytes

// Runtime owns plugin registry files, package blobs, the live protocol
// registry snapshot, and mutation concurrency. It is the single writer of
// plugin_registry.json. Lifecycle operations that also persist platform
// state must take mutationMu on this Runtime; a per-call Service cannot.

type Runtime struct {
	mu                    sync.RWMutex
	mutationMu            sync.Mutex
	registryPath          string
	packageDir            string
	plugins               map[string]Record
	registry              *protocol.Registry
	testBeforeMutation    func()
	testFailReload        func() error
	testFailWriteRegistry func() error
}

func NewRuntime(dataDir string) (*Runtime, error) {
	dataDir = strings.TrimSpace(dataDir)
	if dataDir == "" {
		return nil, errors.New("plugin data directory is empty")
	}
	var err error
	dataDir, err = filepath.Abs(dataDir)
	if err != nil {
		return nil, fmt.Errorf("plugin data directory is invalid: %w", err)
	}
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return nil, fmt.Errorf("create plugin registry directory: %w", err)
	}
	packageDir := filepath.Join(dataDir, "plugin-packages")
	if err := os.MkdirAll(packageDir, 0o700); err != nil {
		return nil, fmt.Errorf("create plugin package directory: %w", err)
	}
	center := &Runtime{registryPath: filepath.Join(dataDir, "plugin_registry.json"), packageDir: packageDir, plugins: make(map[string]Record)}
	if err := center.bootstrapBuiltInPlugins(); err != nil {
		return nil, err
	}
	if err := center.reload(); err != nil {
		return nil, err
	}
	return center, nil
}

// RuntimeForTest builds an in-memory runtime for host tests that only need
// List/management. It does not touch the filesystem.
func RuntimeForTest(records map[string]Record) *Runtime {
	plugins := records
	if plugins == nil {
		plugins = map[string]Record{}
	}
	registry, _ := protocol.NewRegistry()
	return &Runtime{plugins: plugins, registry: registry}
}

func (c *Runtime) List() []View {
	if c == nil {
		return []View{}
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	items := make([]View, 0, len(c.plugins))
	for _, item := range c.plugins {
		items = append(items, clonePluginView(viewFromRecord(item)))
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Manifest.ID < items[j].Manifest.ID })
	return items
}

func (c *Runtime) Registry() *protocol.Registry {
	if c == nil {
		return nil
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.registry
}

func (c *Runtime) Package(id string) ([]byte, string, error) {
	if c == nil {
		return nil, "", fmt.Errorf("插件运行时未初始化")
	}
	c.mu.RLock()
	record, ok := c.plugins[strings.TrimSpace(id)]
	packageDir := c.packageDir
	c.mu.RUnlock()
	if !ok {
		return nil, "", fmt.Errorf("插件 %q 不存在", id)
	}
	if record.PackagePath == "" {
		return nil, "", fmt.Errorf("插件 %q 没有可下载的包文件", id)
	}
	data, err := os.ReadFile(filepath.Join(packageDir, filepath.Base(record.PackagePath)))
	if err != nil {
		return nil, "", fmt.Errorf("读取插件包失败：%w", err)
	}
	return data, record.FileName, nil
}

func (c *Runtime) beginMutation() {
	if c.testBeforeMutation != nil {
		c.testBeforeMutation()
	}
	c.mutationMu.Lock()
}

func (c *Runtime) endMutation() {
	c.mutationMu.Unlock()
}

func (c *Runtime) reload() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if hook := c.testFailReload; hook != nil {
		if err := hook(); err != nil {
			return err
		}
	}
	stored, err := c.readRegistry()
	if err != nil {
		return err
	}
	plugins := make(map[string]Record)
	for _, storedRecord := range stored {
		data := storedRecord.Raw
		if len(data) > protocolPluginMaxBytes {
			return fmt.Errorf("plugin %s exceeds %d bytes", storedRecord.ID, protocolPluginMaxBytes)
		}
		var manifest protocol.Manifest
		if err := json.Unmarshal(data, &manifest); err != nil {
			return fmt.Errorf("decode plugin %s: %w", storedRecord.ID, err)
		}
		metadata := manifest.Metadata
		if strings.TrimSpace(metadata.ID) == "" {
			return fmt.Errorf("plugin %s has no metadata id", storedRecord.ID)
		}
		if _, exists := plugins[metadata.ID]; exists {
			return fmt.Errorf("duplicate installed protocol %q", metadata.ID)
		}
		packageSHA256 := storedRecord.PackageSHA256
		if packageSHA256 == "" && strings.TrimSpace(storedRecord.PackagePath) == "" {
			packageSHA256 = pluginHash(data)
		}
		plugins[metadata.ID] = Record{Raw: data, Metadata: metadata, Source: storedRecord.Source, FileName: storedRecord.FileName, PackagePath: storedRecord.PackagePath, PackageSHA256: packageSHA256, SHA256: packageSHA256, InstalledAt: storedRecord.InstalledAt, UpdatedAt: storedRecord.UpdatedAt, Status: StatusInvalid}
	}
	registry, err := protocol.NewRegistry()
	if err != nil {
		return err
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
	c.plugins = plugins
	c.registry = registry
	return nil
}

func (c *Runtime) failNextReload(err error) {
	c.testFailReload = func() error {
		c.testFailReload = nil
		return err
	}
}

func (c *Runtime) failNextWriteRegistry(err error) {
	c.testFailWriteRegistry = func() error {
		c.testFailWriteRegistry = nil
		return err
	}
}

func officialPluginPackageDir() (string, error) {
	return generation.OfficialPluginPackageDir()
}
