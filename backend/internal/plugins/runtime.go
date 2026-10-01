package plugins

import (
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

func (c *Runtime) captureLive() liveSnapshot {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return liveSnapshot{plugins: c.plugins, registry: c.registry}
}

func (c *Runtime) restoreLive(snap liveSnapshot) {
	if snap.plugins == nil {
		return
	}
	c.mu.Lock()
	c.plugins = snap.plugins
	c.registry = snap.registry
	c.mu.Unlock()
}

func (c *Runtime) publishLive(plugins map[string]Record, registry *protocol.Registry) error {
	if hook := c.testFailReload; hook != nil {
		if err := hook(); err != nil {
			return err
		}
	}
	c.mu.Lock()
	c.plugins = plugins
	c.registry = registry
	c.mu.Unlock()
	return nil
}

func (c *Runtime) reload() error {
	stored, err := c.readRegistry()
	if err != nil {
		return err
	}
	plugins, registry, err := materializeRecords(stored)
	if err != nil {
		return err
	}
	return c.publishLive(plugins, registry)
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
