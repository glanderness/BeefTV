package desktopupdate

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// CleanupAfterStartup is called only after the desktop backend has started and
// the rendered workspace has hydrated its assets and canvases. Merely spawning
// a replacement process must never discard its recovery copy.
func (e *Engine) CleanupAfterStartup(ctx context.Context) error {
	target, err := e.locate()
	if err != nil {
		return err
	}
	for {
		err = cleanupCompletedUpdates(target, e.dataDir)
		if err == nil {
			return nil
		}
		// The launching helper can still hold the install lock or, on Windows,
		// its executable. Leave retryable records intact until it exits.
		select {
		case <-ctx.Done():
			return fmt.Errorf("清理升级文件失败: %w", err)
		case <-time.After(250 * time.Millisecond):
		}
	}
}

func cleanupCompletedUpdates(target Target, dataDir string) error {
	parent, err := filepath.EvalSymlinks(filepath.Dir(target.Path))
	if err != nil {
		return err
	}
	unlock, err := lockInstall(filepath.Join(parent, ".BeefTV.update.lock"))
	if err != nil {
		return err
	}
	defer unlock()
	entries, err := os.ReadDir(parent)
	if err != nil {
		return err
	}
	if dataDir != "" {
		dataDir, err = physicalPath(dataDir)
		if err != nil {
			return err
		}
	}
	var cleanupErr error
	for _, entry := range entries {
		if !entry.IsDir() || !strings.HasPrefix(entry.Name(), ".beeftv-update-") {
			continue
		}
		dir := filepath.Join(parent, entry.Name())
		if dataDir != "" && (withinRoot(dir, dataDir) || withinRoot(dataDir, dir)) {
			continue
		}
		if !completedUpdateDirectory(dir, target) && !reclaimableFailedUpdateDirectory(dir, target) {
			continue
		}
		if err := removeCompletedUpdate(dir); err != nil {
			cleanupErr = err
		}
	}
	return cleanupErr
}

func isOwnedUpdateRequest(dir string, target Target, req HelperRequest) bool {
	if req.Schema != helperRequestSchema || req.Platform != target.Platform || req.ParentPID <= 0 {
		return false
	}
	installed, err := physicalPath(req.TargetPath)
	current, currentErr := physicalPath(target.Path)
	if err != nil || currentErr != nil || installed != current {
		return false
	}
	// Do not trust persisted paths as deletion targets. Only the updater's
	// exact sibling layout may be cleaned, including records from older builds.
	for name, path := range map[string]string{"payload": req.StagedPath, "backup": req.BackupPath, "prepared": req.PreparedPath, "result.json": req.ResultPath} {
		recordedParent, err := filepath.EvalSymlinks(filepath.Dir(path))
		if err != nil || recordedParent != dir || filepath.Base(path) != name {
			return false
		}
	}
	return true
}

func ownedUpdateRequest(dir string, target Target) (HelperRequest, bool) {
	var req HelperRequest
	if readCleanupRecord(filepath.Join(dir, "request.json"), &req) != nil {
		return HelperRequest{}, false
	}
	if !isOwnedUpdateRequest(dir, target, req) {
		return HelperRequest{}, false
	}
	return req, true
}

func hasRecoveryBackup(path string) bool {
	info, err := os.Lstat(path)
	if err != nil {
		return !os.IsNotExist(err)
	}
	if !info.IsDir() {
		return true
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return true
	}
	return len(entries) > 0
}

func hasValidAbortedMarker(dir string) bool {
	info, err := os.Lstat(filepath.Join(dir, abortedMarkerName))
	return err == nil && info.Mode().IsRegular() && info.Size() <= 64
}

func completedUpdateDirectory(dir string, target Target) bool {
	req, ok := ownedUpdateRequest(dir, target)
	if !ok {
		return false
	}
	var result RecoveryState
	if readCleanupRecord(filepath.Join(dir, "result.json"), &result) != nil {
		return false
	}
	return result.Status == "launched" && result.Phase == "done" && result.Launched && result.ParentExited && !result.Restored && result.Error == "" && result.BackupPath == req.BackupPath
}

func reclaimableFailedUpdateDirectory(dir string, target Target) bool {
	if hasRecoveryBackup(filepath.Join(dir, "backup")) {
		return false
	}
	var req HelperRequest
	if readCleanupRecord(filepath.Join(dir, "request.json"), &req) != nil {
		// Reclaim a directory with a missing or partial request.json only when
		// preparation explicitly marked it aborted and no recovery state exists.
		return hasValidAbortedMarker(dir) && !pathExists(filepath.Join(dir, "result.json"))
	}
	if !isOwnedUpdateRequest(dir, target, req) || hasRecoveryBackup(req.BackupPath) {
		return false
	}
	if hasValidAbortedMarker(dir) {
		return true
	}
	var result RecoveryState
	if readCleanupRecord(filepath.Join(dir, "result.json"), &result) != nil {
		return false
	}
	return result.Status == "failed" || result.Status == "rolled_back"
}

func readCleanupRecord(path string, value any) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() > 64*1024 {
		return fmt.Errorf("升级记录无效")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, value)
}

func isHelperAtomicTempFile(name string) bool {
	return strings.HasPrefix(name, atomicTempPrefix) && strings.HasSuffix(name, atomicTempSuffix) && len(name) > len(atomicTempPrefix)+len(atomicTempSuffix)
}

func removeCompletedUpdate(dir string) error {
	// Remove the helper first: Windows can still be executing it. Keep both
	// records until payload cleanup succeeds so the next startup can retry.
	names := []string{"BeefTV-update-helper", "BeefTV-update-helper.exe", "backup", "payload", "helper.log", "prepared", "result.json", abortedMarkerName, "request.json"}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	var tempFiles []string
	for _, entry := range entries {
		name := entry.Name()
		if !entry.IsDir() && entry.Type().IsRegular() && isHelperAtomicTempFile(name) {
			tempFiles = append(tempFiles, name)
			continue
		}
		known := false
		for _, allowed := range names {
			known = known || name == allowed
		}
		if !known {
			return nil
		}
	}
	for _, name := range tempFiles {
		if err := os.Remove(filepath.Join(dir, name)); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	for _, name := range names {
		if err := os.RemoveAll(filepath.Join(dir, name)); err != nil {
			return err
		}
	}
	return os.Remove(dir)
}
