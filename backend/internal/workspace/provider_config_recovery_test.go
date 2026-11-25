package workspace

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/localcrypto"
)

func listCorruptPrimaries(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var paths []string
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasPrefix(entry.Name(), corruptPrimaryPrefix) {
			paths = append(paths, filepath.Join(dir, entry.Name()))
		}
	}
	return paths
}

func TestProviderConfigCorruptPrimaryQuarantinesAndRecoversFromBackup(t *testing.T) {
	cases := []struct {
		name    string
		corrupt []byte
	}{
		{name: "truncated_json", corrupt: []byte(`{"schemaVersion":`)},
		{name: "null_primary", corrupt: []byte("null")},
		{name: "null_config_envelope", corrupt: []byte(`{"schemaVersion":1,"revision":1,"config":null}`)},
		{name: "corrupt_ciphertext", corrupt: []byte(`{"schemaVersion":2,"encryptedConfig":"enc:v1:not-valid-cipher"}`)},
		{name: "short_nonce_ciphertext", corrupt: []byte(`{"schemaVersion":2,"encryptedConfig":"enc:v1:AAAA"}`)},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			store, err := NewProviderConfig(dir)
			if err != nil {
				t.Fatal(err)
			}
			firstConfig := []byte(`{"channels":[{"id":"custom-video","apiKey":"backup-secret","modelProfiles":[{"model":"seedance-2-5-special","capability":"video","capabilityConfig":{"version":1,"video":{"duration":{"selection":"range","min":1,"max":10,"step":1,"default":5}}}}]}]}`)
			if err := store.SaveLocalModelConfig(firstConfig); err != nil {
				t.Fatal(err)
			}
			secondConfig := []byte(`{"channels":[{"id":"custom-video","apiKey":"second-secret"}]}`)
			if err := store.SaveLocalModelConfig(secondConfig); err != nil {
				t.Fatal(err)
			}

			backupPath := filepath.Join(dir, LocalProviderConfigFile+".bak")
			backupBefore, err := os.ReadFile(backupPath)
			if err != nil {
				t.Fatal(err)
			}
			primaryPath := filepath.Join(dir, LocalProviderConfigFile)
			if err := os.WriteFile(primaryPath, tc.corrupt, 0o600); err != nil {
				t.Fatal(err)
			}

			// 读取应降级为 recovered 并返回备份 revision=1。
			effective, health, err := store.LoadEffectiveModelConfig()
			if err != nil {
				t.Fatalf("LoadEffectiveModelConfig() error = %v", err)
			}
			if health != ConfigHealthRecovered || effective.Revision != 1 {
				t.Fatalf("health=%q revision=%d, want recovered/1", health, effective.Revision)
			}

			// 修改时长上限并携带脱敏密钥 + 备份 revision 写入，应隔离损坏主文件并恢复可写。
			updated := []byte(`{"channels":[{"id":"custom-video","apiKey":"` + RedactedSecret + `","modelProfiles":[{"model":"seedance-2-5-special","capability":"video","capabilityConfig":{"version":1,"video":{"duration":{"selection":"range","min":1,"max":15,"step":1,"default":5}}}}]}]}`)
			nextRev, err := store.SaveLocalModelConfigRevision(updated, effective.Revision)
			if err != nil {
				t.Fatalf("SaveLocalModelConfigRevision() error = %v", err)
			}
			if nextRev != 2 {
				t.Fatalf("nextRev = %d, want 2", nextRev)
			}

			// 损坏主文件应被原样隔离，且有效 .bak 未被损坏内容覆盖。
			quarantined := listCorruptPrimaries(t, dir)
			if len(quarantined) != 1 {
				t.Fatalf("quarantined files = %v, want 1", quarantined)
			}
			gotCorrupt, err := os.ReadFile(quarantined[0])
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(gotCorrupt, tc.corrupt) {
				t.Fatalf("quarantined bytes = %q, want %q", gotCorrupt, tc.corrupt)
			}
			requireFileUnchanged(t, backupPath, backupBefore)

			// 恢复后再次读取应回到 ready，且保留备份中的真实密钥。
			reopened, err := NewProviderConfig(dir)
			if err != nil {
				t.Fatal(err)
			}
			after, afterHealth, err := reopened.LoadEffectiveModelConfig()
			if err != nil {
				t.Fatal(err)
			}
			if afterHealth != ConfigHealthReady || after.Revision != 2 {
				t.Fatalf("after health=%q revision=%d, want ready/2", afterHealth, after.Revision)
			}
			if got := requireEffectiveChannel(t, after, "custom-video")["apiKey"]; got != "backup-secret" {
				t.Fatalf("recovered apiKey = %v, want backup-secret", got)
			}
		})
	}
}

