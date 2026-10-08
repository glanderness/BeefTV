package desktopupdate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestRepeatedInvalidInstallerDoesNotAccumulateStaging(t *testing.T) {
	pub, priv, err := GenerateTestKey()
	if err != nil {
		t.Fatal(err)
	}
	// Signed transport bytes can still be an invalid archive/layout.
	invalid := []byte("not an installer archive")
	sum := sha256.Sum256(invalid)
	server := signedFeedServer(t, priv, testPayload("v1.6.0", "darwin-arm64", "", hex.EncodeToString(sum[:]), int64(len(invalid)), ""), invalid)
	engine := testEngine(t, pub, server, "v1.5.1", "darwin-arm64")
	keep := filepath.Join(engine.stagingRoot, "another-download")
	if err := os.MkdirAll(keep, 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := engine.CheckForUpdate(context.Background()); err != nil {
		t.Fatal(err)
	}
	for range 3 {
		if _, err := engine.DownloadUpdate(context.Background()); !errors.Is(err, ErrInvalidArchive) {
			t.Fatalf("invalid package accepted: %v", err)
		}
		entries, err := os.ReadDir(engine.stagingRoot)
		if err != nil {
			t.Fatal(err)
		}
		for _, entry := range entries {
			if entry.Name() != "another-download" && entry.Name() != "downloads" {
				t.Fatalf("failed installer left staging %s", entry.Name())
			}
		}
		if _, err := os.Stat(keep); err != nil {
			t.Fatal("another download removed", err)
		}
	}
}
