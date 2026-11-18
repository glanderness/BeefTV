//go:build windows

package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/windows"
	"infinite-canvas/backend/internal/desktopstorage"
)

func TestWindowsOpenDesktopMigratesWithBusyScratch(t *testing.T) {
	for _, scratch := range []bool{true, false} {
		name := "durable"
		if scratch {
			name = "scratch"
		}
		t.Run(name, func(t *testing.T) {
			root := filepath.Join(t.TempDir(), "profile")
			target := filepath.Join(t.TempDir(), "selected")
			app := newDesktopApp(root)
			app.storageRoot = root
			if err := app.start(context.Background()); err != nil {
				t.Fatal(err)
			}
			defer app.stop(context.Background())
			rel := "resources/original.tmp"
			if scratch {
				rel = "cache/tmp/busy.tmp"
			}
			path := filepath.Join(root, rel)
			if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte("keep"), 0600); err != nil {
				t.Fatal(err)
			}
			wide, err := windows.UTF16PtrFromString(path)
			if err != nil {
				t.Fatal(err)
			}
			handle, err := windows.CreateFile(wide, windows.GENERIC_READ, 0, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
			if err != nil {
				t.Fatal(err)
			}
			defer windows.CloseHandle(handle)
			_, err = app.MigrateStorage(target)
			if scratch {
				if err != nil {
					t.Fatal("open desktop could not migrate with busy scratch", err)
				}
				selected, err := desktopstorage.Resolve(root)
				if err != nil || selected != app.dataDir || selected == root {
					t.Fatal("new workspace not selected", err)
				}
			} else {
				if err == nil {
					t.Fatal("migrated locked durable data")
				}
				if app.dataDir != root {
					t.Fatal("switched away from original directory")
				}
			}
			if app.runtime() == nil || !app.runtime().Ready() {
				t.Fatal("desktop workspace not available after migration attempt")
			}
		})
	}
}

func TestWindowsSaveMigrationRetriesTransientLocationLock(t *testing.T) {
	root := filepath.Join(t.TempDir(), "profile")
	first := filepath.Join(t.TempDir(), "first")
	second := filepath.Join(t.TempDir(), "second")
	for _, dir := range []string{root, first, second} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := desktopstorage.SaveMigration(root, first, root, map[string]string{"db": "1"}); err != nil {
		t.Fatal(err)
	}
	pointerPath := filepath.Join(root, "storage-location.json")
	wide, err := windows.UTF16PtrFromString(pointerPath)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := windows.CreateFile(wide, windows.GENERIC_READ, 0, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		time.Sleep(60 * time.Millisecond)
		_ = windows.CloseHandle(handle)
	}()
	if err := desktopstorage.SaveMigration(root, second, first, map[string]string{"db": "2"}); err != nil {
		t.Fatalf("SaveMigration did not recover from transient lock: %v", err)
	}
	got, err := desktopstorage.Resolve(root)
	if err != nil || got != second {
		t.Fatalf("Resolve(root) = %q, err=%v", got, err)
	}
}