func TestProviderConfigCorruptPrimaryRejectsInvalidWriteWithoutQuarantine(t *testing.T) {
	dir := t.TempDir()
	store, err := NewProviderConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SaveLocalModelConfig([]byte(`{"channels":[{"id":"direct","apiKey":"kept-secret"}]}`)); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveLocalModelConfig([]byte(`{"channels":[{"id":"direct","apiKey":"second-secret"}]}`)); err != nil {
		t.Fatal(err)
	}
	primaryPath := filepath.Join(dir, LocalProviderConfigFile)
	corrupt := []byte(`{"schemaVersion":`)
	if err := os.WriteFile(primaryPath, corrupt, 0o600); err != nil {
		t.Fatal(err)
	}

	// 过期 revision / 非对象载荷 / 无法对应的脱敏密钥都必须先拒绝，不能碰磁盘。
	if _, err := store.SaveLocalModelConfigRevision([]byte(`{"channels":[]}`), 99); !errors.Is(err, ErrProviderConfigRevisionConflict) {
		t.Fatalf("stale revision err = %v, want ErrProviderConfigRevisionConflict", err)
	}
	requireSafeError(t, store.SaveLocalModelConfig([]byte("null")), ErrProviderConfigNotObject, "kept-secret", "second-secret")
	requireSafeError(t, store.SaveLocalModelConfig([]byte(`{"channels":[{"id":"unknown","apiKey":"`+RedactedSecret+`"}]}`)), ErrUnmatchedRedactedSecret, "kept-secret", "second-secret")

	requireFileUnchanged(t, primaryPath, corrupt)
	if quarantined := listCorruptPrimaries(t, dir); len(quarantined) != 0 {
		t.Fatalf("invalid write quarantined corrupt primary: %v", quarantined)
	}
}

