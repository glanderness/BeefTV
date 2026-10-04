package workspace

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestProviderConfigEncryptsLegacyConfigAndBackupAndRestores(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, LocalProviderConfigFile)
	legacy := []byte(`{"channels":[{"id":"custom","apiKey":"private-api","secretKey":"private-sk","headers":[{"name":"X-Key","value":"private-header"}],"models":["custom-model"]}]}`)
	if err := os.WriteFile(path, legacy, 0600); err != nil {
		t.Fatal(err)
	}
	store, _ := NewProviderConfig(dir)
	if err := store.SaveLocalModelConfig(legacy); err != nil {
		t.Fatal(err)
	}
	for _, file := range []string{path, path + ".bak"} {
		body, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(body, []byte("private-")) || !bytes.Contains(body, []byte("enc:v1:")) {
			t.Fatal("plaintext config or backup")
		}
	}
	reopened, _ := NewProviderConfig(dir)
	loaded, err := reopened.ReadLocalModelConfig()
	if err != nil || !bytes.Contains(loaded, []byte("private-header")) || !bytes.Contains(loaded, []byte("custom-model")) {
		t.Fatalf("round trip failed: %v", err)
	}
	restored := t.TempDir()
	for _, name := range []string{LocalProviderConfigFile, LocalProviderConfigFile + ".bak", ".settings-key"} {
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(restored, name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	restoredStore, _ := NewProviderConfig(restored)
	restoredBody, err := restoredStore.ReadLocalModelConfig()
	if err != nil || !bytes.Equal(loaded, restoredBody) {
		t.Fatalf("backup restore failed: %v", err)
	}
	if err := os.Remove(filepath.Join(dir, ".settings-key")); err != nil {
		t.Fatal(err)
	}
	if _, err := reopened.ReadLocalModelConfig(); err == nil {
		t.Fatal("missing key silently accepted")
	}
	if err := reopened.SaveLocalModelConfig(legacy); err == nil {
		t.Fatal("unreadable state overwritten")
	}
	if _, err := os.Stat(filepath.Join(dir, ".settings-key")); !os.IsNotExist(err) {
		t.Fatal("decrypt created a replacement key")
	}
}
