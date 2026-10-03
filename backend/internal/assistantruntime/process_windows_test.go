//go:build windows

package assistantruntime

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// Run in the actual supervised child, before TestMain's generic fixtures.
func init() {
	if os.Getenv(fixtureEnv) != "windows-no-console" {
		return
	}
	kernel := syscall.NewLazyDLL("kernel32.dll")
	window, _, _ := kernel.NewProc("GetConsoleWindow").Call()
	codePage, _, _ := kernel.NewProc("GetConsoleCP").Call()
	if window != 0 || codePage != 0 {
		fmt.Fprintf(os.Stderr, "child has console: window=%d codepage=%d\n", window, codePage)
		os.Exit(2)
	}
	fmt.Fprintln(os.Stdout, "host-child-stdout")
	fmt.Fprintln(os.Stderr, "host-child-stderr")
	os.Exit(runHTTPFixture())
}

func TestWindowsHostHasNoConsoleAndPreservesPipes(t *testing.T) {
	logPath := filepath.Join(t.TempDir(), "host.log")
	log, err := os.Create(logPath)
	if err != nil {
		t.Fatal(err)
	}
	// Production routes both diagnostic streams to the parent's stderr handle.
	originalStderr := os.Stderr
	os.Stderr = log
	t.Cleanup(func() { os.Stderr = originalStderr; _ = log.Close() })
	host := fixtureHost(t, "windows-no-console")
	if err := host.Launch(fixtureProvider(), "http://127.0.0.1:18090/api", "desktop-shell-token"); err != nil {
		t.Fatalf("console-free child failed readiness: %v", err)
	}
	if health := host.Probe(context.Background()); !health.OK {
		t.Fatalf("child failed instance health proof: %#v", health)
	}
	raw, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, marker := range []string{"host-child-stdout", "host-child-stderr"} {
		if !strings.Contains(string(raw), marker) {
			t.Fatalf("missing diagnostic output %q: %s", marker, raw)
		}
	}
	// EOF must still reach the child even without a console; do not use Kill.
	host.proc.mu.Lock()
	err = host.proc.lifetimeW.Close()
	host.proc.lifetimeW = nil
	host.proc.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if !waitUntil(5*time.Second, func() bool { return !host.Running() }) {
		t.Fatal("child did not exit after lifetime pipe EOF")
	}
	if host.Endpoint() != "" {
		t.Fatal("exited child retained its endpoint")
	}
}