func TestProviderConfigQuarantineRetentionCapsHistory(t *testing.T) {
	dir := t.TempDir()
	store, err := NewProviderConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SaveLocalModelConfig([]byte(`{"channels":[{"id":"direct","apiKey":"secret-1"}]}`)); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveLocalModelConfig([]byte(`{"channels":[{"id":"direct","apiKey":"secret-2"}]}`)); err != nil {
		t.Fatal(err)
	}

	baseTime := time.Date(2026, 11, 21, 12, 0, 0, 0, time.UTC)
	prevNow := nowConfigUTC
	t.Cleanup(func() { nowConfigUTC = prevNow })

	primaryPath := filepath.Join(dir, LocalProviderConfigFile)
	for i := 0; i < 5; i++ {
		step := i
		nowConfigUTC = func() time.Time { return baseTime.Add(time.Duration(step) * time.Second) }
		if err := os.WriteFile(primaryPath, []byte(`{"broken":`), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := store.SaveLocalModelConfig([]byte(`{"channels":[{"id":"direct","apiKey":"` + RedactedSecret + `","seq":` + string(rune('1'+i)) + `}]}`)); err != nil {
			t.Fatalf("recovery %d failed: %v", i, err)
		}
	}

	quarantined := listCorruptPrimaries(t, dir)
	if len(quarantined) != maxCorruptPrimaries {
		t.Fatalf("quarantined count = %d (%v), want %d", len(quarantined), quarantined, maxCorruptPrimaries)
	}
}

func TestProviderConfigReplaceRetriesTransientLock(t *testing.T) {
	t.Run("transient_lock_recovers_on_retry", func(t *testing.T) {
		dir := t.TempDir()
		store, err := NewProviderConfig(dir)
		if err != nil {
			t.Fatal(err)
		}
		transientErr := errors.New("sharing violation")
		origRename := renameConfigFile
		origRetryable := isRetryableConfigReplaceError
		origInUse := isConfigFileInUse
		origSleep := sleepConfigRetry
		t.Cleanup(func() {
			renameConfigFile = origRename
			isRetryableConfigReplaceError = origRetryable
			isConfigFileInUse = origInUse
			sleepConfigRetry = origSleep
		})

		attempts := 0
		sleeps := 0
		isRetryableConfigReplaceError = func(err error) bool { return errors.Is(err, transientErr) }
		isConfigFileInUse = func(err error) bool { return errors.Is(err, transientErr) }
		sleepConfigRetry = func(time.Duration) { sleeps++ }
		renameConfigFile = func(oldpath, newpath string) error {
			attempts++
			if attempts <= 2 {
				return transientErr
			}
			return os.Rename(oldpath, newpath)
		}

		if err := store.SaveLocalModelConfig([]byte(`{"channels":[{"id":"direct","apiKey":"secret-ok"}]}`)); err != nil {
			t.Fatalf("expected retry to succeed, got %v", err)
		}
		if attempts != 3 || sleeps != 2 {
			t.Fatalf("attempts=%d sleeps=%d, want 3/2", attempts, sleeps)
		}
		effective, health, err := store.LoadEffectiveModelConfig()
		if err != nil || health != ConfigHealthReady {
			t.Fatalf("load after retry: health=%q err=%v", health, err)
		}
		if got := requireEffectiveChannel(t, effective, "direct")["apiKey"]; got != "secret-ok" {
			t.Fatalf("apiKey = %v, want secret-ok", got)
		}
	})

	t.Run("persistent_lock_returns_ErrProviderConfigLocked", func(t *testing.T) {
		dir := t.TempDir()
		store, err := NewProviderConfig(dir)
		if err != nil {
			t.Fatal(err)
		}
		if err := store.SaveLocalModelConfig([]byte(`{"channels":[{"id":"direct","apiKey":"original"}]}`)); err != nil {
			t.Fatal(err)
		}
		primaryPath := filepath.Join(dir, LocalProviderConfigFile)
		before, err := os.ReadFile(primaryPath)
		if err != nil {
			t.Fatal(err)
		}

		lockErr := errors.New("persistent sharing violation")
		origRename := renameConfigFile
		origRetryable := isRetryableConfigReplaceError
		origInUse := isConfigFileInUse
		origSleep := sleepConfigRetry
		t.Cleanup(func() {
			renameConfigFile = origRename
			isRetryableConfigReplaceError = origRetryable
			isConfigFileInUse = origInUse
			sleepConfigRetry = origSleep
		})

		attempts := 0
		isRetryableConfigReplaceError = func(err error) bool { return errors.Is(err, lockErr) }
		isConfigFileInUse = func(err error) bool { return errors.Is(err, lockErr) }
		sleepConfigRetry = func(time.Duration) {}
		renameConfigFile = func(oldpath, newpath string) error {
			if newpath == store.path() {
				attempts++
				return lockErr
			}
			return os.Rename(oldpath, newpath)
		}

		err = store.SaveLocalModelConfig([]byte(`{"channels":[{"id":"direct","apiKey":"updated"}]}`))
		if !errors.Is(err, ErrProviderConfigLocked) {
			t.Fatalf("err = %v, want ErrProviderConfigLocked", err)
		}
		if attempts != maxReplaceRetries+1 {
			t.Fatalf("attempts = %d, want %d", attempts, maxReplaceRetries+1)
		}
		requireFileUnchanged(t, primaryPath, before)
	})

	t.Run("access_denied_retry_exhaustion_maps_to_locked", func(t *testing.T) {
		dir := t.TempDir()
		store, err := NewProviderConfig(dir)
		if err != nil {
			t.Fatal(err)
		}
		if err := store.SaveLocalModelConfig([]byte(`{"channels":[{"id":"direct","apiKey":"original"}]}`)); err != nil {
			t.Fatal(err)
		}
		primaryPath := filepath.Join(dir, LocalProviderConfigFile)
		before, err := os.ReadFile(primaryPath)
		if err != nil {
			t.Fatal(err)
		}

		origRename := renameConfigFile
		origRetryable := isRetryableConfigReplaceError
		origInUse := isConfigFileInUse
		origSleep := sleepConfigRetry
		t.Cleanup(func() {
			renameConfigFile = origRename
			isRetryableConfigReplaceError = origRetryable
			isConfigFileInUse = origInUse
			sleepConfigRetry = origSleep
		})

		attempts := 0
		isRetryableConfigReplaceError = func(err error) bool { return errors.Is(err, os.ErrPermission) }
		isConfigFileInUse = func(error) bool { return false }
		sleepConfigRetry = func(time.Duration) {}
		renameConfigFile = func(oldpath, newpath string) error {
			if newpath == store.path() {
				attempts++
				return &os.LinkError{Op: "rename", Old: oldpath, New: newpath, Err: os.ErrPermission}
			}
			return os.Rename(oldpath, newpath)
		}

		err = store.SaveLocalModelConfig([]byte(`{"channels":[{"id":"direct","apiKey":"updated"}]}`))
		if !errors.Is(err, ErrProviderConfigLocked) {
			t.Fatalf("err = %v, want ErrProviderConfigLocked", err)
		}
		if errors.Is(err, ErrProviderConfigPermission) {
			t.Fatalf("err = %v, must not be misclassified as ErrProviderConfigPermission", err)
		}
		if attempts != maxReplaceRetries+1 {
			t.Fatalf("attempts = %d, want %d", attempts, maxReplaceRetries+1)
		}
		requireFileUnchanged(t, primaryPath, before)
	})
}

func TestProviderConfigCorruptCiphertextWithoutBackupReturnsCorruptNotKeyUnavailable(t *testing.T) {
	cases := []struct {
		name    string
		corrupt []byte
	}{
		{name: "invalid_format", corrupt: []byte(`{"schemaVersion":2,"encryptedConfig":"enc:v1:not-valid-cipher"}`)},
		{name: "short_nonce", corrupt: []byte(`{"schemaVersion":2,"encryptedConfig":"enc:v1:AAAA"}`)},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			store, err := NewProviderConfig(dir)
			if err != nil {
				t.Fatal(err)
			}
			if err := store.SaveLocalModelConfig([]byte(`{"channels":[{"id":"direct","apiKey":"seed"}]}`)); err != nil {
				t.Fatal(err)
			}
			_ = os.Remove(filepath.Join(dir, LocalProviderConfigFile+".bak"))
			primaryPath := filepath.Join(dir, LocalProviderConfigFile)
			if err := os.WriteFile(primaryPath, tc.corrupt, 0o600); err != nil {
				t.Fatal(err)
			}

			if _, _, err := store.LoadEffectiveModelConfig(); !errors.Is(err, ErrMalformedProviderConfig) || errors.Is(err, ErrProviderConfigKeyUnavailable) {
				t.Fatalf("LoadEffectiveModelConfig() err = %v, want ErrMalformedProviderConfig (not KeyUnavailable)", err)
			}
			if err := store.SaveLocalModelConfig([]byte(`{"channels":[{"id":"direct","apiKey":"next"}]}`)); !errors.Is(err, ErrMalformedProviderConfig) || errors.Is(err, ErrProviderConfigKeyUnavailable) {
				t.Fatalf("SaveLocalModelConfig() err = %v, want ErrMalformedProviderConfig (not KeyUnavailable)", err)
			}
			requireFileUnchanged(t, primaryPath, tc.corrupt)
			if quarantined := listCorruptPrimaries(t, dir); len(quarantined) != 0 {
				t.Fatalf("expected no quarantine without backup, got %v", quarantined)
			}
		})
	}
}

