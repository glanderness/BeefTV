package depthruntime

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"infinite-canvas/backend/internal/desktopstorage"
)

const wheelStageMarker = ".beeftv-wheel-stage-v1"

// The lock stays beside the directory so it does not block Windows rename.
// Lock first, then mark ownership: a concurrent cleaner ignores unmarked stages.
func claimWheelStage(stage string) (*os.File, error) {
	owner, err := desktopstorage.LockFile(stage + ".owner.lock")
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(filepath.Join(stage, wheelStageMarker), []byte(wheelStageMarker), 0600); err != nil {
		owner.Close()
		os.Remove(stage + ".owner.lock")
		return nil, err
	}
	return owner, nil
}

// Called only by a confirmed install, never by metadata preview or offline
// capture. Unknown legacy stages, symlinks and actively locked stages stay put.
func cleanupWheelStages(ctx context.Context, parent string) error {
	entries, err := os.ReadDir(parent)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		if !entry.IsDir() || !strings.HasPrefix(entry.Name(), ".depth-runtime-stage-") {
			continue
		}
		stage := filepath.Join(parent, entry.Name())
		marker, err := os.ReadFile(filepath.Join(stage, wheelStageMarker))
		if err != nil || string(marker) != wheelStageMarker {
			continue
		}
		owner, err := desktopstorage.LockFile(stage + ".owner.lock")
		if err != nil {
			continue
		}
		err = os.RemoveAll(stage)
		owner.Close()
		os.Remove(stage + ".owner.lock")
		if err != nil {
			return fmt.Errorf("清理上次未完成的组件安装失败: %w", err)
		}
	}
	return nil
}
