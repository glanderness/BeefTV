package main

import (
	"archive/zip"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestPackageLinuxBundleAndExecutableModes(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Linux archives require Unix executable modes")
	}
	bundle := filepath.Join(t.TempDir(), linuxBundleName)
	for _, name := range []string{"BeefTV", "cli/beeftv", "plugin-packages/core.beeftv-plugin"} {
		file := filepath.Join(bundle, name)
		if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte("fixture"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	writeFakeAgentHost(t, filepath.Join(bundle, "agent-host"), "runtime/bin/node")
	out := filepath.Join(t.TempDir(), "BeefTV-v1.7.15-linux-amd64.zip")
	if err := packageBundle(platformLinuxAMD64, bundle, out); err != nil {
		t.Fatal(err)
	}
	reader, err := zip.OpenReader(out)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	for _, name := range []string{"BeefTV-linux/BeefTV", "BeefTV-linux/cli/beeftv", "BeefTV-linux/agent-host/runtime/bin/node"} {
		found := false
		for _, entry := range reader.File {
			if entry.Name == name {
				found = entry.Mode()&0o111 != 0
			}
		}
		if !found {
			t.Fatalf("missing executable %s", name)
		}
	}
	if err := os.Chmod(filepath.Join(bundle, "cli/beeftv"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := packageBundle(platformLinuxAMD64, bundle, out); err == nil {
		t.Fatal("accepted non-executable Linux CLI")
	}
}