func TestProviderConfigKeyUnavailableDoesNotQuarantinePrimary(t *testing.T) {
	dir := t.TempDir()
	store, err := NewProviderConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SaveLocalModelConfig([]byte(`{"channels":[{"id":"direct","apiKey":"secret-1"}]}`)); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveLocalModelConfig([]byte(`{"channels":[{"id":"direct","apiKey":"secret-2"}]}`)); err != nil {
		t.Fatal(err)
	}
	primaryPath := filepath.Join(dir, LocalProviderConfigFile)
	before, err := os.ReadFile(primaryPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(dir, ".settings-key")); err != nil {
		t.Fatal(err)
	}

	if err := store.rotateBackup(); !errors.Is(err, ErrProviderConfigKeyUnavailable) {
		t.Fatalf("rotateBackup() err = %v, want ErrProviderConfigKeyUnavailable", err)
	}
	requireFileUnchanged(t, primaryPath, before)
	if quarantined := listCorruptPrimaries(t, dir); len(quarantined) != 0 {
		t.Fatalf("key-unavailable error must not quarantine primary: %v", quarantined)
	}
}

func corruptEncryptedEnvelopeByte(t *testing.T, raw []byte) []byte {
	t.Helper()
	var env map[string]any
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatal(err)
	}
	cipherText, _ := env["encryptedConfig"].(string)
	decoded, err := base64.RawStdEncoding.DecodeString(strings.TrimPrefix(cipherText, localcrypto.Prefix))
	if err != nil || len(decoded) < 20 {
		t.Fatalf("unexpected ciphertext: %q err=%v", cipherText, err)
	}
	// 保持合法 base64 与足够长度，仅翻转末尾 GCM 认证标签字节以触发 ErrDecryptFailed。
	decoded[len(decoded)-1] ^= 0xff
	env["encryptedConfig"] = localcrypto.Prefix + base64.RawStdEncoding.EncodeToString(decoded)
	tampered, err := json.Marshal(env)
	if err != nil {
		t.Fatal(err)
	}
	return tampered
}

