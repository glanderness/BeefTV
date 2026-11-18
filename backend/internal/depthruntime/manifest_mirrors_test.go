package depthruntime

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestManifestReachesThirdSignedSourceAfterTwoStalls(t *testing.T) {
	signed, public := signedTestManifest(t, Manifest{Version: 2, Runtimes: map[string]Artifact{"windows-amd64/cpu": {URLs: []string{"https://example.test/cpu.zip"}, Size: 2, SHA256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}})
	var stalled, verified atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/github" {
			stalled.Add(1)
			<-r.Context().Done()
			return
		}
		verified.Add(1)
		_, _ = w.Write(signed)
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	manifest, err := fetchManifestSources(ctx, EnsureOptions{Platform: "windows-amd64", ManifestURL: server.URL + "/cos", ManifestMirrors: []string{server.URL + "/r2", server.URL + "/github"}, TrustedPublicKey: public})
	if err != nil || manifest.Version != 2 || stalled.Load() != 2 || verified.Load() != 1 {
		t.Fatalf("third mirror = %+v, %v; hits %d/%d", manifest, err, stalled.Load(), verified.Load())
	}
}

func TestManifestMirrorsKeepWindowsSignatureVerification(t *testing.T) {
	signed, public := signedTestManifest(t, Manifest{Version: 2, Runtimes: map[string]Artifact{"windows-amd64/cpu": {URLs: []string{"https://example.test/cpu.zip"}, Size: 2, SHA256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}})
	for _, primaryBody := range []string{`not json`, `{"version":2}`} {
		var backups atomic.Int32
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/primary" {
				_, _ = w.Write([]byte(primaryBody))
				return
			}
			backups.Add(1)
			_, _ = w.Write(signed)
		}))
		got, err := fetchManifestSources(context.Background(), EnsureOptions{Platform: "windows-amd64", ManifestURL: server.URL + "/primary", ManifestMirrors: []string{server.URL + "/backup"}, TrustedPublicKey: public})
		server.Close()
		if err != nil || got.Version != 2 || backups.Load() != 1 {
			t.Fatalf("signed fallback = %+v, %v; hits %d", got, err, backups.Load())
		}
	}
}

func TestCancelledManifestDoesNotVisitBackup(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	var backups atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/primary" {
			cancel()
			<-r.Context().Done()
			return
		}
		backups.Add(1)
	}))
	defer server.Close()
	defer cancel()
	_, err := fetchManifestSources(ctx, EnsureOptions{ManifestURL: server.URL + "/primary", ManifestMirrors: []string{server.URL + "/backup"}})
	if !errors.Is(err, context.Canceled) || backups.Load() != 0 {
		t.Fatalf("cancelled metadata = %v; backup hits %d", err, backups.Load())
	}
}

