package main

import (
	"io"
	"os"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/buildinfo"
)

func TestCLIVersionFlagPrintsBuildVersionOffline(t *testing.T) {
	want := strings.TrimSpace(buildinfo.Current().Version)
	for _, arg := range []string{"--version", "version"} {
		orig := os.Stdout
		r, w, err := os.Pipe()
		if err != nil {
			t.Fatal(err)
		}
		os.Stdout = w
		runErr := run([]string{arg})
		_ = w.Close()
		os.Stdout = orig
		out, readErr := io.ReadAll(r)
		_ = r.Close()
		if readErr != nil {
			t.Fatal(readErr)
		}
		if runErr != nil {
			t.Fatalf("run(%q) failed: %v", arg, runErr)
		}
		if got := strings.TrimSpace(string(out)); got != want {
			t.Fatalf("run(%q) = %q, want %q", arg, got, want)
		}
	}
}
