package desktopnet

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// Mode controls whether BeefTV follows OS/environment proxy settings or connects directly.
type Mode string

const (
	ModeSystem Mode = "system"
	ModeDirect Mode = "direct"

	preferenceFileName = "network-proxy.json"
)

type preferenceRecord struct {
	Mode Mode `json:"mode"`
}

var (
	modeMu         sync.RWMutex
	prefWriteMu    sync.Mutex
	configuredMode = ModeSystem
)

// NormalizeMode validates a user-supplied network proxy mode.
func NormalizeMode(raw string) (Mode, bool) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case string(ModeSystem):
		return ModeSystem, true
	case string(ModeDirect):
		return ModeDirect, true
	default:
		return "", false
	}
}

// CurrentMode returns the active in-process network proxy preference.
func CurrentMode() Mode {
	modeMu.RLock()
	mode := configuredMode
	modeMu.RUnlock()
	if mode == ModeDirect {
		return ModeDirect
	}
	return ModeSystem
}

// SetMode updates the active in-process network proxy preference.
func SetMode(mode Mode) error {
	normalized, ok := NormalizeMode(string(mode))
	if !ok {
		return fmt.Errorf("不支持的网络代理模式：%q", string(mode))
	}
	modeMu.Lock()
	configuredMode = normalized
	modeMu.Unlock()
	invalidateSystemProxyCache()
	return nil
}

// LoadPreference reads the persisted proxy preference from dataDir and applies it.
// A missing file defaults cleanly to ModeSystem.
func LoadPreference(dataDir string) (Mode, error) {
	dir := strings.TrimSpace(dataDir)
	if dir == "" {
		_ = SetMode(ModeSystem)
		return ModeSystem, nil
	}
	raw, err := os.ReadFile(filepath.Join(dir, preferenceFileName))
	if err != nil {
		_ = SetMode(ModeSystem)
		if errors.Is(err, os.ErrNotExist) {
			return ModeSystem, nil
		}
		return ModeSystem, err
	}
	var record preferenceRecord
	if err := json.Unmarshal(raw, &record); err != nil {
		_ = SetMode(ModeSystem)
		return ModeSystem, err
	}
	normalized, ok := NormalizeMode(string(record.Mode))
	if !ok {
		_ = SetMode(ModeSystem)
		return ModeSystem, fmt.Errorf("无效的网络代理配置：%q", string(record.Mode))
	}
	_ = SetMode(normalized)
	return normalized, nil
}

// SavePreference validates, atomically persists, and activates the proxy preference.
func SavePreference(dataDir string, mode Mode) error {
	normalized, ok := NormalizeMode(string(mode))
	if !ok {
		return fmt.Errorf("不支持的网络代理模式：%q", string(mode))
	}
	dir := strings.TrimSpace(dataDir)
	if dir == "" {
		return errors.New("工作区数据目录未就绪，无法保存网络代理设置")
	}
	prefWriteMu.Lock()
	defer prefWriteMu.Unlock()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	encoded, err := json.MarshalIndent(preferenceRecord{Mode: normalized}, "", "  ")
	if err != nil {
		return err
	}
	encoded = append(encoded, '\n')
	tmp, err := os.CreateTemp(dir, ".network-proxy-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(encoded); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, filepath.Join(dir, preferenceFileName)); err != nil {
		return err
	}
	return SetMode(normalized)
}
