package diagnostics

import (
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"infinite-canvas/backend/internal/webviewlock"
)

const maxCrashpadReports = 10

type CrashpadReportMeta struct {
	FileName   string `json:"fileName"`
	SizeBytes  int64  `json:"sizeBytes"`
	ModifiedAt string `json:"modifiedAt"`
}

// CollectCrashpadReportMeta collects filename/size/mtime metadata ONLY for
// crashpad .dmp files found under candidate directories. It never opens or
// reads raw crash dump bytes.
func CollectCrashpadReportMeta(dataDir string) []CrashpadReportMeta {
	cleanDir := strings.TrimSpace(dataDir)
	if cleanDir == "" {
		return nil
	}
	candidateDirs := []string{
		filepath.Join(cleanDir, "EBWebView", "Crashpad", "reports"),
		filepath.Join(cleanDir, "Crashpad", "reports"),
	}
	if runtime.GOOS == "windows" {
		if exePath, err := os.Executable(); err == nil && strings.TrimSpace(exePath) != "" {
			if profileDir := webviewlock.ProfileDirForWorkspace(exePath, cleanDir); profileDir != "" {
				candidateDirs = append(candidateDirs,
					filepath.Join(profileDir, "EBWebView", "Crashpad", "reports"),
					filepath.Join(profileDir, "Crashpad", "reports"),
				)
			}
		}
	}
	// Also scan one level of webview profile directories under dataDir (e.g. webview-*).
	if entries, err := os.ReadDir(cleanDir); err == nil {
		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}
			lower := strings.ToLower(entry.Name())
			if strings.Contains(lower, "webview") {
				candidateDirs = append(candidateDirs,
					filepath.Join(cleanDir, entry.Name(), "EBWebView", "Crashpad", "reports"),
					filepath.Join(cleanDir, entry.Name(), "Crashpad", "reports"),
				)
			}
		}
	}

	type foundReport struct {
		meta    CrashpadReportMeta
		modTime time.Time
	}
	seen := make(map[string]struct{})
	var found []foundReport
	for _, dir := range candidateDirs {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if entry.IsDir() {
				continue
			}
			name := entry.Name()
			if !strings.HasSuffix(strings.ToLower(name), ".dmp") {
				continue
			}
			info, err := entry.Info()
			if err != nil || !info.Mode().IsRegular() {
				continue
			}
			key := name + ":" + info.ModTime().UTC().Format(time.RFC3339)
			if _, dup := seen[key]; dup {
				continue
			}
			seen[key] = struct{}{}
			found = append(found, foundReport{
				meta: CrashpadReportMeta{
					FileName:   name,
					SizeBytes:  info.Size(),
					ModifiedAt: info.ModTime().UTC().Format(time.RFC3339),
				},
				modTime: info.ModTime().UTC(),
			})
		}
	}
	if len(found) == 0 {
		return nil
	}
	sort.Slice(found, func(i, j int) bool {
		return found[i].modTime.After(found[j].modTime)
	})
	if len(found) > maxCrashpadReports {
		found = found[:maxCrashpadReports]
	}
	out := make([]CrashpadReportMeta, len(found))
	for i := range found {
		out[i] = found[i].meta
	}
	return out
}
