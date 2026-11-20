package bootstrap

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"

	"infinite-canvas/backend/internal/model"
)

type failAfterReader struct {
	leftover []byte
	err      error
}

func (r *failAfterReader) Read(p []byte) (int, error) {
	if len(r.leftover) > 0 {
		n := copy(p, r.leftover)
		r.leftover = r.leftover[n:]
		if len(r.leftover) == 0 {
			return n, r.err
		}
		return n, nil
	}
	return 0, r.err
}

func TestSanitizeOwnedResourceIDRejectsTraversalAndURLs(t *testing.T) {
	for _, id := range []string{"", "../secret", "a/b", `a\b`, "http://example.com/x", "resource:abc", "abc def", strings.Repeat("a", 129)} {
		if _, err := sanitizeOwnedResourceID(id); err == nil {
			t.Fatalf("sanitizeOwnedResourceID(%q) succeeded", id)
		}
	}
	got, err := sanitizeOwnedResourceID("  abcdef0123456789  ")
	if err != nil {
		t.Fatal(err)
	}
	if got != "abcdef0123456789" {
		t.Fatalf("id = %q", got)
	}
}

func TestSanitizeSaveFileNameStripsPathsAndIllegalCharacters(t *testing.T) {
	got := SanitizeSaveFileName(`../evil:name?.mp4`)
	if strings.ContainsAny(got, `\/:*?"<>|`) || strings.Contains(got, "..") || !strings.HasSuffix(got, ".mp4") {
		t.Fatalf("SanitizeSaveFileName() = %q", got)
	}
	if got := SanitizeSaveFileName(" /tmp/clip.mp4 "); got != "clip.mp4" {
		t.Fatalf("basename = %q", got)
	}
	if got := SanitizeSaveFileName(".."); got != "未命名媒体" {
		t.Fatalf("dot name = %q", got)
	}
	if got := SanitizeSaveFileName("aux.mp4"); got != "未命名媒体.mp4" {
		t.Fatalf("reserved stem media extension lost: %q", got)
	}
	if got := SanitizeSaveFileNameWithFallbackStem("CON.zip", "beeftv-diagnostics"); got != "beeftv-diagnostics.zip" {
		t.Fatalf("windows device name = %q", got)
	}
}

func TestSanitizeSaveFileNameDoesNotSplitChineseRunes(t *testing.T) {
	name := strings.Repeat("好", 80) + ".mp4"
	got := SanitizeSaveFileName(name)
	if !utf8.ValidString(got) {
		t.Fatalf("truncated name is not valid UTF-8: %q", got)
	}
	if !strings.HasSuffix(got, ".mp4") {
		t.Fatalf("missing extension: %q", got)
	}
	if len(got) > MaxSaveFileNameBytes {
		t.Fatalf("len(%q) = %d", got, len(got))
	}
	for _, r := range got[:len(got)-4] {
		if r != '好' && r != '_' {
			t.Fatalf("unexpected rune %q in %q", r, got)
		}
	}
}

func TestOpenLocalOwnedResourceFileRejectsNonLocalProvider(t *testing.T) {
	dir := t.TempDir()
	_, err := openLocalOwnedResourceFile(&model.Resource{
		ID:        "abc",
		Provider:  "oss",
		Status:    model.ResourceStatusReady,
		ObjectKey: "workspaces/local/video/clip.mp4",
	}, dir)
	if err == nil {
		t.Fatal("expected non-local provider to be rejected")
	}
}

func TestWriteOwnedFileAtomicallyPreservesExistingDestOnReadFailure(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, "keep.bin")
	if err := os.WriteFile(dest, []byte("ORIGINAL"), 0o600); err != nil {
		t.Fatal(err)
	}
	err := writeOwnedFileAtomically(dest, &failAfterReader{leftover: []byte("xx"), err: errors.New("read failed")}, nil)
	if err == nil {
		t.Fatal("expected copy failure")
	}
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "ORIGINAL" {
		t.Fatalf("dest = %q", got)
	}
	assertNoSaveTemps(t, dir)
}

func TestWriteOwnedFileAtomicallyPreservesExistingDestOnWriteFailure(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, "keep.bin")
	if err := os.WriteFile(dest, []byte("ORIGINAL"), 0o600); err != nil {
		t.Fatal(err)
	}
	err := writeOwnedFileAtomically(dest, &failAfterReader{err: errors.New("write failed")}, nil)
	if err == nil {
		t.Fatal("expected copy failure")
	}
	got, _ := os.ReadFile(dest)
	if string(got) != "ORIGINAL" {
		t.Fatalf("dest = %q", got)
	}
	assertNoSaveTemps(t, dir)
}