func TestProviderConfigGCMAuthFailureRecoversWhenBackupDecryptsWithCurrentKey(t *testing.T) {
	dir := t.TempDir()
	store, err := NewProviderConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SaveLocalModelConfig([]byte(`{"channels":[{"id":"custom-video","apiKey":"backup-secret"}]}`)); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveLocalModelConfig([]byte(`{"channels":[{"id":"custom-video","apiKey":"second-secret"}]}`)); err != nil {
		t.Fatal(err)
	}

	primaryPath := filepath.Join(dir, LocalProviderConfigFile)
	backupPath := filepath.Join(dir, LocalProviderConfigFile+".bak")
	primaryBefore, err := os.ReadFile(primaryPath)
	if err != nil {
		t.Fatal(err)
	}
	backupBefore, err := os.ReadFile(backupPath)
	if err != nil {
		t.Fatal(err)
	}
	tampered := corruptEncryptedEnvelopeByte(t, primaryBefore)
	if err := os.WriteFile(primaryPath, tampered, 0o600); err != nil {
		t.Fatal(err)
	}

	effective, health, err := store.LoadEffectiveModelConfig()
	if err != nil {
		t.Fatalf("LoadEffectiveModelConfig() error = %v", err)
	}
	if health != ConfigHealthRecovered || effective.Revision != 1 {
		t.Fatalf("health=%q revision=%d, want recovered/1", health, effective.Revision)
	}
	nextRev, err := store.SaveLocalModelConfigRevision([]byte(`{"channels":[{"id":"custom-video","apiKey":"`+RedactedSecret+`","updated":true}]}`), effective.Revision)
	if err != nil {
		t.Fatalf("SaveLocalModelConfigRevision() error = %v", err)
	}
	if nextRev != 2 {
		t.Fatalf("nextRev = %d, want 2", nextRev)
	}
	quarantined := listCorruptPrimaries(t, dir)
	if len(quarantined) != 1 {
		t.Fatalf("quarantined = %v, want 1", quarantined)
	}
	gotCorrupt, err := os.ReadFile(quarantined[0])
	if err != nil || !bytes.Equal(gotCorrupt, tampered) {
		t.Fatalf("quarantined mismatch: err=%v", err)
	}
	requireFileUnchanged(t, backupPath, backupBefore)
	after, afterHealth, err := store.LoadEffectiveModelConfig()
	if err != nil || afterHealth != ConfigHealthReady || after.Revision != 2 {
		t.Fatalf("after recovery: health=%q rev=%d err=%v", afterHealth, after.Revision, err)
	}
	if got := requireEffectiveChannel(t, after, "custom-video")["apiKey"]; got != "backup-secret" {
		t.Fatalf("recovered apiKey = %v, want backup-secret", got)
	}
}

