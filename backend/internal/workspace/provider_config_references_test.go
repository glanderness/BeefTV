package workspace

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSavedProtocolReferencesCountsChannelsAndProfiles(t *testing.T) {
	dir := t.TempDir()
	body := `{"schemaVersion":1,"revision":4,"config":{
        "channels":[
            {"id":"jimeng","apiKey":"placeholder","interfaceType":"volcengine-jimeng-video","models":["jimeng-video-3.0"],"modelProfiles":[{"model":"jimeng-video-3.0","protocol":"volcengine-jimeng-video","capability":"video"}]},
            {"id":"relay","apiKey":"placeholder","models":["a","b"],"modelProfiles":[{"model":"a","protocol":"video-generations-json"},{"model":"b","protocol":"video-generations-json"},{"model":"c","protocol":""}]},
            {"id":"no-protocol","apiKey":"placeholder","models":["plain"]}
        ]
    }}`
	path := filepath.Join(dir, LocalProviderConfigFile)
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	store, err := NewProviderConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	counts, err := store.SavedProtocolReferences()
	if err != nil {
		t.Fatal(err)
	}
	if counts["volcengine-jimeng-video"] != 2 {
		t.Fatalf("jimeng references = %d want 2 (interfaceType + profile)", counts["volcengine-jimeng-video"])
	}
	if counts["video-generations-json"] != 2 {
		t.Fatalf("relay references = %d want 2", counts["video-generations-json"])
	}
	if len(counts) != 2 {
		t.Fatalf("unexpected protocol references: %#v", counts)
	}
	for _, value := range counts {
		if value <= 0 {
			t.Fatalf("non-positive reference count: %#v", counts)
		}
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatal("reference audit rewrote the stored configuration")
	}
}

func TestSavedProtocolReferencesReadsEncryptedSnapshot(t *testing.T) {
	dir := t.TempDir()
	store, err := NewProviderConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SaveLocalModelConfig([]byte(`{"channels":[{"id":"direct","apiKey":"placeholder-key","models":["m"],"modelProfiles":[{"model":"m","protocol":"xai-video"}]}]}`)); err != nil {
		t.Fatal(err)
	}
	counts, err := store.SavedProtocolReferences()
	if err != nil {
		t.Fatal(err)
	}
	if counts["xai-video"] != 1 {
		t.Fatalf("references = %#v", counts)
	}
	// The encrypted migration still happens on the normal read path, not here.
	if _, err := os.Stat(filepath.Join(dir, LocalProviderConfigFile+".bak")); err == nil {
		t.Fatal("audit rotated the configuration backup")
	}
}

func TestSavedProtocolReferencesWithoutConfigIsEmpty(t *testing.T) {
	store, err := NewProviderConfig(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	counts, err := store.SavedProtocolReferences()
	if err != nil {
		t.Fatal(err)
	}
	if len(counts) != 0 {
		t.Fatalf("references = %#v", counts)
	}
}

func TestSavedProtocolReferencesFailsClosedOnCorruptConfig(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, LocalProviderConfigFile), []byte(`{"schemaVersion":2,"encryptedConfig":"broken"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := NewProviderConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.SavedProtocolReferences(); err == nil {
		t.Fatal("corrupt configuration was reported as an empty reference set")
	}
}