func TestWriteOwnedFileAtomicallyReplacesDestOnlyAfterSuccess(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, "keep.bin")
	if err := os.WriteFile(dest, []byte("ORIGINAL"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := writeOwnedFileAtomically(dest, strings.NewReader("NEXT"), nil); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "NEXT" {
		t.Fatalf("dest = %q", got)
	}
	assertNoSaveTemps(t, dir)
}

func TestWriteOwnedArtifactRejectsOversizedPayload(t *testing.T) {
	err := WriteOwnedArtifact(filepath.Join(t.TempDir(), "out.zip"), make([]byte, MaxOwnedArtifactBytes+1))
	if err == nil {
		t.Fatal("expected oversized artifact to be rejected")
	}
}

func TestWriteOwnedArtifactExclusiveRefusesOverwriteAndCleansFailedWrite(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, "keep.bin")
	if err := os.WriteFile(dest, []byte("EXISTING"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := WriteOwnedArtifactExclusive(dest, []byte("NEW")); !errors.Is(err, os.ErrExist) {
		t.Fatalf("WriteOwnedArtifactExclusive on existing file = %v, want os.ErrExist", err)
	}
	got, err := os.ReadFile(dest)
	if err != nil || string(got) != "EXISTING" {
		t.Fatalf("existing file after exclusive attempt = %q err=%v", got, err)
	}

	failedDest := filepath.Join(dir, "partial.bin")
	if err := writeOwnedFileExclusive(failedDest, &failAfterReader{err: errors.New("boom")}); err == nil {
		t.Fatal("expected exclusive write failure")
	}
	if _, err := os.Lstat(failedDest); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("failed exclusive write left partial file: %v", err)
	}
	assertNoSaveTemps(t, dir)

	freshDest := filepath.Join(dir, "fresh.bin")
	if err := WriteOwnedArtifactExclusive(freshDest, []byte("ATOMIC")); err != nil {
		t.Fatalf("WriteOwnedArtifactExclusive fresh = %v", err)
	}
	if raw, err := os.ReadFile(freshDest); err != nil || string(raw) != "ATOMIC" {
		t.Fatalf("fresh file = %q err=%v", raw, err)
	}
	assertNoSaveTemps(t, dir)

	// Force link-less filesystem fallback (e.g. FAT32/exFAT) and verify atomic publish + no-clobber.
	origLink := linkOwnedFile
	linkOwnedFile = func(string, string) error { return errors.New("operation not supported") }
	defer func() { linkOwnedFile = origLink }()

	if err := WriteOwnedArtifactExclusive(dest, []byte("OVERWRITE")); !errors.Is(err, os.ErrExist) {
		t.Fatalf("fallback exclusive on existing = %v, want os.ErrExist", err)
	}
	fallbackDest := filepath.Join(dir, "fallback.bin")
	if err := WriteOwnedArtifactExclusive(fallbackDest, []byte("FALLBACK-ATOMIC")); err != nil {
		t.Fatalf("fallback WriteOwnedArtifactExclusive = %v", err)
	}
	if raw, err := os.ReadFile(fallbackDest); err != nil || string(raw) != "FALLBACK-ATOMIC" {
		t.Fatalf("fallback file = %q err=%v", raw, err)
	}
	assertNoSaveTemps(t, dir)
}

func TestReplaceFileLeavesAdjacentOldFileAlone(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, "keep.bin")
	adjacent := dest + ".beeftv-old"
	tmp := filepath.Join(dir, ".beeftv-save-x")
	if err := os.WriteFile(dest, []byte("ORIGINAL"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(adjacent, []byte("USER-OLD"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(tmp, []byte("NEXT"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := replaceFile(tmp, dest); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "NEXT" {
		t.Fatalf("dest = %q", got)
	}
	old, err := os.ReadFile(adjacent)
	if err != nil {
		t.Fatal(err)
	}
	if string(old) != "USER-OLD" {
		t.Fatalf("adjacent = %q", old)
	}
}

func TestReplaceFileFailurePreservesOriginalAndAdjacentOld(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, "keep.bin")
	adjacent := dest + ".beeftv-old"
	if err := os.Mkdir(dest, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(adjacent, []byte("USER-OLD"), 0o600); err != nil {
		t.Fatal(err)
	}
	err := writeOwnedFileAtomically(dest, strings.NewReader("NEXT"), nil)
	if err == nil {
		t.Fatal("expected replace of a directory to fail")
	}
	info, err := os.Stat(dest)
	if err != nil || !info.IsDir() {
		t.Fatalf("dest should still be the original directory: %v", err)
	}
	old, err := os.ReadFile(adjacent)
	if err != nil {
		t.Fatal(err)
	}
	if string(old) != "USER-OLD" {
		t.Fatalf("adjacent = %q", old)
	}
	assertNoSaveTemps(t, dir)
}

func assertNoSaveTemps(t *testing.T, dir string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".beeftv-save-") {
			t.Fatalf("leftover temp %s", entry.Name())
		}
	}
}
