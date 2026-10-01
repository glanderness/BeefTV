package workspace

import (
	"archive/tar"
	"compress/gzip"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func TestBackupRestoreRoundTrip(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "workspace")
	if err := os.MkdirAll(filepath.Join(source, "resources", "local"), 0o700); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		"open_ai_canvas.db":             "sqlite-data",
		LocalProviderConfigFile:         `{"channels":[]}`,
		"resources/local/generated.png": "image-bytes",
	}
	for name, body := range files {
		path := filepath.Join(source, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	archive := filepath.Join(root, "backup.tar.gz")
	if err := Backup(source, archive); err != nil {
		t.Fatal(err)
	}
	restored := filepath.Join(root, "restored")
	if err := Restore(archive, restored); err != nil {
		t.Fatal(err)
	}
	for name, want := range files {
		body, err := os.ReadFile(filepath.Join(restored, filepath.FromSlash(name)))
		if err != nil || string(body) != want {
			t.Fatalf("restored %s = %q, %v", name, body, err)
		}
	}
	if err := Restore(archive, restored); err == nil {
		t.Fatal("restore overwrote an existing workspace")
	}
}

func TestBackupRejectsArchiveInsideSource(t *testing.T) {
	source := t.TempDir()
	if err := os.WriteFile(filepath.Join(source, "note.txt"), []byte("ok"), 0o600); err != nil {
		t.Fatal(err)
	}
	archive := filepath.Join(source, "backup.tar.gz")
	if err := Backup(source, archive); err == nil {
		t.Fatal("archive inside source was accepted")
	}
	if _, err := os.Stat(archive); !os.IsNotExist(err) {
		t.Fatal("partial archive was left inside the source")
	}
}

func TestBackupRejectsSymlinkAndSpecialFiles(t *testing.T) {
	source := t.TempDir()
	if err := os.WriteFile(filepath.Join(source, "ok.txt"), []byte("ok"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("ok.txt", filepath.Join(source, "link.txt")); err != nil {
		t.Fatal(err)
	}
	if err := Backup(source, filepath.Join(t.TempDir(), "backup.tar.gz")); err == nil {
		t.Fatal("symlink was archived")
	}

	fifoDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(fifoDir, "ok.txt"), []byte("ok"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(filepath.Join(fifoDir, "pipe"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := Backup(fifoDir, filepath.Join(t.TempDir(), "backup.tar.gz")); err == nil {
		t.Fatal("special file was archived")
	}
}

func TestRestoreRejectsPathTraversalAndSymlinkHeaders(t *testing.T) {
	root := t.TempDir()
	escape := filepath.Join(root, "escape.txt")
	target := filepath.Join(root, "restored")
	archive := filepath.Join(root, "escape.tar.gz")
	if err := writeTestArchive(archive, tar.Header{Name: "../escape.txt", Mode: 0o600, Typeflag: tar.TypeReg, Size: 4}, []byte("lost")); err != nil {
		t.Fatal(err)
	}
	if err := Restore(archive, target); err == nil {
		t.Fatal("path traversal archive was restored")
	}
	if _, err := os.Stat(escape); !os.IsNotExist(err) {
		t.Fatal("path traversal wrote outside the target")
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatal("failed restore published a target")
	}

	symlinkArchive := filepath.Join(root, "symlink.tar.gz")
	if err := writeTestArchive(symlinkArchive, tar.Header{Name: "link", Mode: 0o777, Typeflag: tar.TypeSymlink, Linkname: "ok.txt"}, nil); err != nil {
		t.Fatal(err)
	}
	if err := Restore(symlinkArchive, filepath.Join(root, "from-link")); err == nil {
		t.Fatal("symlink header was restored")
	}
}

func TestRestoreRejectsTruncatedGzipAndKeepsTargetAbsent(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "workspace")
	if err := os.MkdirAll(source, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "note.txt"), []byte("ok"), 0o600); err != nil {
		t.Fatal(err)
	}
	archive := filepath.Join(root, "backup.tar.gz")
	if err := Backup(source, archive); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(archive)
	if err != nil || len(body) < 16 {
		t.Fatalf("archive = %d, %v", len(body), err)
	}
	if err := os.WriteFile(archive, body[:len(body)-8], 0o600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "restored")
	if err := Restore(archive, target); err == nil {
		t.Fatal("truncated gzip was restored")
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatal("truncated restore published a target")
	}
}

func TestRestoreDoesNotOverwriteTargetInPublishRace(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "workspace")
	if err := os.MkdirAll(source, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "note.txt"), []byte("from-archive"), 0o600); err != nil {
		t.Fatal(err)
	}
	archive := filepath.Join(root, "backup.tar.gz")
	if err := Backup(source, archive); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "restored")
	t.Cleanup(func() { restoreBeforePublish = func(string) error { return nil } })
	restoreBeforePublish = func(path string) error {
		if err := os.Mkdir(path, 0o700); err != nil {
			return err
		}
		return os.WriteFile(filepath.Join(path, "kept.txt"), []byte("preexisting"), 0o600)
	}
	if err := Restore(archive, target); err == nil {
		t.Fatal("restore overwrote a raced target")
	}
	kept, err := os.ReadFile(filepath.Join(target, "kept.txt"))
	if err != nil || string(kept) != "preexisting" {
		t.Fatalf("raced target was modified: %q, %v", kept, err)
	}
	if _, err := os.Stat(filepath.Join(target, "note.txt")); !os.IsNotExist(err) {
		t.Fatal("archive contents were merged into the raced target")
	}
}

func writeTestArchive(path string, header tar.Header, body []byte) error {
	file, err := os.Create(path)
	if err != nil {
		return err
	}
	gzipWriter := gzip.NewWriter(file)
	tarWriter := tar.NewWriter(gzipWriter)
	if header.Typeflag == tar.TypeReg {
		header.Size = int64(len(body))
	}
	if err := tarWriter.WriteHeader(&header); err != nil {
		_ = file.Close()
		return err
	}
	if len(body) > 0 {
		if _, err := tarWriter.Write(body); err != nil {
			_ = file.Close()
			return err
		}
	}
	if err := tarWriter.Close(); err != nil {
		_ = file.Close()
		return err
	}
	if err := gzipWriter.Close(); err != nil {
		_ = file.Close()
		return err
	}
	return file.Close()
}
