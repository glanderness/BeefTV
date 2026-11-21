package provider

import (
	"sync"
)

// Registry 插件注册中心
type Registry struct {
	mu        sync.RWMutex
	providers []ModelCatalogPlugin
}

var globalRegistry = NewRegistry()

func NewRegistry() *Registry { return &Registry{} }

// Register 注册插件
func Register(discovery ModelCatalogPlugin) {
	globalRegistry.mu.Lock()
	defer globalRegistry.mu.Unlock()

	id := discovery.GetProviderID()
	for index, registered := range globalRegistry.providers {
		if registered.GetProviderID() == id {
			globalRegistry.providers[index] = discovery
			return
		}
	}
	globalRegistry.providers = append(globalRegistry.providers, discovery)
}

// MatchProvider 根据配置匹配插件
func MatchProvider(baseURL string, headers map[string]string) ModelCatalogPlugin {
	globalRegistry.mu.RLock()
	defer globalRegistry.mu.RUnlock()

	// 按注册顺序匹配，避免 map 遍历导致多个厂商规则命中时结果不稳定。
	for _, registered := range globalRegistry.providers {
		if registered.Match(baseURL, headers) {
			return registered
		}
	}
	return nil
}
