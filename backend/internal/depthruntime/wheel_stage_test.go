package depthruntime

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestWheelStageRecoveryPreservesActiveAndUnknownDirectories(t *testing.T) {
	parent := t.TempDir()
	active, _ := os.MkdirTemp(parent, ".depth-runtime-stage-active-")
	owner, err := claimWheelStage(active)
	if err != nil {
		t.Fatal(err)
	}
	defer owner.Close()
	stale, _ := os.MkdirTemp(parent, ".depth-runtime-stage-stale-")
	old, err := claimWheelStage(stale)
	if err != nil {
		t.Fatal(err)
	}
	old.Close() // OS releases this same lock when the host crashes.
	unknown, _ := os.MkdirTemp(parent, ".depth-runtime-stage-unknown-")
	_ = os.WriteFile(filepath.Join(unknown, "keep"), []byte("unowned"), 0600)
	if err := cleanupWheelStages(context.Background(), parent); err != nil {
		t.Fatal(err)
	}
	if !pathExists(active) || !pathExists(unknown) || pathExists(stale) {
		t.Fatalf("unsafe stage cleanup: active=%v unknown=%v stale=%v", pathExists(active), pathExists(unknown), pathExists(stale))
	}
	owner.Close()
	if err := cleanupWheelStages(context.Background(), parent); err != nil || pathExists(active) {
		t.Fatalf("released owned stage retained: %v", err)
	}
	if !pathExists(filepath.Join(unknown, "keep")) {
		t.Fatal("unknown stage was deleted")
	}
}