func TestLoadArtifactsPrioritizesDomesticMirrorsForOfficialSourcesWithoutRewritingTestHosts(t *testing.T) {
	hash := strings.Repeat("a", 64)
	signed, public := signedTestManifest(t, Manifest{
		Version: 2,
		Runtimes: map[string]Artifact{
			"windows-amd64/cuda": {
				Size: 20, SHA256: hash, Files: 2, ExpandedSize: 40,
				Parts: []ArtifactPart{
					{
						URLs: []string{
							"https://updates.beefapi.com/beeftv/components/depth-runtime-v2/beeftv-depth-runtime-v1-windows-amd64-cuda.zip.part-001",
							"https://github.com/glanderness/BeefTV/releases/download/depth-runtime-v2/beeftv-depth-runtime-v1-windows-amd64-cuda.zip.part-001",
							"https://beeftv-components-1481187348.cos.ap-guangzhou.myqcloud.com/depth-runtime-v2/beeftv-depth-runtime-v1-windows-amd64-cuda.zip.part-001",
						},
						Size: 10, SHA256: hash,
					},
					{
						URLs: []string{"https://example.test/cuda.part-002"},
						Size: 10, SHA256: hash,
					},
				},
			},
		},
		Model: Artifact{
			URLs: []string{
				"https://updates.beefapi.com/beeftv/components/depth-runtime-v2/video_depth_anything_vits.pth",
				"https://huggingface.co/depth-anything/Video-Depth-Anything-Small/resolve/main/video_depth_anything_vits.pth",
				"https://github.com/glanderness/BeefTV/releases/download/v1.5.5/video_depth_anything_vits.pth",
				"https://beeftv-components-1481187348.cos.ap-guangzhou.myqcloud.com/depth-runtime-v2/video_depth_anything_vits.pth",
			},
			Size: 10, SHA256: hash,
		},
	})
	var cnbHits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/cnb-missing" {
			cnbHits.Add(1)
			http.NotFound(w, r)
			return
		}
		if r.URL.Path == "/cnb-verified" {
			cnbHits.Add(1)
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{
				"schema": 1,
				"repository": "beeftv-downloads/desktop",
				"version": "depth-runtime-v2",
				"verification": "anonymous-resume-sha256",
				"assets": [
					{"name": "beeftv-depth-runtime-v1-windows-amd64-cuda.zip.part-001", "size": 10, "sha256": "` + hash + `"},
					{"name": "video_depth_anything_vits.pth", "size": 10, "sha256": "` + hash + `"}
				]
			}`))
			return
		}
		_, _ = w.Write(signed)
	}))
	defer server.Close()

	oldRecordURL := depthCNBRecordURL
	t.Cleanup(func() {
		depthCNBRecordURL = oldRecordURL
		cnbDepthCacheMu.Lock()
		cnbDepthCacheURL = ""
		cnbDepthCacheExpires = time.Time{}
		cnbDepthCacheAssets = nil
		cnbDepthCacheMu.Unlock()
	})

	// 1. Before CNB depth-runtime-v2 sync completes (404 record): COS leads, zero unverified CNB 404 URLs.
	depthCNBRecordURL = server.URL + "/cnb-missing"
	manifestNoCNB, artifactNoCNB, err := loadArtifacts(context.Background(), EnsureOptions{
		Platform:         "windows-amd64",
		Variant:          "cuda",
		ManifestURL:      server.URL + "/manifest.v2.json",
		TrustedPublicKey: public,
	})
	if err != nil {
		t.Fatalf("loadArtifacts (no CNB): %v", err)
	}
	wantPart1NoCNB := []string{
		"https://beeftv-components-1481187348.cos.ap-guangzhou.myqcloud.com/depth-runtime-v2/beeftv-depth-runtime-v1-windows-amd64-cuda.zip.part-001",
		"https://updates.beefapi.com/beeftv/components/depth-runtime-v2/beeftv-depth-runtime-v1-windows-amd64-cuda.zip.part-001",
		"https://github.com/glanderness/BeefTV/releases/download/depth-runtime-v2/beeftv-depth-runtime-v1-windows-amd64-cuda.zip.part-001",
	}
	if !reflect.DeepEqual(artifactNoCNB.Parts[0].URLs, wantPart1NoCNB) {
		t.Fatalf("part[0] URLs without CNB = %#v, want %#v", artifactNoCNB.Parts[0].URLs, wantPart1NoCNB)
	}
	if strings.HasPrefix(manifestNoCNB.Model.URLs[0], "https://cnb.cool/") {
		t.Fatalf("expected unverified CNB URL omitted from model URLs, got %#v", manifestNoCNB.Model.URLs)
	}

	// 2. Once CNB verification record matches size + SHA-256: CNB is promoted to #1 ahead of COS.
	depthCNBRecordURL = server.URL + "/cnb-verified"
	manifest, artifact, err := loadArtifacts(context.Background(), EnsureOptions{
		Platform:         "windows-amd64",
		Variant:          "cuda",
		ManifestURL:      server.URL + "/manifest.v2.json",
		TrustedPublicKey: public,
	})
	if err != nil {
		t.Fatalf("loadArtifacts (verified CNB): %v", err)
	}
	wantPart1 := []string{
		"https://cnb.cool/beeftv-downloads/desktop/-/releases/download/depth-runtime-v2/beeftv-depth-runtime-v1-windows-amd64-cuda.zip.part-001",
		"https://beeftv-components-1481187348.cos.ap-guangzhou.myqcloud.com/depth-runtime-v2/beeftv-depth-runtime-v1-windows-amd64-cuda.zip.part-001",
		"https://updates.beefapi.com/beeftv/components/depth-runtime-v2/beeftv-depth-runtime-v1-windows-amd64-cuda.zip.part-001",
		"https://github.com/glanderness/BeefTV/releases/download/depth-runtime-v2/beeftv-depth-runtime-v1-windows-amd64-cuda.zip.part-001",
	}
	if !reflect.DeepEqual(artifact.Parts[0].URLs, wantPart1) {
		t.Fatalf("part[0] URLs = %#v, want %#v", artifact.Parts[0].URLs, wantPart1)
	}
	if !reflect.DeepEqual(artifact.Parts[1].URLs, []string{"https://example.test/cuda.part-002"}) {
		t.Fatalf("non-official test URL was rewritten: %#v", artifact.Parts[1].URLs)
	}
	wantModel := []string{
		"https://cnb.cool/beeftv-downloads/desktop/-/releases/download/depth-runtime-v2/video_depth_anything_vits.pth",
		"https://beeftv-components-1481187348.cos.ap-guangzhou.myqcloud.com/depth-runtime-v2/video_depth_anything_vits.pth",
		"https://updates.beefapi.com/beeftv/components/depth-runtime-v2/video_depth_anything_vits.pth",
		"https://github.com/glanderness/BeefTV/releases/download/v1.5.5/video_depth_anything_vits.pth",
		"https://huggingface.co/depth-anything/Video-Depth-Anything-Small/resolve/main/video_depth_anything_vits.pth",
	}
	if !reflect.DeepEqual(manifest.Model.URLs, wantModel) {
		t.Fatalf("model URLs = %#v, want %#v", manifest.Model.URLs, wantModel)
	}

	// 3. Repeated loadArtifacts within TTL reuses cached CNB probe without hitting network again.
	beforeCachedCall := cnbHits.Load()
	if _, _, err := loadArtifacts(context.Background(), EnsureOptions{
		Platform:         "windows-amd64",
		Variant:          "cuda",
		ManifestURL:      server.URL + "/manifest.v2.json",
		TrustedPublicKey: public,
	}); err != nil {
		t.Fatalf("loadArtifacts (cached CNB): %v", err)
	}
	if cnbHits.Load() != beforeCachedCall {
		t.Fatalf("expected cached CNB probe (hits=%d), got hits=%d", beforeCachedCall, cnbHits.Load())
	}
}
