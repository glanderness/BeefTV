package bootstrap

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
)

// TestSlowAssistantHelperProcess is invoked as a subprocess by
// TestRuntimeStartDoesNotBlockOnSlowAssistantHost to simulate an assistant host
// that stalls during startup without ever answering health checks.
func TestSlowAssistantHelperProcess(t *testing.T) {
	if os.Getenv("BEEFTV_AGENT_INSTANCE_NONCE") == "" {
		return
	}
	_, _ = io.Copy(io.Discard, os.Stdin)
	time.Sleep(30 * time.Second)
}

// TestStartupBootstrapNotBlockedByHeavyWorkspaceCleanup verifies both that:
//  1. Opening and starting a heavy desktop workspace keeps /workspace/bootstrap
//     fast immediately after Start() without waiting for detached resource GC.
//  2. Explicitly running detached resource GC concurrently against 40MB of
//     canvases, 200 referenced + 200 detached resources, 2,000 tasks/results,
//     and 20,000 task logs completes quickly and does not stall
//     /workspace/bootstrap or ordinary SQLite reads.
func TestStartupBootstrapNotBlockedByHeavyWorkspaceCleanup(t *testing.T) {
	dataDir := t.TempDir()

	seedRt, err := Open(context.Background(), Config{
		Profile:         ProfileDesktop,
		DataDir:         dataDir,
		ListenAddr:      "127.0.0.1:0",
		AutoMigrate:     true,
		ShutdownTimeout: 5 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	owner, err := seedRt.service.LocalWorkspaceOwner()
	if err != nil {
		t.Fatal(err)
	}
	oldTime := time.Now().Add(-48 * time.Hour)

	resources := make([]model.Resource, 0, 400)
	for i := 0; i < 200; i++ {
		resources = append(resources, model.Resource{
			ID:        fmt.Sprintf("res-ref-%04d", i),
			UserID:    owner.ID,
			Kind:      "image",
			Status:    model.ResourceStatusReady,
			Provider:  "local",
			ObjectKey: fmt.Sprintf("users/%s/image/ref-%04d.png", owner.ID, i),
			CreatedAt: oldTime,
			UpdatedAt: oldTime,
		})
	}
	for i := 0; i < 200; i++ {
		resources = append(resources, model.Resource{
			ID:        fmt.Sprintf("res-orphan-%04d", i),
			UserID:    owner.ID,
			Kind:      "image",
			Status:    model.ResourceStatusReady,
			Provider:  "local",
			ObjectKey: fmt.Sprintf("users/%s/image/orphan-%04d.png", owner.ID, i),
			CreatedAt: oldTime,
			UpdatedAt: oldTime,
		})
	}
	if err := seedRt.db.CreateInBatches(&resources, 100).Error; err != nil {
		t.Fatal(err)
	}

	var nodeParts []string
	for i := 0; i < 200; i++ {
		nodeParts = append(nodeParts, fmt.Sprintf(`{"id":"node-%04d","type":"image","metadata":{"storageKey":"resource:res-ref-%04d","prompt":"%s"}}`, i, i, strings.Repeat("seedance cinematic shot description ", 260)))
	}
	canvasJSON := `{"nodes":[` + strings.Join(nodeParts, ",") + `],"connections":[]}`
	canvases := make([]model.CanvasProject, 0, 20)
	for i := 0; i < 20; i++ {
		canvases = append(canvases, model.CanvasProject{
			ID:          fmt.Sprintf("canvas-%03d", i),
			UserID:      owner.ID,
			Title:       fmt.Sprintf("Heavy Canvas %d", i),
			PayloadJSON: canvasJSON,
			CreatedAt:   oldTime,
			UpdatedAt:   oldTime,
		})
	}
	if err := seedRt.db.CreateInBatches(&canvases, 10).Error; err != nil {
		t.Fatal(err)
	}

	taskInput := `{"prompt":"` + strings.Repeat("generate cinematic video shot ", 80) + `","referenceUrls":["/api/resources/res-ref-0001/file"],"params":{"aspectRatio":"16:9","duration":5,"resolution":"720p"}}`
	taskResult := `{"videos":[{"resourceId":"res-ref-0002","url":"/api/resources/res-ref-0002/file","meta":{"note":"` + strings.Repeat("ok ", 150) + `"}}]}`
	tasks := make([]model.Task, 0, 2000)
	results := make([]model.Result, 0, 2000)
	for i := 0; i < 2000; i++ {
		taskID := fmt.Sprintf("task-%05d", i)
		tasks = append(tasks, model.Task{
			ID:         taskID,
			UserID:     owner.ID,
			Type:       "canvas_video",
			Status:     model.TaskStatusSucceeded,
			Prompt:     "test",
			InputJSON:  taskInput,
			ResultJSON: taskResult,
			CreatedAt:  oldTime,
			UpdatedAt:  oldTime,
		})
		results = append(results, model.Result{
			ID:        fmt.Sprintf("result-%05d", i),
			UserID:    owner.ID,
			TaskID:    taskID,
			Kind:      "video",
			URL:       "/api/resources/res-ref-0002/file",
			Payload:   taskResult,
			CreatedAt: oldTime,
		})
	}
	if err := seedRt.db.CreateInBatches(&tasks, 200).Error; err != nil {
		t.Fatal(err)
	}
	if err := seedRt.db.CreateInBatches(&results, 200).Error; err != nil {
		t.Fatal(err)
	}

	logPayload := `{"stage":"polling","status":"running","upstream":{"progress":50,"detail":"` + strings.Repeat("polling payload metadata ", 60) + `"}}`
	logs := make([]model.TaskLog, 0, 20000)
	for i := 0; i < 20000; i++ {
		logs = append(logs, model.TaskLog{
			ID:        fmt.Sprintf("log-%06d", i),
			UserID:    owner.ID,
			TaskID:    fmt.Sprintf("task-%05d", i%2000),
			Level:     "info",
			Message:   "poll",
			Payload:   logPayload,
			CreatedAt: oldTime,
		})
	}
	if err := seedRt.db.CreateInBatches(&logs, 500).Error; err != nil {
		t.Fatal(err)
	}

	if err := seedRt.Close(context.Background()); err != nil {
		t.Fatal(err)
	}

	rt, err := Open(context.Background(), Config{
		Profile:         ProfileDesktop,
		DataDir:         dataDir,
		ListenAddr:      "127.0.0.1:0",
		AutoMigrate:     true,
		ShutdownTimeout: 10 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_ = rt.Close(ctx)
	}()

	if err := rt.Start(); err != nil {
		t.Fatal(err)
	}

	client := &http.Client{Timeout: 4 * time.Second}
	probe := func(path string) (time.Duration, error) {
		req, _ := http.NewRequest(http.MethodGet, rt.BaseURL()+path, nil)
		req.Header.Set("X-Desktop-Token", rt.LaunchToken())
		start := time.Now()
		resp, err := client.Do(req)
		dur := time.Since(start)
		if err != nil {
			return dur, fmt.Errorf("GET %s failed after %v: %w", path, dur, err)
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return dur, fmt.Errorf("GET %s status = %d", path, resp.StatusCode)
		}
		return dur, nil
	}

	// Phase 1: Startup window must not stall bootstrap and must defer detached GC.
	var maxStartupBoot time.Duration
	for i := 0; i < 10; i++ {
		d, err := probe("/workspace/bootstrap")
		if err != nil {
			t.Fatal(err)
		}
		if d > maxStartupBoot {
			maxStartupBoot = d
		}
		time.Sleep(15 * time.Millisecond)
	}
	if maxStartupBoot > 500*time.Millisecond {
		t.Fatalf("startup /workspace/bootstrap max latency = %v, want <= 500ms", maxStartupBoot)
	}
	var countBeforeGC int64
	if err := rt.db.Model(&model.Resource{}).Count(&countBeforeGC).Error; err != nil {
		t.Fatal(err)
	}
	if countBeforeGC != 400 {
		t.Fatalf("resource count right after Start() = %d, want 400 (detached GC must be deferred past startup)", countBeforeGC)
	}

	// Phase 2a: While detached GC runs concurrently with continuous canvas writes
	// and reads, stale-watermark exits keep BEGIN IMMEDIATE and storageMu free so
	// neither reads nor writes stall, and GC itself exits boundedly.
	runConcurrentGC := func(withWrites bool) (gcDur, maxBoot, maxList, maxWrite time.Duration, boots, lists, writes int64) {
		gcStarted := make(chan struct{})
		gcDone := make(chan time.Duration, 1)
		go func() {
			close(gcStarted)
			gcStart := time.Now()
			rt.service.ResourceService().CleanupDetachedResources()
			gcDone <- time.Since(gcStart)
		}()
		<-gcStarted

		var (
			bootProbes   atomic.Int64
			listProbes   atomic.Int64
			writeProbes  atomic.Int64
			maxBootNs    atomic.Int64
			maxListNs    atomic.Int64
			maxWriteNs   atomic.Int64
			stopProbing  atomic.Bool
			probeErrMu   sync.Mutex
			firstProbeEr error
		)
		recordMax := func(target *atomic.Int64, d time.Duration) {
			ns := d.Nanoseconds()
			for {
				cur := target.Load()
				if ns <= cur || target.CompareAndSwap(cur, ns) {
					return
				}
			}
		}
		recordErr := func(err error) {
			probeErrMu.Lock()
			if firstProbeEr == nil {
				firstProbeEr = err
			}
			probeErrMu.Unlock()
		}
		probeWrite := func(idx int64) (time.Duration, error) {
			id := fmt.Sprintf("probe-canvas-%d", idx)
			body := fmt.Sprintf(`{"project":{"id":"%s","title":"probe","revision":0,"nodes":[],"connections":[]}}`, id)
			req, _ := http.NewRequest(http.MethodPut, rt.BaseURL()+"/canvas-projects/"+id, strings.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-Desktop-Token", rt.LaunchToken())
			start := time.Now()
			resp, err := client.Do(req)
			dur := time.Since(start)
			if err != nil {
				return dur, fmt.Errorf("PUT /canvas-projects/%s failed after %v: %w", id, dur, err)
			}
			respBody, _ := io.ReadAll(resp.Body)
			_ = resp.Body.Close()
			if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
				return dur, fmt.Errorf("PUT /canvas-projects/%s status = %d body=%s", id, resp.StatusCode, string(respBody))
			}
			return dur, nil
		}

		var wg sync.WaitGroup
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				d, err := probe("/workspace/bootstrap")
				if err != nil {
					recordErr(err)
					return
				}
				bootProbes.Add(1)
				recordMax(&maxBootNs, d)
				d, err = probe("/canvas-projects?page=1&pageSize=1")
				if err != nil {
					recordErr(err)
					return
				}
				listProbes.Add(1)
				recordMax(&maxListNs, d)
				if stopProbing.Load() {
					return
				}
				time.Sleep(10 * time.Millisecond)
			}
		}()
		if withWrites {
			wg.Add(1)
			go func() {
				defer wg.Done()
				var idx int64
				for {
					idx++
					d, err := probeWrite(idx)
					if err != nil {
						recordErr(err)
						return
					}
					writeProbes.Add(1)
					recordMax(&maxWriteNs, d)
					if stopProbing.Load() {
						return
					}
					time.Sleep(25 * time.Millisecond)
				}
			}()
		}

		gcDur = <-gcDone
		stopProbing.Store(true)
		wg.Wait()
		if firstProbeEr != nil {
			t.Fatal(firstProbeEr)
		}
		return gcDur, time.Duration(maxBootNs.Load()), time.Duration(maxListNs.Load()), time.Duration(maxWriteNs.Load()), bootProbes.Load(), listProbes.Load(), writeProbes.Load()
	}

	busyGCDur, busyBoot, busyList, busyWrite, busyBoots, busyLists, busyWrites := runConcurrentGC(true)
	if busyBoots == 0 || busyLists == 0 || busyWrites == 0 {
		t.Fatalf("busy-workspace concurrent probes did not execute: boot=%d list=%d write=%d", busyBoots, busyLists, busyWrites)
	}
	if busyGCDur > 5*time.Second {
		t.Fatalf("busy-workspace detached GC exceeded bound: %v > 5s", busyGCDur)
	}
	if busyBoot > 500*time.Millisecond {
		t.Fatalf("/workspace/bootstrap stalled during busy GC: max=%v", busyBoot)
	}
	if busyList > 1500*time.Millisecond {
		t.Fatalf("/canvas-projects read stalled during busy GC: max=%v (gcDur=%v)", busyList, busyGCDur)
	}
	if busyWrite > 1500*time.Millisecond {
		t.Fatalf("PUT /canvas-projects (storageMu write) stalled during busy GC: max=%v (gcDur=%v)", busyWrite, busyGCDur)
	}

	// Phase 2b: Once writes settle, detached GC completes via watermark fast-path
	// while concurrent reads continue, removing all 200 orphans and preserving all
	// 200 referenced resources within strict latency and duration bounds.
	quietGCDur, quietBoot, quietList, _, quietBoots, quietLists, _ := runConcurrentGC(false)
	if quietBoots == 0 || quietLists == 0 {
		t.Fatalf("quiet-write concurrent probes did not execute: boot=%d list=%d", quietBoots, quietLists)
	}
	if quietGCDur > 5*time.Second {
		t.Fatalf("quiet-write detached GC exceeded bound: %v > 5s", quietGCDur)
	}
	if quietBoot > 500*time.Millisecond {
		t.Fatalf("/workspace/bootstrap stalled during quiet-write GC: max=%v", quietBoot)
	}
	if quietList > 1500*time.Millisecond {
		t.Fatalf("/canvas-projects read stalled during quiet-write GC: max=%v (gcDur=%v)", quietList, quietGCDur)
	}

	var remainingCount int64
	if err := rt.db.Model(&model.Resource{}).Count(&remainingCount).Error; err != nil {
		t.Fatal(err)
	}
	if remainingCount != 200 {
		t.Fatalf("remaining resource count after GC = %d, want 200 referenced resources preserved", remainingCount)
	}
	t.Logf("heavy workspace metrics: startupBoot=%v busy(gc=%v boot=%v list=%v write=%v probes=%d/%d/%d) quiet(gc=%v boot=%v list=%v probes=%d/%d)",
		maxStartupBoot, busyGCDur, busyBoot, busyList, busyWrite, busyBoots, busyLists, busyWrites, quietGCDur, quietBoot, quietList, quietBoots, quietLists)
}

// TestRuntimeStartDoesNotBlockOnSlowAssistantHost verifies that an unready or
// slow-starting built-in assistant host never delays desktop Runtime.Start()
// up to the 20s readiness timeout, reports host_starting on /assistant/status,
// and aborts promptly when Runtime.Close() is called.
func TestRuntimeStartDoesNotBlockOnSlowAssistantHost(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dataDir := t.TempDir()
	writeJSON := func(name string, value any) {
		t.Helper()
		raw, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dataDir, name), raw, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	writeJSON("agent_config.json", map[string]any{
		"model":       "fixture-model",
		"hostCommand": exe,
		"hostArgs":    []string{"-test.run=^TestSlowAssistantHelperProcess$"},
	})
	writeJSON("local-model-config.json", map[string]any{
		"schemaVersion": 1,
		"revision":      1,
		"config": map[string]any{
			"textModel": "fixture::fixture-model",
			"channels": []any{
				map[string]any{
					"id":      "fixture",
					"enabled": true,
					"apiKey":  "fixture-key",
					"baseUrl": "https://example.invalid/v1",
					"modelProfiles": []any{
						map[string]any{"model": "fixture-model", "capability": "text", "protocol": "chat-completion"},
					},
				},
			},
		},
	})

	rt, err := Open(context.Background(), Config{
		Profile:         ProfileDesktop,
		DataDir:         dataDir,
		ListenAddr:      "127.0.0.1:0",
		LaunchToken:     "slow-assistant-token",
		AutoMigrate:     true,
		ShutdownTimeout: 5 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}

	startBegin := time.Now()
	if err := rt.Start(); err != nil {
		t.Fatal(err)
	}
	startElapsed := time.Since(startBegin)
	if startElapsed > 2*time.Second {
		t.Fatalf("Runtime.Start() blocked for %v waiting on slow assistant host", startElapsed)
	}

	// Wait briefly for the async goroutine to enter startOwned.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		state := rt.assistantHost.State()
		if state.Starting || state.Running {
			break
		}
		time.Sleep(15 * time.Millisecond)
	}

	client := &http.Client{Timeout: 2 * time.Second}
	req, _ := http.NewRequest(http.MethodGet, rt.BaseURL()+"/assistant/status", nil)
	req.Header.Set("X-Desktop-Token", rt.LaunchToken())
	statusStart := time.Now()
	resp, err := client.Do(req)
	statusElapsed := time.Since(statusStart)
	if err != nil {
		t.Fatalf("GET /assistant/status failed: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !strings.Contains(string(body), `"reason":"host_starting"`) {
		t.Fatalf("GET /assistant/status = %d %s, want 200 host_starting", resp.StatusCode, string(body))
	}
	if statusElapsed > 1500*time.Millisecond {
		t.Fatalf("GET /assistant/status took %v while host starting", statusElapsed)
	}

	// Host.Stop() must also cancel an in-flight slow StartContext promptly
	// rather than waiting up to the 20s readiness timeout.
	stopStart := time.Now()
	if err := rt.assistantHost.Stop(); err != nil {
		t.Fatalf("assistantHost.Stop failed: %v", err)
	}
	stopElapsed := time.Since(stopStart)
	if stopElapsed > 3*time.Second {
		t.Fatalf("assistantHost.Stop blocked for %v while canceling slow startup", stopElapsed)
	}
	if rt.assistantHost.Running() {
		t.Fatal("assistant host still running after Stop")
	}

	closeStart := time.Now()
	closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := rt.Close(closeCtx); err != nil {
		t.Fatalf("Runtime.Close failed: %v", err)
	}
	closeElapsed := time.Since(closeStart)
	if closeElapsed > 3*time.Second {
		t.Fatalf("Runtime.Close blocked for %v while canceling slow assistant startup", closeElapsed)
	}
	if rt.assistantHost.Running() {
		t.Fatal("assistant host still running after Runtime.Close")
	}
	t.Logf("slow assistant timings: start=%v status=%v stop=%v close=%v", startElapsed, statusElapsed, stopElapsed, closeElapsed)
}