func TestProviderConfigMissingPrimaryWithGCMCorruptBackupReturnsKeyUnavailable(t *testing.T) {
	dir := t.TempDir()
	store, err := NewProviderConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SaveLocalModelConfig([]byte(`{"channels":[{"id":"direct","apiKey":"secret-1"}]}`)); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveLocalModelConfig([]byte(`{"channels":[{"id":"direct","apiKey":"secret-2"}]}`)); err != nil {
		t.Fatal(err)
	}
	primaryPath := filepath.Join(dir, LocalProviderConfigFile)
	backupPath := filepath.Join(dir, LocalProviderConfigFile+".bak")
	backupRaw, err := os.ReadFile(backupPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(backupPath, corruptEncryptedEnvelopeByte(t, backupRaw), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(primaryPath); err != nil {
		t.Fatal(err)
	}

	if _, _, err := store.LoadEffectiveModelConfig(); !errors.Is(err, ErrProviderConfigKeyUnavailable) {
		t.Fatalf("LoadEffectiveModelConfig() err = %v, want ErrProviderConfigKeyUnavailable", err)
	}
	if err := store.SaveLocalModelConfig([]byte(`{"channels":[]}`)); !errors.Is(err, ErrProviderConfigKeyUnavailable) {
		t.Fatalf("SaveLocalModelConfig() err = %v, want ErrProviderConfigKeyUnavailable", err)
	}
}

func TestProviderConfigEncodeAndKeyIOErrorsAreClassified(t *testing.T) {
	t.Run("zero_byte_key_during_legacy_migration_and_save_returns_KeyUnavailable", func(t *testing.T) {
		dir := t.TempDir()
		store, err := NewProviderConfig(dir)
		if err != nil {
			t.Fatal(err)
		}
		legacy := []byte(`{"schemaVersion":1,"revision":2,"config":{"channels":[{"id":"custom","apiKey":"legacy-secret"}]}}`)
		if err := os.WriteFile(filepath.Join(dir, LocalProviderConfigFile), legacy, 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, ".settings-key"), nil, 0o600); err != nil {
			t.Fatal(err)
		}

		if _, _, err := store.LoadEffectiveModelConfig(); !errors.Is(err, ErrProviderConfigKeyUnavailable) {
			t.Fatalf("LoadEffectiveModelConfig() err = %v, want ErrProviderConfigKeyUnavailable", err)
		}
		if err := store.SaveLocalModelConfig([]byte(`{"channels":[{"id":"custom","apiKey":"next"}]}`)); !errors.Is(err, ErrProviderConfigKeyUnavailable) {
			t.Fatalf("SaveLocalModelConfig() err = %v, want ErrProviderConfigKeyUnavailable", err)
		}
		if err := store.rotateBackup(); !errors.Is(err, ErrProviderConfigKeyUnavailable) {
			t.Fatalf("rotateBackup() err = %v, want ErrProviderConfigKeyUnavailable", err)
		}
	})

	t.Run("permission_denied_key_during_encode_and_decode_returns_Permission_without_quarantine", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("POSIX chmod 000 does not deny reads on Windows")
		}
		if os.Geteuid() == 0 {
			t.Skip("chmod 000 does not deny root")
		}
		dir := t.TempDir()
		store, err := NewProviderConfig(dir)
		if err != nil {
			t.Fatal(err)
		}
		if err := store.SaveLocalModelConfig([]byte(`{"channels":[{"id":"custom","apiKey":"secret-1"}]}`)); err != nil {
			t.Fatal(err)
		}
		primaryPath := filepath.Join(dir, LocalProviderConfigFile)
		before, err := os.ReadFile(primaryPath)
		if err != nil {
			t.Fatal(err)
		}
		keyPath := filepath.Join(dir, ".settings-key")
		if err := os.Chmod(keyPath, 0o000); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.Chmod(keyPath, 0o600) })

		if _, _, err := store.LoadEffectiveModelConfig(); !errors.Is(err, ErrProviderConfigPermission) {
			t.Fatalf("LoadEffectiveModelConfig() err = %v, want ErrProviderConfigPermission", err)
		}
		if err := store.rotateBackup(); !errors.Is(err, ErrProviderConfigPermission) {
			t.Fatalf("rotateBackup() err = %v, want ErrProviderConfigPermission", err)
		}
		requireFileUnchanged(t, primaryPath, before)
		if quarantined := listCorruptPrimaries(t, dir); len(quarantined) != 0 {
			t.Fatalf("permission error must not quarantine primary: %v", quarantined)
		}
		// 同样检查未加密旧配置迁移时密钥无权限读。
		legacyDir := t.TempDir()
		legacyStore, err := NewProviderConfig(legacyDir)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(legacyDir, LocalProviderConfigFile), []byte(`{"channels":[{"id":"custom","apiKey":"legacy"}]}`), 0o600); err != nil {
			t.Fatal(err)
		}
		legacyKeyPath := filepath.Join(legacyDir, ".settings-key")
		if err := os.WriteFile(legacyKeyPath, make([]byte, 32), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(legacyKeyPath, 0o000); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.Chmod(legacyKeyPath, 0o600) })
		if _, _, err := legacyStore.LoadEffectiveModelConfig(); !errors.Is(err, ErrProviderConfigPermission) {
			t.Fatalf("legacy LoadEffectiveModelConfig() err = %v, want ErrProviderConfigPermission", err)
		}
	})

	t.Run("locked_key_error_maps_to_ErrProviderConfigLocked_without_quarantine", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("POSIX chmod 000 does not deny reads on Windows")
		}
		if os.Geteuid() == 0 {
			t.Skip("chmod 000 does not deny root")
		}
		dir := t.TempDir()
		store, err := NewProviderConfig(dir)
		if err != nil {
			t.Fatal(err)
		}
		if err := store.SaveLocalModelConfig([]byte(`{"channels":[{"id":"custom","apiKey":"secret-1"}]}`)); err != nil {
			t.Fatal(err)
		}
		primaryPath := filepath.Join(dir, LocalProviderConfigFile)
		before, err := os.ReadFile(primaryPath)
		if err != nil {
			t.Fatal(err)
		}
		keyPath := filepath.Join(dir, ".settings-key")
		if err := os.Chmod(keyPath, 0o000); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.Chmod(keyPath, 0o600) })

		origInUse := isConfigFileInUse
		t.Cleanup(func() { isConfigFileInUse = origInUse })
		// 模拟 Windows AV/Defender 占用 .settings-key（OS 返回 sharing/lock violation）。
		isConfigFileInUse = func(err error) bool { return errors.Is(err, os.ErrPermission) }

		if _, _, err := store.LoadEffectiveModelConfig(); !errors.Is(err, ErrProviderConfigLocked) {
			t.Fatalf("LoadEffectiveModelConfig() err = %v, want ErrProviderConfigLocked", err)
		}
		if err := store.rotateBackup(); !errors.Is(err, ErrProviderConfigLocked) {
			t.Fatalf("rotateBackup() err = %v, want ErrProviderConfigLocked", err)
		}
		requireFileUnchanged(t, primaryPath, before)
		if quarantined := listCorruptPrimaries(t, dir); len(quarantined) != 0 {
			t.Fatalf("locked key error must not quarantine primary: %v", quarantined)
		}
	})
}
