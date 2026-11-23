//go:build windows

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/localipc"
)

func TestHarnessAttachOnlyDoesNotCreateWorkspaceWindows(t *testing.T) {
	dataDir := filepath.Join(t.TempDir(), "missing-workspace")
	handled, err := handleHarnessCommand([]string{"--harness-runtime", "--harness-attach-only", "--data-dir", dataDir})
	if !handled || err == nil || !strings.Contains(err.Error(), "尚未就绪") {
		t.Fatalf("attach-only did not report the missing desktop runtime: handled=%v err=%v", handled, err)
	}
	if _, err := os.Lstat(dataDir); !os.IsNotExist(err) {
		t.Fatalf("attach-only opened or created a workspace: %v", err)
	}
	if err := validateDesktopArgs([]string{"--harness-attach-only"}); err == nil {
		t.Fatal("attach-only was accepted without the harness entry point")
	}
}

func TestHarnessPrivateControlAttachesWithoutOpeningWorkspaceWindows(t *testing.T) {
	dataDir := filepath.Join(t.TempDir(), "protocol-workspace")
	endpoint, err := harnessPipeEndpoint(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	if !localipc.ValidEndpoint(endpoint) {
		t.Fatalf("harness pipe endpoint is not a valid localipc pipe: %q", endpoint)
	}
	want := harnessRuntimeConfig{DesktopRuntimeConfig: DesktopRuntimeConfig{
		BaseURL: "http://127.0.0.1:12345/api", LaunchToken: "desktop-test-token", UIBootstrapToken: "bootstrap-test-token",
	}, BridgeURL: "http://127.0.0.1:12346", BridgeToken: "bridge-test-token", Owned: true}
	listener, err := listenHarnessControl(dataDir, want)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	got, err := attachDesktopHarness(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	if got.BaseURL != want.BaseURL || got.BridgeToken != want.BridgeToken || got.LaunchToken != want.LaunchToken || got.Owned || !got.Attached {
		t.Fatalf("attach contract changed: %#v", got)
	}
	if _, err := os.Stat(dataDir); !os.IsNotExist(err) {
		t.Fatalf("attach created a workspace directory: %v", err)
	}
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := attachDesktopHarness(dataDir); err == nil {
		t.Fatal("expected attach to fail after pipe listener closed")
	}
}

func TestHarnessAttachTimesOutWhenPipeNeverWrites(t *testing.T) {
	dataDir := filepath.Join(t.TempDir(), "silent-pipe-workspace")
	endpoint, err := harnessPipeEndpoint(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	listener, err := localipc.Listen(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	done := make(chan struct{})
	defer close(done)
	go func() {
		conn, acceptErr := listener.Accept()
		if acceptErr != nil {
			return
		}
		defer conn.Close()
		<-done
	}()

	start := time.Now()
	_, attachErr := attachDesktopHarness(dataDir)
	if attachErr == nil {
		t.Fatal("expected attach to fail when peer never writes harness config")
	}
	elapsed := time.Since(start)
	if elapsed < 1500*time.Millisecond || elapsed > 6*time.Second {
		t.Fatalf("expected attach read deadline (~2s) to fire after owner check passed, took %s (err=%v)", elapsed, attachErr)
	}
}
