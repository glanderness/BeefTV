package eagle

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestOriginalPathResolvesSiblingMediaAndJailsEscape(t *testing.T) {
	root := t.TempDir()
	itemID := "item-1"
	itemDir := filepath.Join(root, "images", itemID+".info")
	if err := os.MkdirAll(itemDir, 0o750); err != nil {
		t.Fatal(err)
	}
	original := filepath.Join(itemDir, "photo.jpg")
	thumbnail := filepath.Join(itemDir, "photo_thumbnail.jpg")
	if err := os.WriteFile(original, []byte("orig"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(thumbnail, []byte("thumb"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(itemDir, "metadata.json"), []byte(`{}`), 0o640); err != nil {
		t.Fatal(err)
	}

	got, err := originalPath(thumbnail, itemID, root)
	if err != nil {
		t.Fatal(err)
	}
	if got != original {
		t.Fatalf("originalPath = %q, want %q", got, original)
	}

	secretDir := t.TempDir()
	secret := filepath.Join(secretDir, "secret.bin")
	if err := os.WriteFile(secret, []byte("secret"), 0o640); err != nil {
		t.Fatal(err)
	}
	_, err = originalPath(secret, itemID, root)
	if err == nil || !strings.Contains(err.Error(), "不在当前素材库内") {
		t.Fatalf("escaped thumbnail error = %v", err)
	}

	escaped := filepath.Join(itemDir, "..", "..", "..", filepath.Base(secretDir), "secret.bin")
	_, err = originalPath(escaped, itemID, root)
	if err == nil || !strings.Contains(err.Error(), "不在当前素材库内") {
		t.Fatalf("relative escape error = %v", err)
	}

	_, err = originalPath(thumbnail, itemID, "relative-library")
	if err == nil || !strings.Contains(err.Error(), "素材库路径无效") {
		t.Fatalf("relative library error = %v", err)
	}
}

func TestOriginalPathSkipsThumbnailAndMetadataWhenStemMissing(t *testing.T) {
	root := t.TempDir()
	itemID := "item-2"
	itemDir := filepath.Join(root, "images", itemID+".info")
	if err := os.MkdirAll(itemDir, 0o750); err != nil {
		t.Fatal(err)
	}
	thumbnail := filepath.Join(itemDir, "preview_thumbnail.webp")
	fallback := filepath.Join(itemDir, "clip.mp4")
	if err := os.WriteFile(thumbnail, []byte("thumb"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(itemDir, "metadata.json"), []byte(`{}`), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(fallback, []byte("video"), 0o640); err != nil {
		t.Fatal(err)
	}

	got, err := originalPath(thumbnail, itemID, root)
	if err != nil {
		t.Fatal(err)
	}
	if got != fallback {
		t.Fatalf("originalPath = %q, want %q", got, fallback)
	}
}

func TestThumbnailInsideLibraryRejectsEscape(t *testing.T) {
	root := t.TempDir()
	itemID := "item-3"
	itemDir := filepath.Join(root, "images", itemID+".info")
	if err := os.MkdirAll(itemDir, 0o750); err != nil {
		t.Fatal(err)
	}
	inside := filepath.Join(itemDir, "thumb.jpg")
	if err := os.WriteFile(inside, []byte("ok"), 0o640); err != nil {
		t.Fatal(err)
	}
	got, err := thumbnailInsideLibrary(inside, itemID, root)
	if err != nil {
		t.Fatal(err)
	}
	if got != filepath.Clean(inside) {
		t.Fatalf("thumbnailInsideLibrary = %q", got)
	}
	outside := filepath.Join(root, "other.jpg")
	if err := os.WriteFile(outside, []byte("no"), 0o640); err != nil {
		t.Fatal(err)
	}
	_, err = thumbnailInsideLibrary(outside, itemID, root)
	if err == nil || !strings.Contains(err.Error(), "不在当前素材库内") {
		t.Fatalf("outside thumbnail error = %v", err)
	}
}
